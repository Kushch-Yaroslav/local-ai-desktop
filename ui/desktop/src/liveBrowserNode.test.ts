/** Local AI Desktop: reproduce the Ubuntu menu Node 18 regression. */
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { probeLiveBrowserNode } from './liveBrowserNode';

describe('Live Browser Node selection', () => {
  it('accepts the pinned development Node', async () => {
    expect(await probeLiveBrowserNode(process.execPath, {})).toBe(true);
  });
  it('rejects a missing executable', async () => {
    expect(await probeLiveBrowserNode('/no-such-live-browser-node', {})).toBe(false);
  });
  const systemNode = '/usr/bin/node';
  const oldSystemNode = existsSync(systemNode) && Number(spawnSync(systemNode, ['-p', 'process.versions.node.split(".")[0]'], {encoding:'utf8'}).stdout) < 20;
  it.skipIf(!oldSystemNode)('rejects the Ubuntu Node 18 that starts successfully but cannot run Playwright', async () => {
    expect(spawnSync(systemNode, ['-e', 'process.exit(0)']).status).toBe(0);
    expect(await probeLiveBrowserNode(systemNode, {})).toBe(false);
  });
});
