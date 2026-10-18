import { createHash } from 'node:crypto';
import { opendir, lstat, open, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, extname, relative, sep } from 'node:path';
import type { BrowserQaReport } from '../../shared/browser-qa';

export const qaHash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const ignored = new Set(['node_modules', 'vendor', 'coverage', 'tmp', 'temp', '__pycache__']);
const extensions = new Set(['.html','.htm','.css','.js','.mjs','.cjs','.ts','.tsx','.jsx','.json','.svg','.glsl','.wgsl','.png','.jpg','.jpeg','.webp','.ico','.woff','.woff2']);
/** Content, not mtime. Bounded, symlink-free reads confined to the approved project. */
export async function projectRevision(root: string, exclude: string[] = []): Promise<string> {
  const base = await realpath(root), hash = createHash('sha256');
  let entries = 0, bytes = 0;
  const visit = async (directory: string) => {
    const listing = await opendir(directory); const children = [];
    for await (const entry of listing) children.push(entry);
    children.sort((a,b) => a.name.localeCompare(b.name));
    for (const entry of children) {
      if (++entries > 50000) throw new Error('QA revision scan exceeds 50000 entries');
      if (entry.name.startsWith('.') || ignored.has(entry.name) || entry.isSymbolicLink()) continue;
      const path = join(directory, entry.name), info = await lstat(path);
      if (exclude.some(excluded => path === excluded || path.startsWith(excluded + sep))) continue;
      if (info.isSymbolicLink()) continue;
      if (entry.isDirectory()) { if (await realpath(path) === path) await visit(path); continue; }
      if (!entry.isFile() || !extensions.has(extname(path).toLowerCase())) continue;
      if (info.size > 4*1024*1024 || (bytes += info.size) > 32*1024*1024) throw new Error('QA revision scan exceeds 32 MiB source budget');
      const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const actual = await realpath(`/proc/self/fd/${file.fd}`), rel = relative(base, actual);
        if (rel === '..' || rel.startsWith(`..${sep}`) || rel.startsWith(sep) || rel.split(sep).some(part => part.startsWith('.'))) throw new Error('QA source escaped approved project');
        const stat = await file.stat(); if (!stat.isFile() || stat.size > 4*1024*1024) throw new Error('QA source is not a bounded regular file');
        // A fixed-size read cannot grow without bound during a concurrent edit.
        const data = Buffer.alloc(stat.size + 1), read = await file.read(data, 0, data.length, 0);
        if (read.bytesRead > stat.size) throw new Error('QA source changed during revision scan; retry after edit settles');
        hash.update(rel).update('\0').update(data.subarray(0, read.bytesRead)).update('\0');
      } finally { await file.close(); }
    }
  };
  await visit(base); return hash.digest('hex');
}

type Observation = { key: string; outcome: string; report: BrowserQaReport; repeats: number };
/** A bounded observation window, never a work allowance. Share across browser reopen. */
export class QaLoopGuard {
  private readonly observations = new Map<string, Observation>();
  private lastState?: string;
  private stateEpoch = 0;
  private authorizationEpoch = 0;
  rearm() { this.observations.clear(); this.lastState = undefined; this.stateEpoch++; }
  authorized() { this.authorizationEpoch++; }
  reopened(state: unknown) { this.lastState = qaHash(state); }
  key(revision: string, url: string, scenario: unknown, state: unknown, runtime: unknown) {
    const current = qaHash(state);
    // Changes caused by the preceding check are not new external progress.
    if (this.lastState !== undefined && current !== this.lastState) this.stateEpoch++;
    this.lastState = current;
    const normalizedScenario = Array.isArray(scenario) ? scenario.map(step => ({...step, ...(step.selector ? {selector:step.selector.trim()} : {}), ...(step.action === 'hold' ? {duration_ms:Math.round((step.duration_ms ?? 300)/50)*50} : {}), ...(step.action === 'key' ? {repeat:step.repeat ?? 1} : {})})) : scenario;
    return qaHash({ revision, url, scenario:normalizedScenario, stateEpoch: this.stateEpoch, authorization: this.authorizationEpoch, runtime });
  }
  before(key: string) {
    const old = this.observations.get(key);
    if (!old || old.repeats < 2) return undefined;
    return { error: 'Browser QA repeated the same scenario and outcome without source, state, permission or runtime progress.', code: 'QA_NO_PROGRESS', retrySameArguments: false,
      loop: { key, repeats: old.repeats, previousEvidence: old.report.evidencePath, previousReportId: old.report.id, previousStatus: old.report.status },
      guidance: 'Keep the existing evidence. Fix the observed defect, change the expected behaviour or scenario meaningfully, or continue other task work. Do not use fill on body, add hidden inputs, relaunch the browser or invoke terminal browsers to bypass this blocker. Keyboard testing uses key/down/up/hold actions. An explicit user continuation can request a fresh observation window.' };
  }
  record(key: string, report: BrowserQaReport, state: unknown) {
    const outcome = qaHash({ status: report.status, checks: report.checks.map(check => ({ action: check.action, expected: check.expected, status: check.status, ...(check.status === 'Failed' && !['canvas animation','canvas render','canvas input delivery'].includes(check.action) ? { actual: check.actual } : {}) })), errors: report.errors, visual: { status: report.visual.status, analyzed:report.visual.analyzed, severities:report.visual.issues?.map(issue=>issue.severity).sort() } });
    const old = this.observations.get(key);
    this.observations.delete(key);
    this.observations.set(key, { key, outcome, report, repeats: old?.outcome === outcome ? old.repeats + 1 : 1 });
    while (this.observations.size > 128) this.observations.delete(this.observations.keys().next().value!);
    this.lastState = qaHash(state);
  }
}
