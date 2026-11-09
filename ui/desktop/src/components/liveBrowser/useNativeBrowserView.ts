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
      const overlays = [
        ...document.querySelectorAll('[role="dialog"],[role="menu"],[role="listbox"]'),
      ];
      const covered = overlays.some((node) => {
        const b = node.getBoundingClientRect();
        return (
          b.width &&
          b.height &&
          b.left < rect.right &&
          b.right > rect.left &&
          b.top < rect.bottom &&
          b.bottom > rect.top
        );
      });
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
    const mutation = new MutationObserver(schedule);
    mutation.observe(document.body, { childList: true, subtree: true });
    window.addEventListener('resize', schedule);
    document.addEventListener('visibilitychange', schedule);
    update();
    return () => {
      cancelled = true;
      if (updateRef.current === update) updateRef.current = null;
      cancelAnimationFrame(frame);
      resize.disconnect();
      mutation.disconnect();
      window.removeEventListener('resize', schedule);
      document.removeEventListener('visibilitychange', schedule);
      void window.electron.liveBrowserView(id, null, latestSettings.current).catch(() => undefined);
    };
  }, [id, enabled, onError]);
  useLayoutEffect(() => {
    updateRef.current?.();
  }, [settings]);
  return ref;
}
