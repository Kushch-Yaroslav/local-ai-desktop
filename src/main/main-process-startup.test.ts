import assert from 'node:assert/strict';
import { installCriticalProcessHandlers, loadMainEntry, type MainProcessFailureEvent } from './main-process-startup';

const handlers = new Map<MainProcessFailureEvent, (error: unknown) => void>();
const failures: unknown[] = [];
installCriticalProcessHandlers((event, handler) => handlers.set(event, handler), error => failures.push(error));
assert.deepEqual([...handlers.keys()], ['uncaughtException', 'unhandledRejection']);

void (async () => {
  const dependencyFailure = new Error("Cannot find module 'broken-runtime-dependency'");
  await loadMainEntry(() => Promise.reject(dependencyFailure), error => failures.push(error));
  assert.equal(failures[0], dependencyFailure, 'an entry dependency failure reaches the fatal handler');
  handlers.get('uncaughtException')?.(new Error('uncaught main-process failure'));
  handlers.get('unhandledRejection')?.(new Error('unhandled startup promise'));
  assert.equal(failures.length, 3, 'uncaught exceptions and unhandled rejections are routed to the fatal handler');
  console.log('Main-process startup failure handling: entry-load rejection and process-level failures passed.');
})();
