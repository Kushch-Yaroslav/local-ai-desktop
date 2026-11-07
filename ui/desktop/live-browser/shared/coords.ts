/**
 * Live Browser — coordinate mapping (pure, testable).
 *
 * The Live Browser panel displays the agent's Playwright Page via a CDP
 * screencast. Three coordinate spaces are involved:
 *
 * 1. DOCUMENT CSS px  — the page's document space (window.scrollX/Y + viewport).
 *    Region rects and DOM anchors are stored here (see types.ts contract).
 * 2. VIEWPORT CSS px  — the Playwright viewport at capture time.
 *    `doc - scroll = viewport point` (both CSS px, same scale).
 * 3. DISPLAY px       — the on-screen size of the screencast canvas.
 *    The captured frame is the full viewport (dpr*zoom are applied inside
 *    the capture and then cancelled by CSS scaling of the canvas), so the
 *    mapping between viewport CSS px and display px is a uniform scale:
 *
 *        scale = displayWidth / viewportWidth
 *
 * These helpers are shared by the renderer overlay (SelectionOverlay) so the
 * "user's rectangle on screen → document rect the agent receives" path has a
 * single, unit-tested implementation.
 */

export interface LadSize {
  width: number;
  height: number;
}

export interface LadPoint {
  x: number;
  y: number;
}

export interface LadRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Display px → viewport CSS px scale factor.
 * Returns null when either side has no positive width (canvas not measured).
 */
export function displayToViewportScale(display: LadSize | null | undefined, viewport: LadSize | null | undefined): number | null {
  if (!display || !viewport) return null;
  if (display.width <= 0 || viewport.width <= 0) return null;
  return viewport.width / display.width;
}

/**
 * Map a document-space rect to display (canvas) coordinates.
 * Returns null when the mapping cannot be computed.
 */
export function docToDisplay(
  doc: LadRect,
  opts: { viewport: LadSize; display: LadSize; scroll: LadPoint },
): { left: number; top: number; width: number; height: number } | null {
  const scale = displayToViewportScale(opts.display, opts.viewport);
  if (scale === null) return null;
  const inv = 1 / scale; // display px per viewport css px
  return {
    left: (doc.x - opts.scroll.x) * inv,
    top: (doc.y - opts.scroll.y) * inv,
    width: doc.width * inv,
    height: doc.height * inv,
  };
}

/**
 * Map two display-space corners (a drag rectangle) to a document-space rect.
 * Returns null when the drag is degenerate or the mapping cannot be computed.
 */
export function displayToDoc(
  a: LadPoint,
  b: LadPoint,
  opts: { viewport: LadSize; display: LadSize; scroll: LadPoint },
): LadRect | null {
  const scale = displayToViewportScale(opts.display, opts.viewport);
  if (scale === null) return null;
  const x0 = Math.min(a.x, b.x);
  const y0 = Math.min(a.y, b.y);
  const w = Math.abs(a.x - b.x);
  const h = Math.abs(a.y - b.y);
  if (w < 4 || h < 4) return null;
  return {
    x: Math.round(x0 * scale + opts.scroll.x),
    y: Math.round(y0 * scale + opts.scroll.y),
    width: Math.round(w * scale),
    height: Math.round(h * scale),
  };
}
