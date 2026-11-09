import { expect, it, vi } from 'vitest';
import { revealWindow } from './windowActivation';
it.each([true, false])('reveals and focuses an existing window (minimized=%s)', (minimized) => {
  const window = { isMinimized: () => minimized, restore: vi.fn(), show: vi.fn(), focus: vi.fn() };
  revealWindow(window);
  expect(window.restore).toHaveBeenCalledTimes(minimized ? 1 : 0);
  expect(window.show).toHaveBeenCalledOnce();
  expect(window.focus).toHaveBeenCalledOnce();
  expect(window.show.mock.invocationCallOrder[0]).toBeLessThan(
    window.focus.mock.invocationCallOrder[0]
  );
});
