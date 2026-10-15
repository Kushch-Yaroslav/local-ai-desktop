import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReadonlyProjectTools, TerminalTools } from './project-tools';
import { projectPath } from './project-path';

async function main() {
  const root = await mkdtemp(join(tmpdir(), 'agent-tool-security-'));
  try {
    const project = join(root, 'project'); const outside = join(root, 'outside');
    await mkdir(join(project, '.git/refs/heads'), { recursive: true }); await mkdir(outside);
    await writeFile(join(project, '.git/HEAD'), 'original'); await writeFile(join(project, 'source'), 'working');
    await symlink(join(project, '.git'), join(project, 'alias')); await symlink(outside, join(project, 'outside'));
    const signal = new AbortController().signal;
    const tools = await ReadonlyProjectTools.open(project, async () => ({ approved: false, reason: 'user_rejected' }));
    const execute = async (name: string, args: Record<string, unknown>) => JSON.parse(await tools.execute({ name, arguments: args }, signal, 'action'));
    for (const path of ['.git/HEAD', 'alias/HEAD', 'outside/file', '../outside/file']) {
      for (const name of ['write_file', 'create_file', 'delete_file']) assert.equal((await execute(name, { path, content: 'bad' })).code, 'PERMISSION_DENIED');
    }
    assert.equal((await execute('apply_patch', { patch: '*** Begin Patch\n*** Add File: innocent\n+new\n*** Delete File: .git/HEAD\n*** End Patch' })).code, 'PERMISSION_DENIED');
    assert(! (await readdir(project)).includes('innocent'));
    assert.equal((await execute('delete_file', { path: 'source' })).reason, 'user_rejected');
    assert.equal(await readFile(join(project, 'source'), 'utf8'), 'working');
    assert.equal((await execute('apply_patch', { patch: '*** Begin Patch\n*** Update File: source\n@@\n-working\n+replacement\n*** Delete File: source\n*** End Patch' })).reason, 'user_rejected');
    assert.equal(await readFile(join(project, 'source'), 'utf8'), 'working');
    const written = await execute('apply_patch', { patch: '*** Begin Patch\n*** Update File: source\n@@\n-working\n+replacement\n*** End Patch' });
    assert(written.applied); assert.equal(await readFile(join(written.backups[0], 'original'), 'utf8'), 'working');
    const malformed = await execute('apply_patch', { patch: '*** Begin Patch\n*** Add File: innocent\n+new\n*** Update File: source\n@@\n-wrong\n+bad\n*** End Patch' });
    assert(malformed.error); assert(! (await readdir(project)).includes('innocent'));
    const terminal = await TerminalTools.open(project, async () => ({ approved: false, reason: 'user_rejected' }));
    for (const command of ['git switch -c denied', 'git diff', 'git show HEAD', 'git log --patch', 'xargs -Igit git status', 'nvidia-smi -r', 'python3 -c "print(1)"', 'npm run build', 'sort -o.git/HEAD source', `cat ${join(outside, 'file')}`]) {
      const result = JSON.parse(await terminal.execute({ name: 'run_terminal', arguments: { command } }, signal, 'command'));
      assert.equal(result.code, 'PERMISSION_DENIED', command);
    }
    const list = await execute('list_directory', { path: '.' }); assert(list.entries.includes('source'));
    assert((await execute('read_file', { path: 'source' })).content.includes('replacement'));
    await rm(join(project, '.git'), { recursive: true }); await mkdir(join(project, 'metadata'));
    await writeFile(join(project, '.git'), 'gitdir: metadata\n');
    await assert.rejects(projectPath(project, 'metadata/HEAD', true), /Git worktree/);
    await mkdir(join(project, 'metadata/worktrees/linked'), { recursive: true });
    await writeFile(join(project, '.git'), 'gitdir: metadata/worktrees/linked\n');
    await writeFile(join(project, 'metadata/worktrees/linked/commondir'), '../..\n');
    await assert.rejects(projectPath(project, 'metadata/refs/heads/main', true), /Shared Git/);
    const approved = await ReadonlyProjectTools.open(project, async () => ({ approved: true, reason: 'once' }));
    const deleted = JSON.parse(await approved.execute({ name: 'delete_file', arguments: { path: 'source' } }, signal, 'delete'));
    assert(deleted.deleted); assert.equal(await readFile(join(deleted.backup, 'original'), 'utf8'), 'replacement');
    console.log('Legacy tools: canonical scope, metadata/symlink protection, denied terminal/delete/patch, staged patch validation, recovery, read/list compatibility passed.');
  } finally { await rm(root, { recursive: true, force: true }); }
}
void main();
