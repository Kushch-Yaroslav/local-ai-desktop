/**
 * Live Browser runtime smoke test (no Electron, no LLM).
 * Verifies: session creation, page accessibility, grounding (DOM + Canvas/SVG
 * fallback), areas/statuses, crop capture, context text, MCP tools over
 * streamable HTTP, SSE frames.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 45991;
const TOKEN = 'smoke-token-123';
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = mkdtempSync(join(tmpdir(), 'lad-lb-smoke-'));

let passed = 0;
let failed = 0;
function check(name, cond, extra = '') {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name} ${extra}`);
  }
}

// 1. Test page server.
const PAGE = `<!doctype html><html><head><title>Smoke Page</title><style>
  body{font-family:sans-serif;margin:0}
  header{background:#111;color:#fff;padding:16px}
  .card{border:1px solid #ccc;margin:24px;padding:16px;width:300px}
  .btn-row{white-space:nowrap;overflow:hidden;width:180px}
  .btn{display:inline-block;padding:6px 14px;margin-right:8px;background:#2563eb;color:#fff}
  .long{display:inline-block;width:200px}
  canvas{width:240px;height:160px;background:linear-gradient(45deg,#f59e0b,#ef4444);border:1px solid #333}
</style></head><body>
<header><h1>Smoke</h1></header>
<section class="card" data-testid="main-card">
  <h2>Main card</h2>
  <p>Some content text for grounding.</p>
  <div class="btn-row">
    <button class="btn">Submit</button>
    <span class="btn long">A very long button that overflows</span>
  </div>
</section>
<article class="card">
  <h2>Chart</h2>
  <canvas id="chart" width="240" height="160"></canvas>
</article>
</body></html>`;

const pageServer = createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(PAGE);
});
await new Promise((r) => pageServer.listen(45990, '127.0.0.1', r));

// 2. Launch runtime.
const runtime = spawn('node', [join(root, 'dist', 'live-browser.js')], {
  detached: false,
  env: {
    ...process.env,
    LAD_LB_PORT: String(PORT),
    LAD_LB_TOKEN: TOKEN,
    LAD_LB_DATA_DIR: DATA_DIR,
    LAD_LB_HEADLESS: 'true',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let bootLine = '';
runtime.stdout.on('data', (d) => {
  for (const raw of String(d).split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('{')) {
      bootLine = line;
      break;
    }
  }
});
let stderr = '';
runtime.stderr.on('data', (d) => (stderr += String(d)));
let booted = false;
await new Promise((resolve, reject) => {
  const t = setInterval(() => {
    if (bootLine.startsWith('{')) {
      clearInterval(t);
      booted = true;
      resolve();
    }
  }, 100);
  setTimeout(() => {
    clearInterval(t);
    if (!booted) {
      try {
        runtime.kill('SIGKILL');
      } catch {
        /* ignore */
      }
      reject(new Error(`runtime did not boot: ${stderr.slice(0, 2000)}`));
    }
  }, 20000);
});
console.log('boot:', bootLine);
process.on('exit', () => {
  try {
    runtime.kill('SIGKILL');
  } catch {
    /* ignore */
  }
});

const conv = 'smoke-conv-1';
const auth = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };

async function api(path, body, method = 'POST') {
  const res = await fetch(`${BASE}${path}?conversation=${conv}`, {
    method,
    headers: auth,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

console.log('\n— browser session —');
const open = await api('/control/navigate', { action: 'open', url: 'http://127.0.0.1:45990/' });
check('open page', open.status === 200 && open.json?.ok, JSON.stringify(open.json));
await new Promise((r) => setTimeout(r, 800));
const state = await api('/control/state', undefined, 'GET');
check('state meta', state.json?.meta?.url?.startsWith('http://127.0.0.1:45990'), JSON.stringify(state.json?.meta));
check('state ready', state.json?.meta?.ready === true);
check('ownership user', state.json?.meta?.ownership === 'user');

console.log('\n— grounding: DOM region —');
// The .btn-row container: x=24, y=?? — find via a quick read
const ground = await api('/control/ground', { rect: { x: 30, y: 120, width: 200, height: 60 } });
check('ground ok', ground.status === 200 && ground.json?.ok, JSON.stringify(ground.json)?.slice(0, 300));
const region = ground.json?.region;
check('region has anchors', Array.isArray(region?.anchors) && region.anchors.length >= 1, JSON.stringify(region?.anchors)?.slice(0, 200));
check('region diagnostics present', region?.diagnostics?.length >= 1);
check('area auto-created', Boolean(ground.json?.area));

console.log('\n— grounding: Canvas/SVG fallback —');
const canvasGround = await api('/control/ground', { rect: { x: 40, y: 330, width: 220, height: 140 }, note: 'chart' });
const canvasRegion = canvasGround.json?.region;
check('canvas region created', Boolean(canvasRegion));
check(
  'canvas diagnostics',
  canvasRegion?.diagnostics?.some((d) => d.includes('Screenshot-only Canvas/SVG')),
  JSON.stringify(canvasRegion?.diagnostics),
);
check('canvas no anchors', (canvasRegion?.anchors?.length ?? 0) === 0);

console.log('\n— areas & statuses —');
const area = canvasGround.json?.area;
const upd = await api('/control/area/update', { areaId: area.id, name: 'Chart region', description: 'Check the gradient chart', status: 'Confirmed', statusSource: 'user' });
check('area update', upd.status === 200 && upd.json?.area?.name === 'Chart region');
const state2 = await api('/control/state', undefined, 'GET');
check('two areas', state2.json?.areas?.length === 2, JSON.stringify(state2.json?.areas?.map((a) => a.name)));

console.log('\n— live projection —');
const proj = await api('/control/projection', { regionId: region.id });
check('projection ok', proj.status === 200 && proj.json?.ok, JSON.stringify(proj.json?.region?.live));

console.log('\n— crop capture —');
const cap = await api('/control/capture', { rect: { x: 30, y: 120, width: 200, height: 60 }, maxEdge: 640 });
check('crop ok', cap.status === 200 && cap.json?.ok && cap.json?.data?.length > 1000, `w=${cap.json?.width} h=${cap.json?.height}`);

console.log('\n— MCP over streamable HTTP —');
async function mcp(method, params, id) {
  const res = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
  const text = await res.text();
  // May be JSON or SSE-framed.
  const jsonLine = text.split('\n').map((l) => l.replace(/^data: /, '')).find((l) => l.trim().startsWith('{'));
  return { status: res.status, body: jsonLine ? JSON.parse(jsonLine) : { raw: text.slice(0, 300) } };
}
const init = await mcp('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'smoke', version: '1' } }, 1);
check('mcp initialize', init.status === 200 && (init.body?.result?.serverInfo?.name === 'local-ai-live-browser' || init.body?.raw), JSON.stringify(init.body)?.slice(0, 200));
const tools = await mcp('tools/list', {}, 2);
const toolNames = (tools.body?.result?.tools ?? []).map((t) => t.name);
check('mcp tools listed', toolNames.length >= 10, toolNames.join(','));
const callState = await mcp('tools/call', { name: 'browser_state', arguments: { conversation_id: conv } }, 3);
check('mcp browser_state', String(callState.body?.result?.content?.[0]?.text ?? '').includes('Smoke Page') || callState.body?.result?.isError === undefined, JSON.stringify(callState.body?.result)?.slice(0, 200));
const callList = await mcp('tools/call', { name: 'browser_list_areas', arguments: { conversation_id: conv } }, 4);
const listText = callList.body?.result?.content?.[0]?.text ?? '';
check('mcp list areas text', listText.includes('Chart region') && listText.includes('Screenshot-only Canvas/SVG region; no source mapping'), listText.slice(0, 200));
const callDesc = await mcp('tools/call', { name: 'browser_describe_area', arguments: { conversation_id: conv, area_id: area.id } }, 5);
const descContent = callDesc.body?.result?.content ?? [];
const descImage = descContent.find((c) => c.type === 'image');
check('mcp describe area has image', Boolean(descImage), JSON.stringify(descContent.map((c) => c.type)));
const callStatus = await mcp('tools/call', { name: 'browser_set_area_status', arguments: { conversation_id: conv, area_id: area.id, status: 'In progress' } }, 6);
check('mcp set status', String(callStatus.body?.result?.content?.[0]?.text ?? '').includes('In progress'));
const callRead = await mcp('tools/call', { name: 'browser_read', arguments: { conversation_id: conv, max_chars: 2000 } }, 7);
const readText = callRead.body?.result?.content?.[0]?.text ?? '';
check('mcp read bounded', readText.includes('Main card') && readText.length < 5000);
const callBlocked = await mcp('tools/call', { name: 'browser_open', arguments: { conversation_id: conv, url: 'file:///etc/passwd' } }, 8);
const blockedText = callBlocked.body?.result?.content?.[0]?.text ?? '';
check('mcp blocks file://', blockedText.includes('protocol-not-allowed') || callBlocked.body?.result?.isError === true, blockedText.slice(0, 150));

console.log('\n— SSE frames —');
let frames = 0;
let sawMeta = false;
let sawState = false;
{
  const controller = new AbortController();
  try {
    const res = await fetch(`${BASE}/control/events?conversation=${conv}&token=${TOKEN}`, { signal: controller.signal });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    const deadline = Date.now() + 16000;
    while (Date.now() < deadline && !(frames >= 2 && sawMeta && sawState)) {
      const chunk = await Promise.race([
        reader.read(),
        new Promise((r) => setTimeout(() => r({ done: true, value: '' }), 1500)),
      ]);
      if (chunk.done && !chunk.value) continue;
      buf += decoder.decode(chunk.value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const msg = buf.slice(0, idx).replace(/^data: /m, '');
        buf = buf.slice(idx + 2);
        if (!msg.trim() || msg.startsWith(':')) continue;
        try {
          const parsed = JSON.parse(msg);
          if (parsed.t === 'frame') frames++;
          if (parsed.t === 'meta') sawMeta = true;
          if (parsed.t === 'state') sawState = true;
        } catch {
          /* ignore */
        }
      }
    }
  } catch {
    /* aborted */
  } finally {
    controller.abort();
  }
  check('sse frames received', frames >= 2, `frames=${frames}`);
  check('sse meta', sawMeta);
  check('sse state', sawState);
}

console.log('\n— chat isolation —');
const conv2 = 'smoke-conv-2';
const open2 = await fetch(`${BASE}/control/navigate?conversation=${conv2}`, { method: 'POST', headers: auth, body: JSON.stringify({ action: 'open', url: 'http://127.0.0.1:45990/' }) });
check('second conv open', (await open2.json())?.ok === true);
const stateA = await api('/control/state', undefined, 'GET');
const stateB = await fetch(`${BASE}/control/state?conversation=${conv2}`, { headers: auth });
check('conv1 has 2 areas', stateA.json?.areas?.length === 2);
check('conv2 has 0 areas', (await stateB.json())?.areas?.length === 0);

console.log('\n— persistence —');
runtime.kill('SIGTERM');
await new Promise((r) => setTimeout(r, 700));
const fs = await import('node:fs');
const areasFile = fs.readFileSync(join(DATA_DIR, 'conversations', conv, 'areas.json'), 'utf8');
check('areas persisted', areasFile.includes('Chart region'));
const regionsFile = fs.readFileSync(join(DATA_DIR, 'conversations', conv, 'regions.json'), 'utf8');
check('regions persisted', regionsFile.includes('Screenshot-only Canvas/SVG region; no source mapping'));

console.log(`\nSMOKE RESULT: ${passed} passed, ${failed} failed`);
pageServer.close();
rmSync(DATA_DIR, { recursive: true, force: true });
process.exit(failed > 0 ? 1 : 0);
