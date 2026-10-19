// Real Chromium/Page + production hub/input/permission code, no inference.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
const root = await mkdtemp(join(tmpdir(), 'lad-interactive-'));
process.env.LOCAL_AI_RUNTIME_ROOT = join(root, 'runtime');
const require = createRequire(import.meta.url);
const { ProjectBrowserSession } = require('../dist/main/web/project-browser.js');
const { LiveBrowserHub } = require('../dist/main/web/live-browser.js');
const { launchWebBrowser } = require('../dist/main/web/web-tools.js');
const hub = new LiveBrowserHub(), events = [];
class Owner extends EventEmitter {
  constructor(id) { super(); this.id = id; }
  isDestroyed() { return false; }
  send(_channel, event) { events.push(event); }
}
const owner = new Owner(1), foreign = new Owner(2);
let browser, strictSession, strictServer, approvals = 0;
const approve = async () => { approvals++; return { approved: true, reason: 'once' }; };
const session = new ProjectBrowserSession(root, join(root, 'captures'), async () => (browser = await launchWebBrowser()), hub.observer(owner, 'chat', 'run-1'));
const signal = new AbortController().signal;
const state = () => events.findLast(e => e.type === 'state').state;
const input = value => hub.input(owner, state().sessionId, value);
const key = async value => { await input({ kind: 'key', phase: 'down', key: value }); await input({ kind: 'key', phase: 'up', key: value }); };
const click = async (x, y) => { await input({ kind: 'pointer', phase: 'down', x, y }); await input({ kind: 'pointer', phase: 'up', x, y }); };
try {
  await writeFile(join(root, 'index.html'), `<!doctype html><title>Interactive</title><style>body{margin:0;height:2000px}input{position:absolute;top:10px;left:10px}a{position:absolute;top:60px;left:10px}canvas{position:absolute;top:120px;left:10px}</style><input><a href="/second.html">Next</a><canvas tabindex="0"></canvas><script>window.identity=Math.random();window.keys=[];document.querySelector('canvas').addEventListener('keydown', e=>keys.push(e.key));let n=0,c=document.querySelector('canvas').getContext('2d');function frame(){c.fillStyle='hsl('+(n++%360)+' 70% 50%)';c.fillRect(0,0,300,150);requestAnimationFrame(frame)}frame()</script>`);
  await writeFile(join(root, 'second.html'), '<title>Second</title><a href="/index.html">Home</a><a id="escape" href="https://example.com/">Forbidden</a><a id="js" href="javascript:location.href=\'file:///etc/passwd\'">Scheme</a><a id="popup" target="_blank" href="https://example.com/">Popup</a>');
  hub.watch(owner, 'chat', true);
  assert(!(await session.execute({ action: 'open' }, signal, approve)).error);
  const page = browser.contexts()[0].pages()[0], identity = await page.evaluate(() => window.identity);
  assert.equal(state().ownership, 'agent');
  await assert.rejects(input({ kind: 'text', text: 'forbidden during agent action' }));
  for (let i = 0; i < 8; i++) assert(!(await session.execute({ action: 'screenshot', wait_ms: 0 }, signal, approve)).error);
  assert.equal((await session.execute({ action: 'screenshot' }, signal, approve)).code, 'SCREENSHOT_LIMIT');
  assert.equal(state().status, 'live', 'model screenshot budget does not poison browser lifecycle');
  await session.finishRun();
  assert.equal(state().ownership, 'user');
  assert.equal(await page.evaluate(() => window.identity), identity, 'same Page preserved');
  const beforePixels = await page.screenshot();
  await page.waitForTimeout(200);
  assert(!(await page.screenshot()).equals(beforePixels), 'the actual Canvas continues after run');
  assert.equal(events.filter(e => e.type === 'frame').length, 0, 'there is no frame transport');
  await assert.rejects(hub.input(foreign, state().sessionId, { kind: 'reload' }));
  await assert.rejects(input({ kind: 'pointer', phase: 'down', x: NaN, y: 0 }));
  await assert.rejects(input({ kind: 'key', phase: 'down', key: 'Control+L' }));
  await click(40, 20); await input({ kind: 'text', text: 'Interactive text' });
  assert.equal(await page.locator('input').inputValue(), 'Interactive text');
  await click(40, 140); for (const value of ['w', 'a', 's', 'd']) await key(value);
  assert.deepEqual(await page.evaluate(() => window.keys), ['w', 'a', 's', 'd']);
  await input({ kind: 'wheel', dx: 0, dy: 700 });
  await page.waitForFunction(() => scrollY > 0); await input({ kind: 'wheel', dx: 0, dy: -700 });
  await page.waitForFunction(() => scrollY === 0);
  await click(30, 68); await page.waitForURL('**/second.html');
  await input({ kind: 'back' }); assert.match(page.url(), /index.html$/);
  await input({ kind: 'forward' }); assert.match(page.url(), /second.html$/);
  await input({ kind: 'reload' }); assert.equal(await page.title(), 'Second');
  await page.locator('#popup').click(); await page.waitForTimeout(200);
  assert.equal(browser.contexts()[0].pages().length, 1, 'popup closed');
  await page.locator('#escape').click().catch(() => undefined);
  assert(!page.url().startsWith('https://example.com'), 'external origin blocked');
  await page.waitForURL('**/second.html');
  if (page.isClosed()) throw Error('blocked request unexpectedly destroyed valid Page');
  session.beginRun(hub.observer(owner, 'chat', 'run-2'));
  assert.equal(state().ownership, 'agent');
  await assert.rejects(input({ kind: 'text', text: 'cannot race agent' }));
  const reopened = await session.execute({ action: 'open', path: 'index.html' }, signal, approve); assert(!reopened.error, JSON.stringify(reopened));
  assert.equal(approvals, 2, 'fresh run authorization, not stale run grant');
  assert.equal(browser.contexts()[0].pages()[0], page, 'new run uses same Page');
  await session.finishRun(); assert.equal(state().ownership, 'user');
  session.beginRun(hub.observer(owner, 'chat', 'run-denied'));
  const deny = async () => ({ approved: false, reason: 'user_rejected' });
  const denied = await session.execute({ action: 'read' }, signal, deny);
  assert.equal(denied.code, 'PERMISSION_DENIED'); assert.equal(denied.reason, 'user_rejected'); assert.equal(denied.layer, 'browser_approval');
  assert.equal((await session.execute({ action: 'read' }, signal, approve)).code, 'PERMISSION_DENIED', 'no retry of explicit denial in same run');
  await session.finishRun(); assert.equal(state().ownership, 'closed'); assert(!browser.isConnected());
  strictServer = createServer((_req, response) => { response.setHeader('Content-Type', 'text/html'); response.setHeader('Content-Security-Policy', "script-src 'none'"); response.end('<title>Strict policy</title><script>window.forbiddenExecuted=true</script><a id="file" href="file:///etc/passwd">file</a><a id="data" href="data:text/html,forbidden">data</a>'); });
  await new Promise(resolve => strictServer.listen(0, '127.0.0.1', resolve));
  strictSession = new ProjectBrowserSession(root, join(root, 'strict-captures'), async () => (browser = await launchWebBrowser()));
  const strict = await strictSession.execute({action:'open',url:`http://127.0.0.1:${strictServer.address().port}/`},signal,approve);
  assert(!strict.error, JSON.stringify(strict));
  assert.equal(await browser.contexts()[0].pages()[0].evaluate(() => window.forbiddenExecuted), undefined, 'preview CSP must preserve stronger upstream CSP');
  const strictPage = browser.contexts()[0].pages()[0];
  for (const selector of ['#file', '#data']) { await strictPage.locator(selector).click().catch(() => undefined); await strictPage.waitForTimeout(100); assert.equal(new URL(strictPage.url()).origin, `http://127.0.0.1:${strictServer.address().port}`, 'non-HTTP scheme cannot escape the approved origin'); }
  console.log('PASS actual Chromium: continued real Canvas (zero frame IPC), same Page, input/WASD/scroll/navigation, forbidden origin/popup, ownership exclusion, screenshot separation, repeat runs, fresh approvals, sticky denial and disposal');
} finally { await session.close(); await strictSession?.close(); if (strictServer) { strictServer.closeAllConnections(); await new Promise(resolve => strictServer.close(resolve)); } await rm(root, { recursive: true, force: true }); }
