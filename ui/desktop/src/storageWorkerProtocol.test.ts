import { describe, it, expect } from 'vitest';
import { processIdentity, requestIsActive } from './storageWorkerProtocol';
import type { StorageWorkerRequest } from './storageWorkerProtocol';
it('recognizes only the original live process identity, avoiding PID reuse locks', () => {
  const r = {
    parentPid: process.pid,
    parentIdentity: processIdentity(process.pid),
  } as StorageWorkerRequest;
  expect(requestIsActive(r)).toBe(true);
  expect(requestIsActive({ ...r, parentIdentity: 'old-process' })).toBe(false);
  expect(requestIsActive({ ...r, parentPid: 99999999 })).toBe(false);
});
describe('maintenance ownership', () => {
  it('blocks startup while the helper is alive even after the parent exits', () => {
    const r = {
      parentPid: 99999999,
      parentIdentity: 'old',
      workerPid: process.pid,
      workerIdentity: processIdentity(process.pid),
    } as StorageWorkerRequest;
    expect(requestIsActive(r)).toBe(true);
  });
});
