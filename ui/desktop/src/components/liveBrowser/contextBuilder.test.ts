/**
 * Unit tests for the Live Browser agent context builder (shared/context.ts).
 *
 * This is the critical "pass a selection to the agent" path: the model must
 * receive bounded, structured, honest context (URL, geometry, DOM anchors,
 * diagnostics) that works with Vision Off, and an explicit limitation note
 * for Canvas/SVG-only regions instead of invented visual data.
 */
import { describe, it, expect } from 'vitest';
import { buildAreaContextText, visionLimitNote } from '../../../live-browser/shared/context';
import type { LadArea, LadAnchor, LadRegion } from '../../../live-browser/shared/types';

function makeRegion(overrides: Partial<LadRegion> = {}): LadRegion {
  return {
    id: 'region-1',
    conversationId: 'conv-1',
    areaId: 'area-1',
    url: 'https://example.com/page',
    route: '/page',
    viewport: { width: 1280, height: 800 },
    dpr: 2,
    scroll: { x: 0, y: 0 },
    rect: { x: 120, y: 240, width: 320, height: 160 },
    anchors: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    snapshot: '{}',
    diagnostics: [],
    events: [],
    ...overrides,
  };
}

function makeArea(overrides: Partial<LadArea> = {}): LadArea {
  return {
    id: 'area-1',
    conversationId: 'conv-1',
    name: 'Header layout',
    description: 'Fix the misaligned header',
    status: 'Detected',
    regionIds: ['region-1'],
    number: 1,
    color: '#f00',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    events: [],
    ...overrides,
  };
}

describe('buildAreaContextText', () => {
  it('includes the header, area name/status and the document rect', () => {
    const area = makeArea();
    const region = makeRegion();
    const text = buildAreaContextText({ areas: [area], regions: [region], vision: 'off' });
    expect(text).toContain('[Local AI Desktop — Live Browser selection]');
    expect(text).toContain('Area 1 — "Header layout" [Detected] (id: area-1)');
    expect(text).toContain('Task: Fix the misaligned header');
    expect(text).toContain('Page URL: https://example.com/page');
    expect(text).toContain('x=120 y=240 w=320 h=160');
    expect(text).toContain('1280x800');
  });

  it('reports viewport, DPR and scroll context', () => {
    const region = makeRegion({ scroll: { x: 100, y: 250 }, dpr: 1.5 });
    const text = buildAreaContextText({ areas: [makeArea()], regions: [region], vision: 'off' });
    expect(text).toMatch(/DPR 1\.5/);
    expect(text).toContain('scroll (100, 250)');
  });

  it('includes DOM anchors with selector, styles and confidence when present', () => {
    const region = makeRegion({
      anchors: [
        {
          tag: 'div',
          selector: 'div.header > h1',
          text: 'Welcome',
          classes: ['header'],
          rect: { x: 130, y: 250, width: 300, height: 40 },
          confidence: 0.95,
          diagnostics: [],
          styles: { display: 'flex', 'font-size': '32px' },
        },
      ],
    });
    const text = buildAreaContextText({ areas: [makeArea()], regions: [region], vision: 'off' });
    expect(text).toContain('<div> selector="div.header > h1"');
    expect(text).toContain('text="Welcome"');
    expect(text).toContain('display:flex');
    expect(text).toContain('0.95');
  });

  it('explicitly says there is no DOM anchor for screenshot-only regions', () => {
    const region = makeRegion({
      anchors: [],
      diagnostics: ['Screenshot-only Canvas/SVG region; no source mapping'],
    });
    const text = buildAreaContextText({ areas: [makeArea()], regions: [region], vision: 'off' });
    expect(text).toContain('Anchor: none — screenshot-only region');
    expect(text).toContain('Screenshot-only Canvas/SVG region; no source mapping');
  });

  it('states an explicit root and defers missing project information to the authoritative host scope', () => {
    const withProject = buildAreaContextText({
      areas: [makeArea()],
      regions: [makeRegion()],
      project: { root: '/home/u/myapp', name: 'myapp' },
      vision: 'off',
    });
    expect(withProject).toContain('Project: "myapp" /home/u/myapp');

    const withoutProject = buildAreaContextText({
      areas: [makeArea()],
      regions: [makeRegion()],
      vision: 'off',
    });
    expect(withoutProject).toContain('Project: consult the bound Goose session scope.');
  });

  it('adds a VISION OFF note and a VISION ON note respectively', () => {
    const off = buildAreaContextText({
      areas: [makeArea()],
      regions: [makeRegion()],
      vision: 'off',
    });
    expect(off).toContain('VISION OFF: no image was sent for this selection');
    const on = buildAreaContextText({ areas: [makeArea()], regions: [makeRegion()], vision: 'on' });
    expect(on).toContain('VISION ON: a bounded image crop is attached');
  });

  it('reflects a stale live binding and a valid live binding', () => {
    const stale = makeRegion({
      live: {
        url: 'https://example.com/page',
        viewport: { width: 1280, height: 800 },
        dpr: 2,
        scroll: { x: 0, y: 0 },
        stale: true,
        reason: 'selector-not-found',
        observedAt: '2026-01-02T00:00:00.000Z',
      },
    });
    const staleText = buildAreaContextText({
      areas: [makeArea()],
      regions: [stale],
      vision: 'off',
    });
    expect(staleText).toContain('binding STALE (selector-not-found)');

    const valid = makeRegion({
      live: {
        url: 'https://example.com/page',
        viewport: { width: 1280, height: 800 },
        dpr: 2,
        scroll: { x: 0, y: 0 },
        stale: false,
        observedAt: '2026-01-02T00:00:00.000Z',
      },
    });
    const validText = buildAreaContextText({
      areas: [makeArea()],
      regions: [valid],
      vision: 'off',
    });
    expect(validText).toContain('binding still valid');
  });

  it('includes region history events when present', () => {
    const region = makeRegion({
      events: [
        { at: '2026-01-01T00:00:01.000Z', source: 'agent', action: 'click', status: 'Fixed' },
      ],
    });
    const text = buildAreaContextText({ areas: [makeArea()], regions: [region], vision: 'off' });
    expect(text).toContain('History: click → Fixed');
  });

  it('redacts credentials in the page URL', () => {
    const region = makeRegion({ url: 'https://example.com/api?api_key=SECRET&token=TOK123' });
    const text = buildAreaContextText({ areas: [makeArea()], regions: [region], vision: 'off' });
    expect(text).not.toContain('SECRET');
    expect(text).not.toContain('TOK123');
    expect(text).toContain('redacted');
  });

  it('truncates very large context to the bounded size', () => {
    // The builder caps at 4 areas × 3 regions × 2 anchors, so push the bound
    // by giving every allowed anchor long text/styles/findings.
    const longAnchor = (i: number): LadAnchor => ({
      tag: 'div',
      selector: `div.item-${i}`.padEnd(80, 'x'),
      text: 'x'.repeat(120),
      classes: [],
      rect: { x: i, y: i, width: 10, height: 10 },
      confidence: 0.9,
      diagnostics: [],
      styles: { 'long-property-name': 'y'.repeat(400) },
      findings: [
        { category: 'text-clipping', fact: 'z'.repeat(200), candidate: true },
        { category: 'element-overlap', fact: 'w'.repeat(200), candidate: false },
      ],
    });
    const regions: LadRegion[] = [];
    const areas: LadArea[] = [];
    for (let a = 0; a < 4; a++) {
      const regionIds: string[] = [];
      for (let r = 0; r < 3; r++) {
        const id = `region-${a}-${r}`;
        regions.push(
          makeRegion({ id, anchors: [longAnchor(a * 10 + r * 2), longAnchor(a * 10 + r * 2 + 1)] })
        );
        regionIds.push(id);
      }
      areas.push(makeArea({ id: `area-${a}`, number: a + 1, regionIds }));
    }
    const text = buildAreaContextText({ areas, regions, vision: 'off' });
    expect(text.length).toBeLessThanOrEqual(12_000 + 25);
    expect(text).toContain('[context truncated]');
  });
});

describe('visionLimitNote', () => {
  it('returns a note only for screenshot-only areas with Vision Off', () => {
    const area = makeArea();
    const screenshotOnly = makeRegion({
      anchors: [],
      diagnostics: ['Screenshot-only Canvas/SVG region; no source mapping'],
    });
    expect(visionLimitNote(area, [screenshotOnly], 'off')).toContain('Vision is OFF');
    expect(visionLimitNote(area, [screenshotOnly], 'on')).toBeNull();
    expect(visionLimitNote(area, [screenshotOnly], 'unknown')).toBeNull();
  });

  it('returns null when the region has a DOM anchor', () => {
    const area = makeArea();
    const withAnchor = makeRegion({
      anchors: [
        {
          tag: 'div',
          selector: 'div.x',
          text: '',
          classes: [],
          rect: { x: 0, y: 0, width: 1, height: 1 },
          confidence: 0.9,
          diagnostics: [],
          styles: {},
        },
      ],
    });
    expect(visionLimitNote(area, [withAnchor], 'off')).toBeNull();
  });
});
