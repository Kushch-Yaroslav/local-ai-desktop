import { AsyncLocalStorage } from 'node:async_hooks';
import { textFit } from './verification';
import type { LadSourceRevision, LadVerification, LadVisualEvidence } from '../shared/types';
import { createHash } from 'node:crypto';
import type { Page, Response, Route } from 'playwright-core';
import type { BrowserManager } from './browser';
import { groundRegion, projectRegion, paintRegions } from './grounding';
import { LadStore } from './store';
import { newId, nowIso } from './util';
import type {
  LadArea,
  LadRect,
  LadRegion,
  LadRegionStatus,
  LadWorkspaceSettings,
} from '../shared/types';
import {
  LAD_DEFAULT_WORKSPACE,
  LAD_REGION_STATUSES,
  ladAreaColor,
  ladValidateWorkspace,
} from '../shared/types';
import type { LadConversationState } from './store';
import { promptUrl } from './util';

export type LadEventEmitter = {
  emit: (event: {
    type: 'state' | 'region' | 'area' | 'select-region';
    conversationId: string;
    region?: LadRegion;
    area?: LadArea;
    removedRegionId?: string;
    removedAreaId?: string;
    regionId?: string;
  }) => void;
};

/**
 * Region / area operations over the per-conversation store.
 * All mutations go through save() so the runtime is the single writer.
 */
export class RegionService {
  private transactions = new AsyncLocalStorage<Set<string>>();
  private queues = new Map<string, Promise<unknown>>();
  private displayState = new Map<
    string,
    {
      visible: boolean;
      selectedAreaId?: string;
      hoveredAreaId?: string;
      staleLabel?: string;
      areaPrefix?: string;
    }
  >();
  private highlightBindings = new WeakMap<Page, { conversationId: string; ready: Promise<void> }>();
  private paintQueues = new Map<string, Promise<void>>();
  private paintRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private paintRetryAttempts = new Map<string, number>();
  private atomic<T>(id: string, work: () => Promise<T>): Promise<T> {
    if (this.transactions.getStore()?.has(id)) return work();
    const previous = this.queues.get(id) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(() =>
        this.transactions.run(new Set([...(this.transactions.getStore() ?? []), id]), work)
      );
    this.queues.set(id, next);
    void next
      .finally(() => {
        if (this.queues.get(id) === next) this.queues.delete(id);
      })
      .catch(() => undefined);
    return next;
  }
  private selectionBindings = new WeakMap<Page, { conversationId: string; areaName?: string }>();
  constructor(
    private readonly manager: BrowserManager,
    private readonly store: LadStore,
    private readonly events: LadEventEmitter
  ) {
    // Async filesystem and source snapshots must not overwrite a concurrent rename/selection.
    // Nested operations (detect -> createRegion) share the same transaction.
    const names = [
      'list',
      'createRegion',
      'createArea',
      'updateArea',
      'attachRegionToArea',
      'removeRegion',
      'removeArea',
      'removeAllAreas',
      'setWorkspace',
      'liveProjection',
      'replaceRegion',
      'workflow',
      'recheck',
      'recordCheck',
      'detect',
    ] as const;
    for (const name of names) {
      const operation = this[name].bind(this) as (
        id: string,
        ...args: unknown[]
      ) => Promise<unknown>;
      Object.defineProperty(this, name, {
        value: (id: string, ...args: unknown[]) => this.atomic(id, () => operation(id, ...args)),
      });
    }
    const adopt = this.adopt.bind(this);
    this.adopt = (from, to) => {
      const [first, second] = [from, to].sort();
      return this.atomic(first, () => this.atomic(second, () => adopt(from, to)));
    };
    this.manager.on('lad', (event) => {
      if (event.type === 'meta' || event.type === 'session')
        this.schedulePaint(event.conversationId);
    });
  }

  private async stateOf(conversationId: string): Promise<LadConversationState> {
    return this.store.load(conversationId);
  }

  private save(conversationId: string, state: LadConversationState): Promise<void> {
    return this.store.save(conversationId, state).then(() => {
      this.schedulePaint(conversationId, state);
    });
  }

  private schedulePaint(conversationId: string, state?: LadConversationState): void {
    const previous = this.paintQueues.get(conversationId) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(() => this.paintConversation(conversationId, state));
    this.paintQueues.set(conversationId, next);
    void next
      .finally(() => {
        if (this.paintQueues.get(conversationId) === next) this.paintQueues.delete(conversationId);
      })
      .catch((error) => {
        if (this.isTransientPageTransition(error)) this.retryPaint(conversationId);
      })
      .catch(() => undefined);
  }

  private isTransientPageTransition(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return /execution context was destroyed|frame was detached|target closed|target crashed|navigation.*interrupted/i.test(
      message
    );
  }

  private retryPaint(conversationId: string): void {
    if (this.paintRetryTimers.has(conversationId)) return;
    const attempt = this.paintRetryAttempts.get(conversationId) ?? 0;
    if (attempt >= 8) {
      this.paintRetryAttempts.delete(conversationId);
      return;
    }
    const timer = setTimeout(
      () => {
        this.paintRetryTimers.delete(conversationId);
        this.paintRetryAttempts.set(conversationId, attempt + 1);
        void this.stateOf(conversationId)
          .then((state) => this.paintConversation(conversationId, state))
          .then(() => this.paintRetryAttempts.delete(conversationId))
          .catch((error) => {
            if (this.isTransientPageTransition(error)) this.retryPaint(conversationId);
            else this.paintRetryAttempts.delete(conversationId);
          });
      },
      Math.min(150 * (attempt + 1), 1000)
    );
    timer.unref?.();
    this.paintRetryTimers.set(conversationId, timer);
  }

  private async bindRegionSelection(page: Page, conversationId: string): Promise<void> {
    let binding = this.highlightBindings.get(page);
    if (binding) {
      binding.conversationId = conversationId;
      try {
        await binding.ready;
      } catch (error) {
        if (this.highlightBindings.get(page) === binding) this.highlightBindings.delete(page);
        throw error;
      }
      return;
    }
    binding = { conversationId, ready: Promise.resolve() };
    const target = binding;
    this.highlightBindings.set(page, binding);
    binding.ready = (async () => {
      await page.evaluate(() => {
        const target = window as unknown as {
          __ladSelectRegion?: unknown;
          __ladReportFindings?: unknown;
        };
        delete target.__ladSelectRegion;
        delete target.__ladReportFindings;
      });
      await page.exposeFunction('__ladSelectRegion', async (value: unknown) => {
        const regionId = typeof value === 'string' ? value : '';
        const currentConversation = target.conversationId;
        if (!regionId || this.manager.pageOf(currentConversation) !== page) return;
        const state = await this.stateOf(currentConversation).catch(() => null);
        if (!state?.regions.some((region) => region.id === regionId)) return;
        this.events.emit({ type: 'select-region', conversationId: currentConversation, regionId });
      });
      await page.exposeFunction('__ladReportFindings', async (value: unknown) => {
        const report = value as {
          regionId?: unknown;
          findings?: Array<{ selector?: unknown; category?: unknown; state?: unknown }>;
        };
        const currentConversation = target.conversationId;
        if (
          !report ||
          typeof report.regionId !== 'string' ||
          this.manager.pageOf(currentConversation) !== page
        )
          return;
        const findings = (report.findings ?? []).filter(
          (finding) =>
            typeof finding.selector === 'string' &&
            [
              'text-clipping',
              'horizontal-overflow',
              'vertical-overflow',
              'element-overlap',
            ].includes(String(finding.category)) &&
            (finding.state === 'current' || finding.state === 'stale')
        ) as Array<{
          selector: string;
          category:
            'text-clipping' | 'horizontal-overflow' | 'vertical-overflow' | 'element-overlap';
          state: 'current' | 'stale';
        }>;
        if (!findings.length) return;
        await this.atomic(currentConversation, async () => {
          const state = await this.stateOf(currentConversation);
          const region = state.regions.find((item) => item.id === report.regionId);
          if (!region) return;
          let changed = false;
          for (const anchor of region.anchors) {
            for (const finding of anchor.findings ?? []) {
              const observed = findings.find(
                (item) => item.selector === anchor.selector && item.category === finding.category
              );
              if (observed && finding.state !== observed.state) {
                finding.state = observed.state;
                changed = true;
              }
            }
          }
          if (changed) {
            region.updatedAt = nowIso();
            await this.save(currentConversation, state);
            this.emitState(currentConversation);
          }
        });
      });
    })();
    try {
      await binding.ready;
    } catch (error) {
      if (this.highlightBindings.get(page) === binding) this.highlightBindings.delete(page);
      throw error;
    }
  }

  private async paintConversation(
    conversationId: string,
    providedState?: LadConversationState
  ): Promise<void> {
    const page = this.manager.pageOf(conversationId);
    if (!page || page.isClosed()) return;
    const state = providedState ?? (await this.stateOf(conversationId));
    const display = this.displayState.get(conversationId) ?? { visible: true };
    const areas = new Map(state.areas.map((area) => [area.id, area]));
    const regionPositions = new Map<string, number>();
    const regions = state.regions.map((region) => {
      const area = areas.get(region.areaId);
      const position = (regionPositions.get(region.areaId) ?? 0) + 1;
      regionPositions.set(region.areaId, position);
      const legacyName = /^Area (\d+)$/u.exec(area?.name ?? '');
      return {
        id: region.id,
        areaId: region.areaId,
        color: area?.color ?? '#7292b7',
        label: `${
          legacyName && display.areaPrefix
            ? `${display.areaPrefix} ${legacyName[1]}`
            : (area?.name ?? display.areaPrefix ?? 'Area')
        } · ${position}`,
        region,
      };
    });
    await this.bindRegionSelection(page, conversationId);
    await paintRegions(page, regions, display.visible, {
      selectedAreaId: display.selectedAreaId,
      hoveredAreaId: display.hoveredAreaId,
      staleLabel: display.staleLabel,
    });
  }

  private emitState(conversationId: string): void {
    this.events.emit({ type: 'state', conversationId });
  }

  async list(conversationId: string): Promise<LadConversationState> {
    const state = await this.stateOf(conversationId);
    const verified = state.areas.filter(
      (a) => a.status === 'Verified' && a.verification?.outcome === 'Verified'
    );
    if (verified.length) {
      const current = await this.manager.sourceRevision(conversationId).catch(() => null);
      let changed = false;
      for (const area of verified)
        if (
          !current ||
          current.root !== area.verification!.source?.root ||
          current.fingerprint !== area.verification!.source?.fingerprint
        ) {
          area.status = 'Fixed';
          area.verification = {
            ...area.verification!,
            outcome: 'Not Verified',
            criterion: 'text_fit',
            reason: 'Source revision or selected project changed',
          };
          LadStore.appendEvent(area, {
            source: 'runtime',
            action: 'verification stale: source/project changed',
          });
          changed = true;
        }
      if (changed) await this.save(conversationId, state);
    }
    this.schedulePaint(conversationId, state);
    return state;
  }

  async adopt(from: string, to: string): Promise<void> {
    const page = this.manager.pageOf(from);
    const binding = page ? this.selectionBindings.get(page) : undefined;
    if (binding) binding.conversationId = to;
    const state = await this.stateOf(from);
    const existing = await this.stateOf(to);
    if (existing.areas.length || existing.regions.length)
      throw new Error('Destination has browser evidence');
    await this.store.copyEvidence(from, to);
    const scope = await this.manager.sourceRevision(to).catch(() => null);
    if (scope) for (const region of state.regions) region.projectRoot ??= scope.root;
    const next = {
      ...state,
      conversationId: to,
      areas: state.areas.map((area) => ({ ...area, conversationId: to })),
      regions: state.regions.map((region) => ({ ...region, conversationId: to })),
    };
    await this.save(to, next);
    await this.save(from, { ...state, areas: [], regions: [] });
    this.emitState(from);
    this.emitState(to);
  }

  /**
   * Ground a user-selected viewport rect into a region.
   * Mirrors the original: DOM anchors when possible, screenshot-only
   * fallback for Canvas/SVG, diagnostics preserved.
   */
  async createRegion(
    conversationId: string,
    rect: LadRect,
    opts: {
      areaId?: string;
      note?: string;
      areaName?: string;
      areaDescription?: string;
      origin?: 'manual' | 'detected';
    } = {}
  ): Promise<{ region: LadRegion; area: LadArea | null }> {
    const page = this.manager.pageOf(conversationId);
    if (!page) throw new Error('no live page for this conversation; open a URL first');

    const evidence = await groundRegion(page, rect);
    const scope = await this.manager.sourceRevision(conversationId).catch(() => null);
    const state = await this.stateOf(conversationId);

    if (opts.note?.startsWith('DOM overflow candidate')) {
      const existing = state.regions.find(
        (r) =>
          r.url === evidence.url &&
          r.viewport.width === evidence.viewport.width &&
          r.viewport.height === evidence.viewport.height &&
          state.areas.find((area) => area.id === r.areaId)?.origin === 'detected' &&
          r.anchors[0]?.confidence >= 0.8 &&
          r.anchors[0].selector === evidence.anchors[0]?.selector
      );
      if (existing)
        return {
          region: existing,
          area: state.areas.find((a) => a.id === existing.areaId) ?? null,
        };
    }
    if (state.regions.length >= 100) throw new Error('Region limit reached (100 per conversation)');
    let area = opts.areaId ? state.areas.find((a) => a.id === opts.areaId) : undefined;
    if (!area) {
      const number = state.areas.length + 1;
      area = {
        id: newId('area'),
        conversationId,
        name: opts.areaName?.trim().slice(0, 200) || `Area ${number}`,
        description: (
          opts.areaDescription ??
          (opts.origin === 'detected'
            ? evidence.anchors
                .flatMap((anchor) => anchor.findings ?? [])
                .map((finding) => finding.fact)
                .filter(Boolean)
                .join('; ')
            : undefined)
        )?.slice(0, 2000),
        origin: opts.origin ?? 'manual',
        status: 'Detected',
        statusSource: opts.origin === 'detected' ? 'runtime' : 'user',
        regionIds: [],
        number,
        color: ladAreaColor(number),
        createdAt: nowIso(),
        updatedAt: nowIso(),
        events: [
          {
            at: nowIso(),
            source: opts.origin === 'detected' ? 'runtime' : 'user',
            action: opts.origin === 'detected' ? 'potential layout candidate detected' : 'created',
          },
        ],
      };
      state.areas.push(area);
    }

    const region: LadRegion = {
      id: newId('region'),
      conversationId,
      areaId: area.id,
      url: evidence.url,
      route: evidence.route,
      viewport: evidence.viewport,
      dpr: evidence.dpr,
      scroll: evidence.scroll,
      rect: evidence.rect,
      anchors: evidence.anchors,
      surroundings: evidence.surroundings,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      snapshot: evidence.snapshot,
      projectRoot: scope?.root,
      diagnostics: [
        ...evidence.diagnostics,
        ...(opts.note ? [`user note: ${opts.note.slice(0, 400)}`] : []),
      ],
      events: [
        {
          at: nowIso(),
          source: opts.origin === 'detected' ? 'runtime' : 'user',
          action:
            opts.origin === 'detected'
              ? 'potential layout candidate grounded in the DOM'
              : evidence.diagnostics[0]?.includes('Screenshot-only')
                ? 'selected (screenshot-only Canvas/SVG)'
                : 'selected (DOM grounding)',
        },
      ],
    };
    await this.remember(conversationId, region, 'selection');
    this.invalidate(area, 'selection added');
    area.regionIds.push(region.id);
    area.updatedAt = nowIso();
    LadStore.appendEvent(area, {
      source: opts.origin === 'detected' ? 'runtime' : 'user',
      action: `region added (${region.id})`,
    });
    state.regions.push(region);

    await this.save(conversationId, state);
    this.events.emit({ type: 'region', conversationId, region, area });
    this.emitState(conversationId);
    return { region, area };
  }

  async detect(
    conversationId: string,
    options: { areaNamePrefix?: string } = {}
  ): Promise<{ count: number; regionIds: string[]; areaIds: string[] }> {
    const page = this.manager.pageOf(conversationId);
    if (!page) throw new Error('No live page');
    const boxes = await page.evaluate(() =>
      Array.from(document.querySelectorAll('main *,section,article,button,p,h1,h2'))
        .slice(0, 4000)
        .filter(
          (element) =>
            !element.closest('[id^=__lad-],input,textarea,[data-private],[data-sensitive]')
        )
        .filter(
          (element) => element.clientWidth > 0 && element.scrollWidth > element.clientWidth + 2
        )
        .map((element) => {
          const r = element.getBoundingClientRect();
          return {
            x: Math.max(0, r.x),
            y: Math.max(0, r.y),
            width: Math.min(r.width, window.innerWidth - r.x),
            height: Math.min(r.height, window.innerHeight - r.y),
          };
        })
        .filter(
          (r) =>
            r.width >= 4 && r.height >= 4 && r.x < window.innerWidth && r.y < window.innerHeight
        )
        .slice(0, 32)
    );
    const candidates = new Map<string, { regionId: string; areaId: string }>();
    for (const rect of boxes) {
      const state = await this.stateOf(conversationId);
      const nextNumber = state.areas.length + 1;
      const result = await this.createRegion(conversationId, rect, {
        note: 'DOM overflow candidate; intent and source mapping require confirmation.',
        origin: 'detected',
        areaName: options.areaNamePrefix ? `${options.areaNamePrefix} ${nextNumber}` : undefined,
      });
      const key =
        result.region.anchors[0]?.selector ||
        `${result.region.url}|${result.region.viewport.width}x${result.region.viewport.height}|${Math.round(result.region.rect.x)}:${Math.round(result.region.rect.y)}:${Math.round(result.region.rect.width)}:${Math.round(result.region.rect.height)}`;
      if (!candidates.has(key))
        candidates.set(key, { regionId: result.region.id, areaId: result.region.areaId });
    }
    const values = [...candidates.values()];
    return {
      count: values.length,
      regionIds: values.map((item) => item.regionId),
      areaIds: [...new Set(values.map((item) => item.areaId))],
    };
  }
  async reveal(conversationId: string, regionId: string): Promise<void> {
    const page = this.manager.pageOf(conversationId);
    const region = await this.getRegion(conversationId, regionId);
    if (!page || !region) throw new Error('Region unavailable');
    const projection = await projectRegion(page, region);
    if (projection.stale) {
      region.live = {
        url: region.url,
        viewport: region.viewport,
        dpr: region.dpr,
        scroll: region.scroll,
        stale: true,
        reason: projection.reason ?? 'Element not found or binding is stale',
        observedAt: nowIso(),
      };
      region.updatedAt = nowIso();
      const staleState = await this.stateOf(conversationId);
      const staleIndex = staleState.regions.findIndex((item) => item.id === region.id);
      if (staleIndex >= 0) staleState.regions[staleIndex] = region;
      await this.save(conversationId, staleState);
      this.emitState(conversationId);
      throw new Error(
        'Element not found or binding is stale: ' + (projection.reason ?? 'reselect this region')
      );
    }
    if (projection.selector) await page.locator(projection.selector).scrollIntoViewIfNeeded();
    else
      await page.evaluate(
        (rect) =>
          window.scrollTo({ top: Math.max(0, rect.y - 60), left: Math.max(0, rect.x - 60) }),
        region.rect
      );
    const state = await this.stateOf(conversationId);
    this.displayState.set(conversationId, {
      ...this.displayState.get(conversationId),
      visible: true,
      selectedAreaId: region.areaId,
    });
    try {
      await this.paintConversation(conversationId, state);
    } catch (error) {
      if (!this.isTransientPageTransition(error)) throw error;
      this.retryPaint(conversationId);
    }
  }

  async display(
    conversationId: string,
    input: {
      visible?: boolean;
      selectedAreaId?: string | null;
      hoveredAreaId?: string | null;
      staleLabel?: string;
      areaPrefix?: string;
    }
  ): Promise<void> {
    const state = await this.stateOf(conversationId);
    const areaIds = new Set(state.areas.map((area) => area.id));
    const previous = this.displayState.get(conversationId) ?? { visible: true };
    this.displayState.set(conversationId, {
      visible: input.visible ?? previous.visible,
      selectedAreaId:
        input.selectedAreaId === null
          ? undefined
          : input.selectedAreaId && areaIds.has(input.selectedAreaId)
            ? input.selectedAreaId
            : previous.selectedAreaId,
      hoveredAreaId:
        input.hoveredAreaId === null
          ? undefined
          : input.hoveredAreaId && areaIds.has(input.hoveredAreaId)
            ? input.hoveredAreaId
            : previous.hoveredAreaId,
      staleLabel: input.staleLabel ?? previous.staleLabel,
      areaPrefix: input.areaPrefix?.slice(0, 40) ?? previous.areaPrefix,
    });
    try {
      await this.paintConversation(conversationId, state);
    } catch (error) {
      if (!this.isTransientPageTransition(error)) throw error;
      this.retryPaint(conversationId);
    }
  }

  /** Real in-page selection on the native Page (CSS coordinates). */
  async setSelection(
    conversationId: string,
    areaId: string,
    options: { areaName?: string } = {}
  ): Promise<void> {
    const page = this.manager.pageOf(conversationId);
    if (!page) throw new Error('Browser page is not ready');
    if (areaId === 'off') {
      await page
        .evaluate(() => {
          (window as unknown as { __ladSelectionStop?: () => void }).__ladSelectionStop?.();
        })
        .catch(() => undefined);
      return;
    }
    let binding = this.selectionBindings.get(page);
    if (!binding) {
      binding = { conversationId, areaName: options.areaName };
      const target = binding;
      // A surviving native Page may still carry the previous runtime's function.
      await page.evaluate(() => {
        delete (window as unknown as { __ladCommitRegion?: unknown }).__ladCommitRegion;
      });
      await page.exposeFunction(
        '__ladCommitRegion',
        async (value: { rect: LadRect; areaId?: string }) => {
          if (
            !value?.rect ||
            !['x', 'y', 'width', 'height'].every((key) =>
              Number.isFinite(value.rect[key as keyof LadRect])
            ) ||
            value.rect.width < 4 ||
            value.rect.height < 4 ||
            value.rect.width > 8192 ||
            value.rect.height > 8192
          )
            throw new Error('Invalid selection rectangle');
          if (value.areaId?.startsWith('replace:')) {
            await this.replaceRegion(target.conversationId, value.areaId.slice(8), value.rect);
            return;
          }
          await this.createRegion(target.conversationId, value.rect, {
            areaId: value.areaId === 'new' ? undefined : value.areaId,
            areaName: target.areaName,
          });
        }
      );
      this.selectionBindings.set(page, binding);
    } else {
      binding.conversationId = conversationId;
      binding.areaName = options.areaName;
    }
    await page.evaluate((target) => {
      const state = window as unknown as {
        __ladSelectionStop?: () => void;
        __ladCommitRegion?: (value: unknown) => Promise<void>;
      };
      state.__ladSelectionStop?.();
      if (target === 'off') return;
      const overlay = document.createElement('div');
      overlay.id = '__lad-selection';
      overlay.style.cssText =
        'position:fixed;inset:0;z-index:2147483647;cursor:crosshair;touch-action:none;background:#6484a508';
      const box = document.createElement('div');
      box.style.cssText =
        'position:absolute;border:2px solid #6d90b5;background:#6d90b522;pointer-events:none;display:none';
      overlay.append(box);
      document.documentElement.append(overlay);
      let start: { x: number; y: number } | undefined;
      const stop = () => {
        overlay.remove();
        document.removeEventListener('keydown', key, true);
      };
      const key = (event: KeyboardEvent) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          stop();
        }
      };
      document.addEventListener('keydown', key, true);
      state.__ladSelectionStop = stop;
      overlay.onpointerdown = (event) => {
        event.preventDefault();
        start = { x: event.clientX, y: event.clientY };
        overlay.setPointerCapture(event.pointerId);
      };
      overlay.onpointermove = (event) => {
        if (!start) return;
        Object.assign(box.style, {
          display: 'block',
          left: Math.min(start.x, event.clientX) + 'px',
          top: Math.min(start.y, event.clientY) + 'px',
          width: Math.abs(start.x - event.clientX) + 'px',
          height: Math.abs(start.y - event.clientY) + 'px',
        });
      };
      overlay.onpointerup = (event) => {
        if (!start) return;
        const rect = {
          x: Math.min(start.x, event.clientX),
          y: Math.min(start.y, event.clientY),
          width: Math.abs(start.x - event.clientX),
          height: Math.abs(start.y - event.clientY),
        };
        start = undefined;
        stop();
        if (rect.width >= 4 && rect.height >= 4)
          void state.__ladCommitRegion?.({ rect, areaId: target });
      };
    }, areaId);
  }

  async getRegion(conversationId: string, regionId: string): Promise<LadRegion | null> {
    const state = await this.stateOf(conversationId);
    return state.regions.find((r) => r.id === regionId) ?? null;
  }

  /** Live re-projection of a region (fresh rect + stale reason). */
  async liveProjection(conversationId: string, regionId: string): Promise<LadRegion | null> {
    const page = this.manager.pageOf(conversationId);
    if (!page) return null;
    const region = await this.getRegion(conversationId, regionId);
    if (!region) return null;
    const projection = await projectRegion(page, region).catch(() => null);
    if (!projection) return region;
    const next: LadRegion = {
      ...region,
      live: {
        url: region.url,
        viewport: region.viewport,
        dpr: region.dpr,
        scroll: region.scroll,
        rect: projection.stale ? undefined : projection.rect,
        stale: projection.stale,
        reason: projection.reason,
        observedAt: nowIso(),
      },
    };
    if (projection.stale) {
      const diag = `live check: binding stale (${projection.reason ?? 'unknown'}) — original data preserved`;
      if (!next.diagnostics.includes(diag)) next.diagnostics.push(diag);
    }
    next.updatedAt = nowIso();
    const state = await this.stateOf(conversationId);
    const idx = state.regions.findIndex((r) => r.id === region.id);
    if (idx >= 0) state.regions[idx] = next;
    await this.save(conversationId, state);
    this.events.emit({ type: 'region', conversationId, region: next });
    return next;
  }

  async createArea(
    conversationId: string,
    input: { name: string; description?: string; status?: string }
  ): Promise<LadArea> {
    if (input.status === 'Verified') throw new Error('Verified requires source revision evidence');
    const state = await this.stateOf(conversationId);
    const number = state.areas.length + 1;
    const area: LadArea = {
      id: newId('area'),
      conversationId,
      name: input.name.slice(0, 200),
      origin: 'manual',
      description: input.description?.slice(0, 2000),
      status: (input.status as LadRegionStatus) ?? 'Detected',
      statusSource: 'user',
      regionIds: [],
      number,
      color: ladAreaColor(number),
      createdAt: nowIso(),
      updatedAt: nowIso(),
      events: [{ at: nowIso(), source: 'user', action: 'created' }],
    };
    if (!LAD_REGION_STATUSES.includes(area.status)) area.status = 'Detected';
    state.areas.push(area);
    await this.save(conversationId, state);
    this.events.emit({ type: 'area', conversationId, area });
    this.emitState(conversationId);
    return area;
  }

  async updateArea(
    conversationId: string,
    areaId: string,
    patch: {
      name?: string;
      description?: string;
      status?: string;
      statusSource?: 'user' | 'agent' | 'runtime';
      origin?: 'manual' | 'detected';
    }
  ): Promise<LadArea> {
    if (patch.status === 'Verified') throw new Error('Verified requires source revision evidence');
    const state = await this.stateOf(conversationId);
    const area = state.areas.find((a) => a.id === areaId);
    if (!area) throw new Error(`unknown-area: ${areaId}`);
    if (patch.name !== undefined && patch.name.slice(0, 200) !== area.name) {
      area.name = patch.name.slice(0, 200);
      LadStore.appendEvent(area, { source: patch.statusSource ?? 'user', action: 'name changed' });
    }
    if (patch.description !== undefined && patch.description.slice(0, 2000) !== area.description) {
      area.description = patch.description.slice(0, 2000);
      this.invalidate(area, 'Acceptance description changed; recheck required');
      LadStore.appendEvent(area, {
        source: patch.statusSource ?? 'user',
        action: 'description changed',
      });
    }
    if (patch.origin !== undefined && patch.origin !== area.origin) {
      area.origin = patch.origin;
      LadStore.appendEvent(area, {
        source: 'user',
        action:
          patch.origin === 'manual'
            ? 'candidate adopted as an area'
            : 'marked as detected candidate',
      });
    }
    if (patch.status !== undefined) {
      LadStore.setAreaStatus(area, patch.status, patch.statusSource ?? 'user');
    }
    area.updatedAt = nowIso();
    await this.save(conversationId, state);
    this.events.emit({ type: 'area', conversationId, area });
    this.emitState(conversationId);
    return area;
  }

  async attachRegionToArea(
    conversationId: string,
    regionId: string,
    areaId: string
  ): Promise<{ region: LadRegion; area: LadArea }> {
    const state = await this.stateOf(conversationId);
    const region = state.regions.find((r) => r.id === regionId);
    const area = state.areas.find((a) => a.id === areaId);
    if (!region) throw new Error(`unknown-region: ${regionId}`);
    if (!area) throw new Error(`unknown-area: ${areaId}`);
    const oldArea = state.areas.find((a) => a.id === region.areaId);
    if (oldArea && oldArea.id !== area.id) {
      oldArea.regionIds = oldArea.regionIds.filter((id) => id !== region.id);
      LadStore.appendEvent(oldArea, { source: 'user', action: `region removed (${region.id})` });
      oldArea.updatedAt = nowIso();
    }
    if (!area.regionIds.includes(region.id)) area.regionIds.push(region.id);
    if (oldArea) this.invalidate(oldArea, 'region moved');
    this.invalidate(area, 'region moved');
    region.areaId = area.id;
    region.updatedAt = nowIso();
    LadStore.appendEvent(region, { source: 'user', action: `moved to area ${area.name}` });
    LadStore.appendEvent(area, { source: 'user', action: `region added (${region.id})` });
    area.updatedAt = nowIso();
    await this.save(conversationId, state);
    this.events.emit({ type: 'region', conversationId, region, area });
    this.emitState(conversationId);
    return { region, area };
  }

  async removeRegion(conversationId: string, regionId: string): Promise<void> {
    const state = await this.stateOf(conversationId);
    const idx = state.regions.findIndex((r) => r.id === regionId);
    if (idx < 0) throw new Error(`unknown-region: ${regionId}`);
    const [removed] = state.regions.splice(idx, 1);
    const area = state.areas.find((a) => a.id === removed.areaId);
    if (area) {
      this.invalidate(area, 'region removed');
      area.regionIds = area.regionIds.filter((id) => id !== regionId);
      area.updatedAt = nowIso();
    }
    await this.save(conversationId, state);
    this.events.emit({ type: 'region', conversationId, removedRegionId: regionId });
    this.emitState(conversationId);
  }

  async removeArea(conversationId: string, areaId: string): Promise<void> {
    const state = await this.stateOf(conversationId);
    const idx = state.areas.findIndex((a) => a.id === areaId);
    if (idx < 0) throw new Error(`unknown-area: ${areaId}`);
    state.areas.splice(idx, 1);
    state.regions = state.regions.filter((r) => r.areaId !== areaId);
    await this.save(conversationId, state);
    this.events.emit({ type: 'area', conversationId, removedAreaId: areaId });
    this.emitState(conversationId);
  }

  async removeAllAreas(conversationId: string): Promise<{
    areaCount: number;
    regionCount: number;
    captureCount: number;
  }> {
    return this.atomic(conversationId, async () => {
      const state = await this.stateOf(conversationId);
      const areaCount = state.areas.length;
      const regionCount = state.regions.length;
      const evidenceIds = [
        ...new Set(
          state.regions.flatMap((region) =>
            (region.history ?? [])
              .map((item) => item.cropId)
              .filter((id): id is string => Boolean(id))
          )
        ),
      ];
      state.areas = [];
      state.regions = [];
      const display = this.displayState.get(conversationId);
      if (display) {
        display.selectedAreaId = undefined;
        display.hoveredAreaId = undefined;
      }
      await this.save(conversationId, state);
      await this.store.removeEvidence(conversationId, evidenceIds);
      this.events.emit({ type: 'area', conversationId, removedAreaId: '*' });
      this.emitState(conversationId);
      return { areaCount, regionCount, captureCount: evidenceIds.length };
    });
  }

  async setWorkspace(
    conversationId: string,
    patch: Partial<LadWorkspaceSettings>
  ): Promise<LadWorkspaceSettings> {
    const state = await this.stateOf(conversationId);
    state.workspace = ladValidateWorkspace({ ...state.workspace, ...patch });
    await this.save(conversationId, state);
    this.emitState(conversationId);
    return state.workspace;
  }

  async setViewportForWorkspace(
    conversationId: string,
    workspace: LadWorkspaceSettings
  ): Promise<void> {
    // 'auto' viewport is driven by the renderer panel size; skip.
    if (workspace.viewport === 'auto') return;
    await this.manager
      .setViewport(conversationId, workspace.viewport, workspace.zoom ?? 1, 'user')
      .catch(() => undefined);
  }

  /**
   * Capture the current crop for a region. Uses the live projection when the
   * binding is still valid, otherwise falls back to the original viewport
   * geometry (only meaningful while the page has not changed).
   */
  async captureRegion(
    conversationId: string,
    region: LadRegion,
    opts: { maxEdge?: number } = {}
  ): Promise<
    | { mime: 'image/jpeg' | 'image/png'; data: string; width: number; height: number }
    | { error: string; reason?: string }
  > {
    const page = this.manager.pageOf(conversationId);
    if (!page) return { error: 'no-session' };
    // Re-project to get a current viewport-relative rect.
    let rect: LadRect | null = null;
    let staleReason: string | undefined;
    try {
      const projection = await projectRegion(page, region);
      if (!projection.stale && projection.rect) rect = projection.rect;
      else staleReason = projection.reason;
    } catch {
      staleReason = 'projection-failed';
    }
    if (!rect) return { error: 'stale-region', reason: staleReason };
    const result = await this.manager.captureCrop(conversationId, rect, {
      maxEdge: opts.maxEdge ?? 1280,
      quality: 80,
    });
    if ('error' in result) return { error: result.error, reason: staleReason };
    return result;
  }

  private invalidate(area: LadArea, reason: string) {
    if (area.status === 'Verified') area.status = 'Fixed';
    if (area.verification)
      area.verification = { ...area.verification, outcome: 'Not Verified', reason };
  }
  private async remember(id: string, region: LadRegion, kind: LadVisualEvidence['kind']) {
    const record: LadVisualEvidence = {
      id: newId('evidence'),
      at: nowIso(),
      kind,
      url: region.url,
      viewport: region.viewport,
      snapshot: region.snapshot,
      anchors: globalThis.structuredClone(region.anchors),
      rect: region.rect,
      diagnostics: [...region.diagnostics],
    };
    const crop = await this.captureRegion(id, region, { maxEdge: 800 }).catch(() => ({
      error: 'capture-unavailable',
    }));
    if (!('error' in crop)) {
      try {
        await this.store.saveEvidence(id, record.id, crop);
        record.cropId = record.id;
      } catch (error) {
        record.diagnostics.push(String(error));
      }
    }
    const history = [...(region.history ?? []), record];
    region.history = history.length > 20 ? [history[0], ...history.slice(-19)] : history;
  }
  async evidence(id: string, evidenceId: string): Promise<unknown> {
    const state = await this.stateOf(id);
    if (!state.regions.some((r) => r.history?.some((h) => h.cropId === evidenceId)))
      throw new Error('Evidence not referenced in this conversation');
    return this.store.evidence(id, evidenceId);
  }
  async workflow(id: string, areaId: string, value: string): Promise<void> {
    if (!['active', 'completed', 'disputed'].includes(value)) throw new Error('Invalid workflow');
    const state = await this.stateOf(id),
      area = state.areas.find((a) => a.id === areaId);
    if (!area) throw new Error('Unknown area');
    area.workflow = { state: value as 'active' | 'completed' | 'disputed', at: nowIso() };
    if (value === 'disputed') this.invalidate(area, 'User disputed result');
    LadStore.appendEvent(area, { source: 'user', action: `workflow:${value}` });
    await this.save(id, state);
    this.emitState(id);
  }
  async replaceRegion(id: string, regionId: string, rect: LadRect): Promise<void> {
    const page = this.manager.pageOf(id);
    if (!page) throw new Error('No live page');
    const state = await this.stateOf(id),
      region = state.regions.find((r) => r.id === regionId);
    if (!region) throw new Error('Unknown region');
    const evidence = await groundRegion(page, rect);
    if (evidence.url !== region.url) throw new Error('Reselect on the original page');
    const scope = await this.manager.sourceRevision(id).catch(() => null);
    if (region.projectRoot && scope?.root !== region.projectRoot)
      throw new Error('Select the original project before reselecting');
    // Identity and the original immutable selection remain in history.
    if (!region.history?.length) await this.remember(id, region, 'selection');
    Object.assign(region, evidence, { updatedAt: nowIso(), live: undefined });
    await this.remember(id, region, 'reselection');
    LadStore.appendEvent(region, { source: 'user', action: 'reselected; identity retained' });
    const area = state.areas.find((a) => a.id === region.areaId);
    if (area) {
      this.invalidate(area, 'region reselected');
      LadStore.appendEvent(area, { source: 'user', action: `reselected ${regionId}` });
    }
    await this.save(id, state);
    this.emitState(id);
  }
  private checking = new Set<string>();
  async recheck(id: string, areaId: string): Promise<LadVerification> {
    if (this.checking.has(id)) throw new Error('Verification already running');
    this.checking.add(id);
    const state = await this.stateOf(id),
      area = state.areas.find((a) => a.id === areaId);
    if (!area) {
      this.checking.delete(id);
      throw new Error('Unknown area');
    }
    const regions = state.regions.filter((r) => r.areaId === areaId);
    const record: LadVerification = {
      id: newId('check'),
      at: nowIso(),
      outcome: 'Not Verified',
      criterion: 'text_fit',
      regions: [],
      errors: [],
    };
    let source: LadSourceRevision | undefined, restore: (() => Promise<void>) | undefined;
    const page = this.manager.pageOf(id),
      previousOwnership = this.manager.meta(id)?.ownership ?? 'user';
    const freshAssets = (route: Route) => route.continue();
    const onError = (error: Error) => record.errors.push(error.message.slice(0, 500));
    record.sourceDiagnostics = [];
    const served = new Set<string>(),
      responses: Promise<void>[] = [];
    const onResponse = (response: Response) => {
      if (
        !source ||
        !response.ok() ||
        new URL(response.url()).origin !== new URL(regions[0].url).origin ||
        !/javascript|css/.test(response.headers()['content-type'] ?? '')
      )
        return;
      responses.push(
        (async () => {
          const length = Number(response.headers()['content-length'] ?? 0);
          if (length > 4_000_000) return;
          if (record.sourceDiagnostics!.length < 20)
            record.sourceDiagnostics!.push(new URL(response.url()).pathname);
          const body = await response.text();
          if (body.length > 4_000_000) return;
          const match = body.match(
            /sourceMappingURL=data:application\/json[^,]*;base64,([A-Za-z0-9+/=]+)/
          );
          if (!match) {
            record.sourceDiagnostics!.push('inline source map unavailable');
            return;
          }
          const map = JSON.parse(Buffer.from(match[1], 'base64').toString('utf8')) as {
            sources?: string[];
            sourcesContent?: string[];
          };
          for (let index = 0; index < (map.sourcesContent?.length ?? 0); index++) {
            const content = map.sourcesContent![index];
            if (typeof content !== 'string') continue;
            const hash = createHash('sha256').update(content).digest('hex');
            for (const [file, expected] of Object.entries(source!.files))
              if (hash === expected) served.add(file);
          }
        })().catch((error) => {
          if (record.sourceDiagnostics!.length < 20)
            record.sourceDiagnostics!.push(
              'Source response unavailable: ' + (error instanceof Error ? error.name : 'error')
            );
        })
      );
    };
    try {
      if (!page || !regions.length || regions.length > 6)
        throw new Error('Recheck supports one to six DOM regions');
      const first = regions[0];
      source = await this.manager.sourceRevision(id);
      if (regions.some((r) => r.projectRoot !== source!.root))
        throw new Error('Area is not bound to the selected project; reselect in that project');
      if (
        regions.some(
          (r) =>
            r.url !== first.url ||
            r.viewport.width !== first.viewport.width ||
            r.viewport.height !== first.viewport.height
        )
      )
        throw new Error('All regions must share their original URL and viewport');
      if (
        regions.some(
          (r) =>
            !r.anchors[0] ||
            r.anchors[0].confidence < 0.8 ||
            !r.anchors[0].findings?.some((f) =>
              ['text-clipping', 'horizontal-overflow', 'vertical-overflow'].includes(f.category)
            )
        )
      )
        throw new Error(
          'Automatic recheck supports original DOM text-fitting candidates; other intent needs explicit acceptance criteria'
        );
      record.source = { root: source.root, fingerprint: source.fingerprint, scope: source.scope };
      await this.manager.setOwnership(id, 'agent', 'user');
      restore = await this.manager.verificationViewport(id, first.viewport);
      page.on('pageerror', onError);
      page.on('response', onResponse);
      // Interception disables the page HTTP cache for a fresh verification load.
      await page.route('**/*', freshAssets);
      await this.setSelection(id, 'off');
      const response = await page.goto(first.url, { waitUntil: 'load', timeout: 15000 });
      if (!response) await page.reload({ waitUntil: 'load', timeout: 15000 });
      if (response && !response.ok()) throw new Error(`Page returned ${response.status()}`);
      await page.evaluate(() => document.fonts.ready);
      for (const region of regions) {
        const projection = await projectRegion(page, region);
        const size = await page.evaluate(() => ({
          width: window.innerWidth,
          height: window.innerHeight,
        }));
        if (
          projection.stale ||
          page.url() !== region.url ||
          size.width !== region.viewport.width ||
          size.height !== region.viewport.height
        )
          throw new Error('Original URL, viewport or DOM identity unproven: ' + projection.reason);
        const selector = region.anchors[0].selector,
          observed = await textFit(page, selector);
        record.regions.push({
          id: region.id,
          snapshot: region.snapshot,
          url: region.url,
          viewport: region.viewport,
          selector,
          expected: 0,
          observed,
        });
        const fresh = await groundRegion(page, projection.rect!);
        const observation = { ...region, ...fresh, history: region.history };
        await this.remember(id, observation, 'recheck');
        region.history = observation.history;
      }
      await Promise.all(responses);
      record.servedSources = [...served];
      if (!served.size && record.regions.every((r) => r.observed === 0))
        throw new Error(
          'No loaded source-map content matches the selected project revision; served source association unproven'
        );
      const after = await this.manager.sourceRevision(id);
      if (after.root !== source.root || after.fingerprint !== source.fingerprint)
        throw new Error('Sources changed during verification');
      if (record.errors.length) throw new Error('Page runtime errors occurred');
      record.outcome = record.regions.every((r) => r.observed === 0)
        ? 'Verified'
        : record.regions.some((r) => r.observed !== null && r.observed > 0)
          ? 'Failed'
          : 'Not Verified';
      if (record.outcome === 'Not Verified') record.reason = 'Unsupported/hidden/empty text target';
      await this.store.saveEvidence(id, record.id, { ...record, sourceRevision: source });
    } catch (error) {
      record.outcome = 'Not Verified';
      record.reason = error instanceof Error ? error.message : String(error);
    } finally {
      page?.off('pageerror', onError);
      page?.off('response', onResponse);
      await page?.unroute('**/*', freshAssets).catch(() => undefined);
      try {
        await restore?.();
      } catch (error) {
        record.outcome = 'Not Verified';
        record.reason = String(error);
      }
      try {
        await this.manager.setOwnership(id, previousOwnership, 'user');
      } catch {
        /* closed page */
      }
      this.checking.delete(id);
    }
    // Reload after asynchronous capture so unrelated UI edits are not overwritten.
    const current = await this.stateOf(id),
      target = current.areas.find((a) => a.id === areaId);
    if (!target) throw new Error('Area was removed during verification');
    if (
      target.regionIds.join() !== area.regionIds.join() ||
      regions.some((r) => current.regions.find((v) => v.id === r.id)?.snapshot !== r.snapshot)
    ) {
      record.outcome = 'Not Verified';
      record.reason = 'Selections changed during verification';
    }
    for (const r of regions) {
      const latest = current.regions.find((v) => v.id === r.id);
      if (latest && latest.snapshot === r.snapshot) latest.history = r.history;
    }
    target.verification = record;
    target.ledger = [...(target.ledger ?? []), record].slice(-50);
    if (record.outcome === 'Verified' && target.workflow?.state !== 'disputed')
      target.status = 'Verified';
    else if (record.outcome === 'Failed') target.status = 'Unresolved';
    else if (target.status === 'Verified') target.status = 'Fixed';
    target.statusSource = 'runtime';
    target.updatedAt = nowIso();
    LadStore.appendEvent(target, {
      source: 'runtime',
      action: `recheck:${record.outcome} ${record.reason ?? record.id}`,
    });
    await this.save(id, current);
    this.emitState(id);
    return record;
  }

  /**
   * Record an agent action against an area (check / verification proof).
   */
  async recordCheck(
    conversationId: string,
    areaId: string,
    check: {
      status: string;
      reason?: string;
      source: 'user' | 'agent' | 'runtime';
      newStatus?: string;
    }
  ): Promise<LadArea | null> {
    const state = await this.stateOf(conversationId);
    const area = state.areas.find((a) => a.id === areaId);
    if (!area) return null;
    area.check = {
      status: check.status,
      reason: check.reason?.slice(0, 1000),
      at: nowIso(),
      url: state.regions.find((r) => r.areaId === area.id)?.url ?? '',
      viewport: state.regions.find((r) => r.areaId === area.id)?.viewport ?? {
        width: 0,
        height: 0,
      },
    };
    if (check.newStatus === 'Verified' || check.status.toLowerCase() === 'verified')
      throw new Error(
        'Verified requires source revision evidence; manual assertions cannot certify a fix'
      );
    if (check.newStatus) {
      LadStore.setAreaStatus(area, check.newStatus, check.source, check.reason);
    }
    LadStore.appendEvent(area, {
      source: check.source,
      action: `check:${check.status}`,
      status: check.newStatus as LadRegionStatus | undefined,
    });
    area.updatedAt = nowIso();
    await this.save(conversationId, state);
    this.events.emit({ type: 'area', conversationId, area });
    this.emitState(conversationId);
    return area;
  }
}

export { LAD_DEFAULT_WORKSPACE, promptUrl };
