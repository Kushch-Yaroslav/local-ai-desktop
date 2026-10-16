// Actual Chromium + a real loopback HTTP server. No inference or public network.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
const root = await mkdtemp(join(tmpdir(), 'project-browser-'));
process.env.LOCAL_AI_RUNTIME_ROOT = join(root, 'runtime');
const require = createRequire(import.meta.url);
const { ProjectBrowserSession, readPreviewAsset, loopbackTarget } = require('../dist/main/web/project-browser.js');
const approve = async () => ({ approved: true, reason: 'once' });
const signal = new AbortController().signal;
const sessions = [];
const session = (launcher) => { const value = new ProjectBrowserSession(root, join(root, 'captures'), launcher); sessions.push(value); return value; };
let requests = [];
const server = createServer((req, res) => {
  requests.push(req.url);
  if (req.url === '/redirect') { res.writeHead(302, { location: 'http://127.0.0.1:1/forbidden' }); res.end(); }
  else if (req.url === '/slow') { /* Cancellation must terminate this request. */ }
  else { res.setHeader('content-type', 'text/html'); res.end(html); }
});
const html = `<!doctype html><title>Project test</title><nav><a id="next" href="#universe">Universe</a></nav><main id="view">City</main><canvas></canvas><script>
let frames=0; function frame(){ document.body.dataset.frames=++frames; requestAnimationFrame(frame) } requestAnimationFrame(frame);
addEventListener('hashchange',()=>document.querySelector('main').textContent=location.hash.slice(1)||'City');
console.error('fixture console error'); setTimeout(()=>{throw Error('fixture JS error')},10);
</script>`;
try {
  await mkdir(join(root, 'runtime', 'logs'), { recursive: true });
  await writeFile(join(root, 'index.html'), html);
  await writeFile(join(root, '.env'), 'SECRET');
  await symlink('/etc/passwd', join(root, 'escape.html'));
  await symlink(join(root, '.env'), join(root, 'hidden.html'));
  for (const path of ['/.env', '/../etc/passwd', '/escape.html', '/hidden.html', '/package.lock', '/%2eenv', '/a%5cb.html']) await assert.rejects(readPreviewAsset(root, path));
  for (const url of ['http://192.168.0.1:3000', 'file:///etc/passwd', 'http://localhost', 'https://localhost:3000', 'http://user:pass@localhost:3000', 'http://localhost.evil:3000']) assert.throws(() => loopbackTarget(url));
  const denied = session(async () => { throw Error('must not launch before approval'); });
  assert.equal((await denied.execute({ action: 'open' }, signal)).code, 'PERMISSION_DENIED');
  const missing = session(async () => { throw Error('fixture browser executable unavailable'); });
  const unavailable = await missing.execute({ action: 'open' }, signal, approve);
  assert.match(unavailable.error, /executable unavailable/); assert.equal(unavailable.code, 'BROWSER_UNAVAILABLE');
  const staticPage = session();
  assert((await staticPage.execute({ action: 'read' }, signal)).error, 'read before open must fail recoverably');
  let result = await staticPage.execute({ action: 'open', path: 'index.html' }, signal, approve);
  assert(!result.error, JSON.stringify(result)); assert.equal(result.title, 'Project test');
  assert.equal(result.links.length, 1, 'DOM read deleted nav');
  // Synchronize on actual browser data/events instead of treating an open as assertions.
  await staticPage.execute({ action: 'click', selector: '#next' }, signal);
  result = await staticPage.execute({ action: 'read' }, signal);
  assert.match(result.url, /#universe$/); assert.match(result.content, /universe/);
  assert(result.javascript_errors.includes('fixture console error'));
  assert(result.javascript_errors.some(error => error.includes('fixture JS error')));
  const shot = await staticPage.execute({ action: 'screenshot' }, signal);
  assert(!shot.error, JSON.stringify(shot)); assert.equal(shot.visual_analysis, false);
  const png = await readFile(shot.screenshot_path); assert.equal(png.subarray(1, 4).toString(), 'PNG');
  result = await staticPage.execute({ action: 'back' }, signal); assert(!result.error, JSON.stringify(result)); assert(!result.url.includes('#universe'));
  await writeFile(join(root, 'unsafe.html'), `<a id="escape" href="http://127.0.0.1:1/secret">escape</a><img src="http://127.0.0.1:1/private"><script>fetch('http://127.0.0.1:1/api');new WebSocket('ws://127.0.0.1:1/ws');fetch('/index.html',{method:'POST'})</script>`);
  await staticPage.execute({ action: 'open', path: 'unsafe.html' }, signal);
  result = await staticPage.execute({ action: 'read' }, signal);
  assert(result.blocked_requests.some(error => error.includes('/private')));
  assert(result.blocked_requests.some(error => error.includes('POST')));
  await staticPage.execute({ action: 'click', selector: '#escape' }, signal);
  result = await staticPage.execute({ action: 'read' }, signal); assert(result.error || result.blocked_requests.some(error => error.includes('/secret')));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const httpPage = session();
  let approvals = 0;
  result = await httpPage.execute({ action: 'open', url: `http://localhost:${port}/` }, signal, async () => { approvals++; return approve(); });
  assert(!result.error, JSON.stringify(result)); assert.equal(approvals, 1); assert.equal(result.title, 'Project test');
  result = await httpPage.execute({ action: 'open', url: `http://localhost:${port}/redirect` }, signal);
  assert(result.error); assert.deepEqual(requests, ['/', '/redirect']);
  assert((await httpPage.execute({ action: 'open', url: 'http://127.0.0.1:1/' }, signal)).error);
  const numericPage = session();
  assert.equal((await numericPage.execute({ action: 'open', url: `http://127.0.0.1:${port}/` }, signal, approve)).title, 'Project test');
  const cancelPage = session(); const cancellation = new AbortController();
  const pending = cancelPage.execute({ action: 'open', url: `http://127.0.0.1:${port}/slow` }, cancellation.signal, approve);
  const timer = setTimeout(() => cancellation.abort(), 500);
  const start = Date.now(); result = await pending; clearTimeout(timer);
  assert(result.error); assert(Date.now() - start < 5000, 'Stop did not interrupt browser operation');
  assert((await cancelPage.execute({ action: 'read' }, signal)).error);
  // Launch completion after Stop must close the late browser as well.
  let finishLaunch; let closed = 0;
  const late = session(() => new Promise(resolve => { finishLaunch = resolve; }));
  const lateStop = new AbortController(); const lateResult = late.execute({ action: 'open' }, lateStop.signal, approve);
  while (!finishLaunch) await new Promise(resolve => setTimeout(resolve, 1));
  lateStop.abort(); finishLaunch({ close: async () => { closed++; } });
  assert((await lateResult).error); assert(closed > 0);
  console.log('PASS actual Chromium: project HTML, HTTP localhost, preserved DOM/nav, click/hash/back, JS and console errors, PNG screenshot, origin/redirect/method/file/symlink policy, approval denial, unavailable browser, Stop during navigation and launch');
} finally {
  await Promise.all(sessions.map(session => session.close()));
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  await rm(root, { recursive: true, force: true });
}
