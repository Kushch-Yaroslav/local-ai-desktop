import { app, dialog } from 'electron';

let failureReported = false;
let requestedExitCode = 0;

export function criticalMainProcessExitCode(): number {
  return requestedExitCode;
}

export function criticalMainProcessError(error: unknown): void {
  requestedExitCode = 1;
  if (failureReported) return;
  failureReported = true;

  const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  console.error('[Local AI Desktop] Critical main-process failure', error);
  try {
    dialog.showErrorBox('Local AI Desktop — ошибка запуска', `Критическая ошибка основного процесса:\n\n${detail}`);
  } catch (dialogError) {
    console.error('[Local AI Desktop] Could not show the startup error dialog', dialogError);
  }

  if (!app.isReady()) {
    app.exit(1);
    return;
  }

  app.quit();
  // A failed shutdown hook must not leave a windowless Electron process alive.
  setTimeout(() => app.exit(1), 15_000);
}
