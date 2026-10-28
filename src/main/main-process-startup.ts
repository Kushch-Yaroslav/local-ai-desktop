export type MainProcessFailureEvent = 'uncaughtException' | 'unhandledRejection';

export function installCriticalProcessHandlers(
  register: (event: MainProcessFailureEvent, handler: (error: unknown) => void) => void,
  handler: (error: unknown) => void,
): void {
  register('uncaughtException', handler);
  register('unhandledRejection', handler);
}

export async function loadMainEntry(
  load: () => Promise<unknown>,
  onFailure: (error: unknown) => void,
): Promise<void> {
  try {
    await load();
  } catch (error) {
    onFailure(error);
  }
}
