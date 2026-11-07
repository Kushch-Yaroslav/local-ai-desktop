import { build } from 'esbuild';
import { copyFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
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
  target: 'node18',
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

console.log('live-browser runtime bundled → dist/live-browser.js');
