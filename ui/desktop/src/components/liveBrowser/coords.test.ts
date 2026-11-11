/**
 * Unit tests for the Live Browser coordinate mapping (shared/coords.ts).
 *
 * Verifies the core invariant of region selection: a rectangle the user
 * drags on the screencast canvas maps to the correct DOCUMENT CSS px rect
 * that the agent receives, across viewport scale, scroll and DPR.
 */
import { describe, it, expect } from 'vitest';
import { displayToViewportScale, docToDisplay, displayToDoc } from '../../../live-browser/shared/coords';

describe('displayToViewportScale', () => {
  it('computes viewport/display scale', () => {
    expect(displayToViewportScale({ width: 500, height: 300 }, { width: 1280, height: 800 })).toBeCloseTo(2.56);
  });

  it('returns null when either side has no positive width', () => {
    expect(displayToViewportScale(null, { width: 1280, height: 800 })).toBeNull();
    expect(displayToViewportScale({ width: 0, height: 300 }, { width: 1280, height: 800 })).toBeNull();
    expect(displayToViewportScale({ width: 500, height: 300 }, null)).toBeNull();
  });
});

describe('docToDisplay', () => {
  const opts = { viewport: { width: 1280, height: 800 }, display: { width: 640, height: 400 }, scroll: { x: 0, y: 0 } };

  it('scales a document rect down to display size (2x here)', () => {
    const out = docToDisplay({ x: 100, y: 50, width: 200, height: 100 }, opts)!;
    expect(out).toEqual({ left: 50, top: 25, width: 100, height: 50 });
  });

  it('subtracts the scroll offset before scaling', () => {
    const scrolled = { ...opts, scroll: { x: 1000, y: 200 } };
    // doc point (1000, 200) is at the top-left of the viewport → (0,0) on screen
    const out = docToDisplay({ x: 1000, y: 200, width: 200, height: 100 }, scrolled)!;
    expect(out).toEqual({ left: 0, top: 0, width: 100, height: 50 });
  });

  it('returns null when the display is not measured', () => {
    expect(docToDisplay({ x: 0, y: 0, width: 10, height: 10 }, { ...opts, display: { width: 0, height: 0 } })).toBeNull();
  });
});

describe('displayToDoc', () => {
  const opts = { viewport: { width: 1280, height: 800 }, display: { width: 640, height: 400 }, scroll: { x: 0, y: 0 } };

  it('scales a display rect up to document size (2x here)', () => {
    const out = displayToDoc({ x: 50, y: 25 }, { x: 150, y: 75 }, opts)!;
    expect(out).toEqual({ x: 100, y: 50, width: 200, height: 100 });
  });

  it('normalizes corner order (bottom-right to top-left)', () => {
    const out = displayToDoc({ x: 150, y: 75 }, { x: 50, y: 25 }, opts)!;
    expect(out).toEqual({ x: 100, y: 50, width: 200, height: 100 });
  });

  it('adds the scroll offset back into document space', () => {
    const scrolled = { ...opts, scroll: { x: 1000, y: 200 } };
    const out = displayToDoc({ x: 0, y: 0 }, { x: 100, y: 50 }, scrolled)!;
    expect(out).toEqual({ x: 1000, y: 200, width: 200, height: 100 });
  });

  it('rejects degenerate drags (< 4px)', () => {
    expect(displayToDoc({ x: 10, y: 10 }, { x: 12, y: 11 }, opts)).toBeNull();
  });

  it('is the inverse of docToDisplay (round-trip)', () => {
    const doc = { x: 333, y: 777, width: 123, height: 89 };
    const onScreen = docToDisplay(doc, opts)!;
    const back = displayToDoc({ x: onScreen.left, y: onScreen.top }, { x: onScreen.left + onScreen.width, y: onScreen.top + onScreen.height }, opts)!;
    expect(back.x).toBe(doc.x);
    expect(back.y).toBe(doc.y);
    expect(back.width).toBe(doc.width);
    expect(back.height).toBe(doc.height);
  });
});
