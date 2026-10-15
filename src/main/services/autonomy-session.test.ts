import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AutonomySessions } from './autonomy-session';
import { autonomyDescriptions, autonomyModes } from '../../shared/autonomy';
async function run() {
  const root = await mkdtemp(join(tmpdir(), 'autonomy-session-'));
  try {
    const sessions = new AutonomySessions();
    assert.deepEqual(sessions.get('chat'), { mode: 'strict', trusted_roots: [] });
    for (const mode of autonomyModes) {
      const p = await sessions.set('chat', mode, [root], false, async () => true);
      assert.equal(p.mode, mode); assert.deepEqual(p.trusted_roots, []);
      const info = autonomyDescriptions[mode]; assert(info.name && info.description && info.allowed && info.approval && info.risk);
    }
    assert.deepEqual(new AutonomySessions().get('chat'), { mode: 'strict', trusted_roots: [] }, 'Autopilot and trust never survive restart');
    await sessions.set('chat', 'trusted', [root], true, async () => false);
    assert.deepEqual(sessions.get('chat').trusted_roots, []);
    for (const legacy of ['trusted', 'absolute_autopilot'] as const) {
      const migrated = await sessions.set('chat', legacy, [root], false, async () => { throw new Error('No obsolete broad mode dialog'); });
      assert.equal(migrated.mode, 'autonomous'); assert.deepEqual(migrated.trusted_roots, []);
    }
    await sessions.set('chat', 'autonomous', [], false, async () => false);
    assert.deepEqual(sessions.get('chat').trusted_roots, [], 'Changing workspaces cannot carry trust');
    assert.deepEqual(sessions.get('other').trusted_roots, []);
    const copy = sessions.get('chat'); copy.mode = 'strict'; assert.equal(sessions.get('chat').mode, 'autonomous');
    console.log('Two visible modes, legacy normalization, no trust-folder grants, restart reset and conversation isolation passed.');
  } finally { await rm(root, { recursive: true, force: true }); }
}
void run();
