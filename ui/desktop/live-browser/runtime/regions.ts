import type { Page } from 'playwright-core';
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
    type: 'state' | 'region' | 'area';
    conversationId: string;
    region?: LadRegion;
    area?: LadArea;
    removedRegionId?: string;
    removedAreaId?: string;
  }) => void;
};

/**
 * Region / area operations over the per-conversation store.
 * All mutations go through save() so the runtime is the single writer.
 */
export class RegionService {
  private selectionBindings = new WeakMap<Page, { conversationId: string }>();
  constructor(
    private readonly manager: BrowserManager,
    private readonly store: LadStore,
    private readonly events: LadEventEmitter
  ) {}

  private async stateOf(conversationId: string): Promise<LadConversationState> {
    return this.store.load(conversationId);
  }

  private save(conversationId: string, state: LadConversationState): Promise<void> {
    return this.store.save(conversationId, state);
  }

  private emitState(conversationId: string): void {
    this.events.emit({ type: 'state', conversationId });
  }

  list(conversationId: string): Promise<LadConversationState> {
    return this.stateOf(conversationId);
  }

  async adopt(from: string, to: string): Promise<void> {
    const page = this.manager.pageOf(from);
    const binding = page ? this.selectionBindings.get(page) : undefined;
    if (binding) binding.conversationId = to;
    const state = await this.stateOf(from);
    const existing = await this.stateOf(to);
    if (existing.areas.length || existing.regions.length)
      throw new Error('Destination has browser evidence');
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
    opts: { areaId?: string; note?: string } = {}
  ): Promise<{ region: LadRegion; area: LadArea | null }> {
    const page = this.manager.pageOf(conversationId);
    if (!page) throw new Error('no live page for this conversation; open a URL first');

    const evidence = await groundRegion(page, rect);
    const state = await this.stateOf(conversationId);

    let area = opts.areaId ? state.areas.find((a) => a.id === opts.areaId) : undefined;
    if (!area) {
      const number = state.areas.length + 1;
      area = {
        id: newId('area'),
        conversationId,
        name: `Area ${number}`,
        status: 'Detected',
        statusSource: 'user',
        regionIds: [],
        number,
        color: ladAreaColor(number),
        createdAt: nowIso(),
        updatedAt: nowIso(),
        events: [{ at: nowIso(), source: 'user', action: 'created' }],
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
      diagnostics: [
        ...evidence.diagnostics,
        ...(opts.note ? [`user note: ${opts.note.slice(0, 400)}`] : []),
      ],
      events: [
        {
          at: nowIso(),
          source: 'user',
          action: evidence.diagnostics[0]?.includes('Screenshot-only')
            ? 'selected (screenshot-only Canvas/SVG)'
            : 'selected (DOM grounding)',
        },
      ],
    };
    area.regionIds.push(region.id);
    area.updatedAt = nowIso();
    LadStore.appendEvent(area, { source: 'user', action: `region added (${region.id})` });
    state.regions.push(region);

    await this.save(conversationId, state);
    this.events.emit({ type: 'region', conversationId, region, area });
    this.emitState(conversationId);
    return { region, area };
  }

  async detect(conversationId: string): Promise<void> {
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
        .slice(0, 12)
    );
    for (const rect of boxes)
      await this.createRegion(conversationId, rect, {
        note: 'DOM overflow candidate; intent and source mapping require confirmation.',
      });
  }
  async reveal(conversationId: string, regionId: string): Promise<void> {
    const page = this.manager.pageOf(conversationId);
    const region = await this.getRegion(conversationId, regionId);
    if (!page || !region) throw new Error('Region unavailable');
    const projection = await projectRegion(page, region);
    if (projection.stale) throw new Error('Region binding changed: ' + projection.reason);
    if (projection.selector) await page.locator(projection.selector).scrollIntoViewIfNeeded();
    else
      await page.evaluate(
        (rect) =>
          window.scrollTo({ top: Math.max(0, rect.y - 60), left: Math.max(0, rect.x - 60) }),
        region.rect
      );
    const state = await this.stateOf(conversationId);
    const area = state.areas.find((a) => a.id === region.areaId);
    await paintRegions(
      page,
      [{ id: region.id, color: area?.color ?? '#7292b7', label: area?.name ?? 'Area', region }],
      true
    );
  }

  /** Real in-page selection on the native Page (CSS coordinates). */
  async setSelection(conversationId: string, areaId: string): Promise<void> {
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
      binding = { conversationId };
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
          await this.createRegion(target.conversationId, value.rect, {
            areaId: value.areaId === 'new' ? undefined : value.areaId,
          });
        }
      );
      this.selectionBindings.set(page, binding);
    } else binding.conversationId = conversationId;
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
    }
  ): Promise<LadArea> {
    if (patch.status === 'Verified') throw new Error('Verified requires source revision evidence');
    const state = await this.stateOf(conversationId);
    const area = state.areas.find((a) => a.id === areaId);
    if (!area) throw new Error(`unknown-area: ${areaId}`);
    if (patch.name !== undefined) area.name = patch.name.slice(0, 200);
    if (patch.description !== undefined) area.description = patch.description.slice(0, 2000);
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
    if (check.newStatus === 'Verified' || check.status === 'verified')
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
