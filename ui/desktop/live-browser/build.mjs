import { build } from 'esbuild';
import { copyFileSync, existsSync, mkdirSync, chmodSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';

const root = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// playwright-core loads browsers.json (and package.json) as data files
// relative to its own directory; once inlined into our bundle those relative
// loads resolve against the runtime dir, so we ship them there.
{
  const pwRoot = dirname(require.resolve('playwright-core'));
  const browsersJson = join(pwRoot, 'browsers.json');
  if (existsSync(browsersJson)) copyFileSync(browsersJson, join(root, 'browsers.json'));
}

// The runtime is spawned by the Electron main process as a plain Node script.
// In the packaged app the Electron binary cannot run as Node (RunAsNode fuse
// is disabled) and the app has no guaranteed node_modules next to it, so the
// bundle is fully self-contained: playwright-core, the MCP SDK and zod are
// inlined. Only `node:` builtins stay external.
const noSourcemap = process.env.LIVE_BROWSER_NO_SOURCEMAP === '1';

await build({
  entryPoints: [join(root, 'runtime', 'main.ts')],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  outfile: join(root, 'dist', 'live-browser.js'),
  sourcemap: !noSourcemap,
  logLevel: 'warning',
  // chromium-bidi: only required lazily by playwright's BiDi-over-CDP path,
  // which this runtime never uses (plain CDP + screencast).
  // fsevents: chokidar's macOS watcher native module, wrapped in try/catch by
  // chokidar itself and unused by this runtime.
  external: ['node:*', 'chromium-bidi', 'chromium-bidi/*', 'fsevents'],
});

// Preserve Playwright's packageRoot = __dirname/.. in packaged runtime.
const staged = join(root, 'dist', 'live-browser');
mkdirSync(join(staged, 'dist'), { recursive: true });
copyFileSync(join(root, 'dist', 'live-browser.js'), join(staged, 'dist', 'live-browser.js'));
copyFileSync(join(root, 'browsers.json'), join(staged, 'browsers.json'));
copyFileSync(join(root, 'package.json'), join(staged, 'package.json'));
// GUI sessions need no system Node, package manager, or network bootstrap.
// For cross packaging provide a target-platform Node distribution explicitly.
const targetPlatform = process.env.LAD_LB_TARGET_PLATFORM || process.platform;
const targetArch = process.env.LAD_LB_TARGET_ARCH || process.arch;
const nativeTarget = targetPlatform === process.platform && targetArch === process.arch;
const nodeBinary = process.env.LAD_LB_NODE_BUNDLE || (nativeTarget ? process.execPath : '');
if (!nodeBinary) throw new Error('Cross packaging requires LAD_LB_NODE_BUNDLE for the target platform/architecture');
if (nativeTarget) {
  const info = nodeBinary === process.execPath
    ? {version:process.versions.node,arch:process.arch,platform:process.platform}
    : JSON.parse(execFileSync(nodeBinary, ['-p', 'JSON.stringify({version:process.versions.node,arch:process.arch,platform:process.platform})'], {encoding:'utf8'}));
  if (Number(info.version.split('.')[0]) < 20 || info.platform !== targetPlatform || info.arch !== targetArch) {
    throw new Error('Live Browser bundle requires a compatible Node >=20 distribution');
  }
}
const nodeLicense = process.env.LAD_LB_NODE_LICENSE || join(dirname(nodeBinary), '..', 'LICENSE');
if (!existsSync(nodeLicense)) throw new Error('Node distribution LICENSE is required (LAD_LB_NODE_LICENSE)');
mkdirSync(join(staged, 'bin'), {recursive:true});
const installedNode = join(staged, 'bin', targetPlatform === 'win32' ? 'node.exe' : 'node');
copyFileSync(nodeBinary, installedNode);
chmodSync(installedNode, 0o755);
copyFileSync(nodeLicense, join(staged, 'NODE-LICENSE'));
writeFileSync(join(staged, 'node-runtime.json'), JSON.stringify({platform:targetPlatform,arch:targetArch,minimumNodeMajor:20,version:nativeTarget ? process.versions.node : undefined},null,2)+'\n');
console.log('live-browser runtime and compatible Node bundled and staged');
