/**
 * Agent context builder for passed Live Browser areas.
 *
 * Pure, bounded, deterministic: no DOM access, no network. The same function
 * runs in the Electron renderer (message injection) and in the runtime
 * (MCP `browser_describe_area`), so the agent always receives one consistent
 * shape.
 *
 * Contract:
 * - Text is authoritative and always present (works with Vision Off).
 * - Images are optional; Goose gates them by model vision support, so this
 *   function never needs to know the model. Canvas/SVG-only areas get an
 *   explicit limitation note instead of invented visual data.
 * - No full DOM trees, no unbounded strings, no credentials (URLs redacted).
 */
import type { LadArea, LadRegion } from './types';
import { promptUrl } from './prompt-url';

const MAX_AREAS = 4;
const MAX_REGIONS_PER_AREA = 3;
const MAX_ANCHORS = 2;
const MAX_STYLE_KEYS = 12;
const MAX_FINDINGS = 3;
const MAX_NEIGHBORS = 2;
const MAX_TOTAL_CHARS = 12_000;

interface LadContextInput {
  areas: LadArea[];
  regions: LadRegion[];
  /** Explicitly selected project (root dir the user allowed). */
  project?: { root?: string; name?: string } | null;
  /** Known vision mode of the target model, when the client knows it. */
  vision?: 'on' | 'off' | 'unknown';
  /** Optional live-check summary computed by the runtime (per region id). */
  live?: Record<string, { stale: boolean; reason?: string; at: string }>;
}

function fmtNum(n: number | undefined): string {
  return typeof n === 'number' && Number.isFinite(n) ? String(Math.round(n * 100) / 100) : '?';
}

function fmtRect(rect: { x: number; y: number; width: number; height: number }): string {
  return `x=${fmtNum(rect.x)} y=${fmtNum(rect.y)} w=${fmtNum(rect.width)} h=${fmtNum(rect.height)}`;
}

function styleString(styles: Record<string, string> | undefined): string {
  if (!styles) return '';
  const parts: string[] = [];
  for (const [key, value] of Object.entries(styles)) {
    if (parts.length >= MAX_STYLE_KEYS) break;
    if (
      value &&
      value !== 'none' &&
      value !== 'auto' &&
      value !== 'normal' &&
      value !== '0px' &&
      value !== 'rgba(0, 0, 0, 0)'
    ) {
      parts.push(`${key}:${value}`);
    }
  }
  return parts.join('; ');
}

export function buildAreaContextText(input: LadContextInput): string {
  const lines: string[] = [];
  const regionsById = new Map(input.regions.map((r) => [r.id, r]));

  lines.push('[Local AI Desktop — Live Browser selection]');
  lines.push(
    'The user selected the areas below in the Live Browser and is referring to them in their message.'
  );
  lines.push('Treat them as the target of the request. Coordinates are CSS pixels.');
  lines.push('');

  const areas = input.areas.slice(0, MAX_AREAS);
  for (const area of areas) {
    const regionList = area.regionIds
      .map((id) => regionsById.get(id))
      .filter((r): r is LadRegion => Boolean(r));
    const first = regionList[0];
    const live = first ? input.live?.[first.id] : undefined;

    lines.push(`Area ${area.number} — "${area.name}" [${area.status}] (id: ${area.id})`);
    if (area.status === 'Verified' && area.verification?.outcome !== 'Verified')
      lines.push(
        '  Legacy verification claim only: no source-revision ledger proof is attached. Do not treat this label as verified evidence.'
      );
    if (area.verification)
      lines.push(`  Verification ledger: ${JSON.stringify(area.verification)}`);
    if (area.workflow)
      lines.push(`  Workflow: ${area.workflow.state}; completion is separate from verification.`);
    if (first?.projectRoot)
      lines.push(
        `  Historical selection project: ${first.projectRoot}; compare with the current bound Goose scope before editing.`
      );
    if (area.description) lines.push(`  Task: ${area.description}`);
    if (first) {
      lines.push(`  Page URL: ${promptUrl(first.url)}`);
    }
    if (area.check) {
      lines.push(
        `  Last check: ${area.check.status}${area.check.reason ? ` — ${area.check.reason}` : ''} (${area.check.at})`
      );
    }

    for (const region of regionList.slice(0, MAX_REGIONS_PER_AREA)) {
      lines.push(`  Region ${region.id}`);
      lines.push(`    Selection (document CSS px): ${fmtRect(region.rect)}`);
      lines.push(
        `    Viewport at capture: ${fmtNum(region.viewport.width)}x${fmtNum(region.viewport.height)} · DPR ${fmtNum(region.dpr)} · scroll (${fmtNum(region.scroll.x)}, ${fmtNum(region.scroll.y)})`
      );

      const anchors = region.anchors.slice(0, MAX_ANCHORS);
      if (anchors.length) {
        for (const anchor of anchors) {
          lines.push(
            `    Anchor [${fmtNum(anchor.confidence)}]: <${anchor.tag}> selector="${anchor.selector}"${anchor.text ? ` text="${anchor.text.slice(0, 120)}"` : ''}`
          );
          const styles = styleString(anchor.styles);
          if (styles) lines.push(`      styles: ${styles.slice(0, 400)}`);
          const findings = (anchor.findings ?? []).slice(0, MAX_FINDINGS);
          for (const finding of findings) {
            lines.push(`      finding (${finding.category}): ${finding.fact.slice(0, 200)}`);
          }
          const neighbors = (anchor.neighbors ?? []).slice(0, MAX_NEIGHBORS);
          if (neighbors.length) {
            lines.push(
              `      nearby: ${neighbors.map((n) => `<${n.tag}>${n.intersects ? ' (overlaps)' : ''}`).join(', ')}`
            );
          }
        }
      } else {
        lines.push('    Anchor: none — screenshot-only region (Canvas/SVG or no DOM candidate)');
      }

      if (region.surroundings && region.surroundings.relation === 'between-siblings') {
        const s = region.surroundings;
        lines.push(
          `    Surroundings: between-siblings (${fmtNum(s.confidence)}) — above: <${s.above?.tag ?? '?'}>${s.above?.text ? ` "${s.above.text.slice(0, 80)}"` : ''}; below: <${s.below?.tag ?? '?'}>${s.below?.text ? ` "${s.below.text.slice(0, 80)}"` : ''}`
        );
      }

      const liveInfo: { stale: boolean; reason?: string; at: string } | undefined = region.live
        ? { stale: region.live.stale, reason: region.live.reason, at: region.live.observedAt }
        : first && live
          ? live
          : undefined;
      if (liveInfo) {
        lines.push(
          liveInfo.stale
            ? `    Live check (${liveInfo.at}): binding STALE (${liveInfo.reason ?? 'unknown'}) — original data preserved; re-verify before editing`
            : `    Live check (${liveInfo.at}): binding still valid`
        );
      }

      if (region.diagnostics.length) {
        lines.push(`    Diagnostics: ${region.diagnostics.slice(0, 4).join(' | ')}`);
      }
      if (region.events.length) {
        const lastEvents = region.events
          .slice(-3)
          .map((e) => `${e.action}${e.status ? ` → ${e.status}` : ''}`);
        lines.push(`    History: ${lastEvents.join('; ')}`);
      }
    }
    lines.push('');
  }

  if (input.project?.root) {
    lines.push(
      `Project: ${input.project.name ? `"${input.project.name}" ` : ''}${input.project.root} — root directory for source investigation; Goose file permissions still apply.`
    );
  } else {
    lines.push(
      'Project: consult the bound Goose session scope. Browser metadata alone does not establish a filesystem root or grant filesystem access.'
    );
  }

  if (input.vision === 'off') {
    lines.push('');
    lines.push(
      'VISION OFF: no image was sent for this selection. Rely on the text above (URL, DOM, geometry, CSS). If the region is Canvas/WebGL/SVG-only, you CANNOT see its visual content — say so instead of guessing.'
    );
  } else if (input.vision === 'on') {
    lines.push('');
    lines.push(
      'VISION ON: a bounded image crop is attached to this message. If it is missing, the model provider dropped it — fall back to the text above.'
    );
  }

  let text = lines.join('\n');
  if (text.length > MAX_TOTAL_CHARS)
    text = `${text.slice(0, MAX_TOTAL_CHARS)}\n[context truncated]`;
  return text;
}

/**
 * Screenshot-only areas (Canvas/WebGL/SVG) with Vision Off carry no visual
 * information at all. This explicit note is appended so the model does not
 * invent visual data.
 */
export function visionLimitNote(
  area: LadArea,
  regions: LadRegion[],
  vision: 'on' | 'off' | 'unknown'
): string | null {
  if (vision !== 'off') return null;
  const hasScreenshotOnly = area.regionIds.some((id) => {
    const region = regions.find((r) => r.id === id);
    return region
      ? region.anchors.length === 0 || region.diagnostics.some((d) => d.includes('Screenshot-only'))
      : false;
  });
  if (!hasScreenshotOnly) return null;
  return `Area "${area.name}" is Canvas/WebGL/SVG-only and Vision is OFF: the model receives coordinates and DOM context but no pixels. Ask the user for a screenshot or a Vision-capable model to analyze the visual content.`;
}
