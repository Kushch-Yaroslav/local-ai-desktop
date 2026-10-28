import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import afterPack from '../packaging/after-pack.mjs';

const root = await mkdtemp(join(tmpdir(), 'lad-after-pack-'));
const project = join(root, 'source');
const appOutDir = join(root, 'app');
try {
  const createFile = async (path, content = '') => {
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, content);
  };
  await createFile(join(project, 'package.json'), JSON.stringify({ version: '0.3.0', homepage: 'https://example.invalid/local-ai-desktop' }));
  await createFile(join(project, 'node_modules/electron/dist/chrome-sandbox'));
  for (const name of ['local-ai-desktop', 'local-ai-desktop-bwrap']) {
    await createFile(join(project, 'assets/apparmor', name));
    await createFile(join(appOutDir, 'resources/app/assets/apparmor', name));
  }
  for (const name of ['README.md', 'README.ru.md', 'CHANGELOG.md']) await createFile(join(appOutDir, 'resources/app', name), 'Release documentation.');
  await createFile(join(project, 'docs/reference.md'), 'Release source');
  await createFile(join(appOutDir, 'resources/app/docs/en/guide.md'), '[Source reference](../reference.md). [Saved test log](../test-results/run.log).');

  await afterPack({ appOutDir, packager: { projectDir: project } });

  const guide = await readFile(join(appOutDir, 'resources/app/docs/en/guide.md'), 'utf8');
  assert(guide.includes('https://example.invalid/local-ai-desktop/blob/v0.3.0/docs/reference.md'));
  assert(guide.includes('Saved test log.'));
  assert(!guide.includes('](../test-results/run.log)'));
  console.log('after-pack rewrites packaged source links and removes links to excluded local evidence');
} finally {
  await rm(root, { recursive: true, force: true });
}
