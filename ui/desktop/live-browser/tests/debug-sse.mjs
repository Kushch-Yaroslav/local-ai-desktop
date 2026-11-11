import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 45993;
const BASE = `http://127.0.0.1:${PORT}`;

const PAGE = '<!doctype html><html><head><title>Debug</title></head><body><h1>Debug page</h1><div style="width:300px;height:200px;background:red">block</div></body></html>';
const pageServer = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(PAGE);
});
await new Promise((r) => pageServer.listen(45992, '127.0.0.1', r));

const runtime = spawn('node', [join(root, 'dist', 'live-browser.js')], {
  env: { ...process.env, LAD_LB_PORT: String(PORT), LAD_LB_TOKEN: 'dbg', LAD_LB_DATA_DIR: mkdtempSync(join(tmpdir(), 'dbg-')), LAD_LB_HEADLESS: 'true' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let boot = '';
runtime.stdout.on('data', (d) => {
  for (const line of String(d).split('\n')) if (line.trim().startsWith('{')) boot = line.trim();
});
const logs = [];
runtime.stderr.on('data', (d) => logs.push(String(d)));
runtime.stdout.on('data', (d) => logs.push(String(d)));
await new Promise((r) => {
  const t = setInterval(() => boot && (clearInterval(t), r()), 100);
  setTimeout(() => {
    console.log('NO BOOT', logs.join(''));
    runtime.kill();
    process.exit(1);
  }, 15000);
});

const auth = { authorization: 'Bearer dbg' };
await fetch(`${BASE}/control/active`, { method: 'POST', headers: auth, body: JSON.stringify({ conversationId: 'dbg' }) });
const open = await fetch(`${BASE}/control/navigate?conversation=dbg`, { method: 'POST', headers: auth, body: JSON.stringify({ action: 'open', url: 'http://127.0.0.1:45992/' }) });
console.log('open:', await open.text());
await new Promise((r) => setTimeout(r, 1000));

// Listen to SSE for 20s.
const controller = new AbortController();
const res = await fetch(`${BASE}/control/events?conversation=dbg&token=dbg`, { signal: controller.signal });
const reader = res.body.getReader();
const decoder = new TextDecoder();
let buf = '';
let frames = 0;
const start = Date.now();
while (Date.now() - start < 20000) {
  const chunk = await Promise.race([reader.read(), new Promise((r) => setTimeout(() => r({ done: true, value: '' }), 3000))]);
  if (chunk.done && !chunk.value) continue;
  buf += decoder.decode(chunk.value, { stream: true });
  let idx;
  while ((idx = buf.indexOf('\n\n')) >= 0) {
    const msg = buf.slice(0, idx).replace(/^data: /, '');
    buf = buf.slice(idx + 2);
    if (!msg.trim() || msg.startsWith(':')) continue;
    try {
      const parsed = JSON.parse(msg);
      if (parsed.t === 'frame') {
        frames++;
        console.log(`frame #${frames} ${parsed.width}x${parsed.height} bytes=${parsed.data.length} at +${Date.now() - start}ms`);
      } else {
        console.log(`event: ${parsed.t}`);
      }
    } catch {
      /* */
    }
  }
}
console.log(`FRAMES: ${frames}`);
console.log('--- runtime logs ---');
console.log(logs.join('').slice(-3000));
controller.abort();
runtime.kill('SIGKILL');
pageServer.close();
process.exit(0);
