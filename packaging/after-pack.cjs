const { copyFile, chmod, access, rm, mkdir, readdir, readFile, writeFile, lstat } = require('node:fs/promises');
const path = require('node:path');
const { join } = require('node:path');
module.exports = async ({ appOutDir, packager }) => {
  // A dev launch may retire npm's adjacent helper. Both clean npm ci and an
  // already-used checkout must package the same vendor helper without SUID bits.
  const source = join(packager.projectDir, 'node_modules/electron/dist');
  const target = join(appOutDir, 'chrome-sandbox');
  let helper = join(source, 'chrome-sandbox');
  try { await access(helper); } catch { helper = join(source, 'chrome-sandbox.disabled'); }
  await copyFile(helper, target);
  await chmod(target, 0o755);
  await rm(join(appOutDir, 'chrome-sandbox.disabled'), { force: true });
  // FPM mappings outside /opt need deterministic conffile modes regardless of
  // the developer's umask. The security policy itself is copied byte-for-byte.
  const stage = join(packager.projectDir, 'release/policy-stage');
  await mkdir(stage, { recursive: true });
  const app = join(appOutDir, 'resources/app');
  for (const name of ['local-ai-desktop', 'local-ai-desktop-bwrap']) {
    await copyFile(join(packager.projectDir, 'assets/apparmor', name), join(stage, name));
    await chmod(join(stage, name), 0o644);
    await chmod(join(app, 'assets/apparmor', name), 0o644);
  }
  // Keep all public Markdown/images offline. Source-code audit links use the
  // release tag online rather than becoming broken paths inside the package.
  const metadata = JSON.parse(await readFile(join(packager.projectDir, 'package.json'), 'utf8'));
  const rewrite = async file => {
    const original = await readFile(file, 'utf8');
    const matches = [...original.matchAll(/(!?\[[^\]]*\]\()(<[^>]+>|[^)]+)(\))/g)];
    let text = original;
    for (const match of matches) {
      const target = match[2].replace(/^<|>$/g, '');
      if (/^[a-z][a-z0-9+.-]*:|^#/i.test(target)) continue;
      const [relative, fragment] = target.split('#');
      const dest = path.resolve(path.dirname(file), relative);
      try { await access(dest); continue; } catch { /* source-only reference */ }
      const repoPath = path.relative(app, dest);
      if (repoPath.startsWith('..') || path.isAbsolute(repoPath)) throw Error(`Unsafe documentation link: ${target}`);
      await access(join(packager.projectDir, repoPath));
      const url = `${metadata.homepage}/blob/v${metadata.version}/${repoPath.split(path.sep).map(encodeURIComponent).join('/')}${fragment ? '#'+fragment : ''}`;
      text = text.replace(match[0], match[1]+url+match[3]);
    }
    if (text !== original) await writeFile(file, text);
  };
  const walk = async directory => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) await walk(join(directory, entry.name));
      else if (entry.name.endsWith('.md')) await rewrite(join(directory, entry.name));
    }
  };
  await walk(join(app, 'docs'));
  for (const name of ['README.md','README.ru.md','CHANGELOG.md']) await rewrite(join(app, name));
  const normalizeModes = async directory => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) await normalizeModes(file);
      await chmod(file, (await lstat(file)).mode & 0o777 & ~0o022);
    }
  };
  await normalizeModes(appOutDir);
};
