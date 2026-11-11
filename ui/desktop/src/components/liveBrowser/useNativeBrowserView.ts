/** Native lifetime follows visibility/chat, never individual pan/zoom updates. */
import { useLayoutEffect, useRef } from 'react';
export function useNativeBrowserView(
  id: string,
  settings: Record<string, unknown>,
  enabled: boolean,
  onError?: (message: string | null) => void
) {
  const ref = useRef<HTMLDivElement>(null);
  const latestSettings = useRef(settings);
  latestSettings.current = settings;
  const updateRef = useRef<(() => void) | null>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || !window.electron?.liveBrowserView) return;
    let cancelled = false,
      frame = 0;
    const update = () => {
      frame = 0;
      if (cancelled) return;
      const rect = element.getBoundingClientRect();
      // Renderer menus/popovers cannot stack over a native WebContentsView.
      // Live Browser menus use native Electron popups, so they
      // never cover this surface. Only a true modal may temporarily cover it.
      const modal = document.querySelector('[aria-modal="true"],dialog[open]');
      const covered = Boolean(
        modal &&
        (() => {
          const node = modal;
          const b = node.getBoundingClientRect();
          return (
            b.width &&
            b.height &&
            b.left < rect.right &&
            b.right > rect.left &&
            b.top < rect.bottom &&
            b.bottom > rect.top
          );
        })()
      );
      void window.electron
        .liveBrowserView(
          id,
          enabled && !covered && !document.hidden
            ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
            : null,
          latestSettings.current
        )
        .then(
          () => onError?.(null),
          (error) => onError?.(error instanceof Error ? error.message : String(error))
        );
    };
    updateRef.current = update;
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    const resize = new ResizeObserver(schedule);
    resize.observe(element);
    const modalSelector = '[aria-modal="true"],dialog[open]';
    const containsModal = (node: Node) =>
      node instanceof Element &&
      (node.matches(modalSelector) || Boolean(node.querySelector(modalSelector)));
    const mutation = new MutationObserver((records) => {
      const modalChanged = records.some((record) =>
        record.type === 'attributes'
          ? true
          : [...record.addedNodes, ...record.removedNodes].some(containsModal)
      );
      if (modalChanged) schedule();
    });
    mutation.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['aria-modal', 'open'],
    });
    window.addEventListener('resize', schedule);
    document.addEventListener('scroll', schedule, true);
    document.addEventListener('visibilitychange', schedule);
    update();
    return () => {
      cancelled = true;
      if (updateRef.current === update) updateRef.current = null;
      cancelAnimationFrame(frame);
      resize.disconnect();
      mutation.disconnect();
      window.removeEventListener('resize', schedule);
      document.removeEventListener('scroll', schedule, true);
      document.removeEventListener('visibilitychange', schedule);
      void window.electron.liveBrowserView(id, null, latestSettings.current).catch(() => undefined);
    };
  }, [id, enabled, onError]);
  useLayoutEffect(() => {
    updateRef.current?.();
  }, [settings]);
  return ref;
}
