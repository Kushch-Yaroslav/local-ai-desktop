// Local AI Desktop: make Dock/second-instance activation reveal a hidden window.
export function revealWindow(window: {
  isMinimized(): boolean;
  restore(): void;
  show(): void;
  focus(): void;
}) {
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}
