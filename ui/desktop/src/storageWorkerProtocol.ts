// Local AI Desktop: bounded control-plane metadata; no chat contents or file manifest here.
import fs from 'node:fs';
import type { StorageChoice } from './storageTypes';
import type { StorageEnvironment } from './storageService';
export interface StorageWorkerRequest {
  version: 1;
  environment: StorageEnvironment;
  operation: 'apply' | 'rollback';
  choice?: StorageChoice;
  parentPid: number;
  parentIdentity: string;
  workerPid?: number;
  workerIdentity?: string;
  launchArgs: string[];
}
export function processIdentity(pid: number) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return ['Z', 'X'].includes(fields[0]) ? '' : fields[19];
  } catch {
    return '';
  }
}
export function requestIsActive(r: StorageWorkerRequest) {
  return (
    !!(r.workerPid && r.workerIdentity && processIdentity(r.workerPid) === r.workerIdentity) ||
    !!(r.parentIdentity && processIdentity(r.parentPid) === r.parentIdentity)
  );
}
export function readWorkerRequest(file: string): StorageWorkerRequest | undefined {
  if (!fs.existsSync(file)) return;
  if (fs.statSync(file).size > 1024 * 1024) throw new Error('Invalid storage maintenance request');
  const r = JSON.parse(fs.readFileSync(file, 'utf8')) as StorageWorkerRequest;
  if (
    r.version !== 1 ||
    !r.environment?.configHome ||
    !['apply', 'rollback'].includes(r.operation) ||
    !Array.isArray(r.launchArgs)
  )
    throw new Error('Invalid storage maintenance request');
  return r;
}
