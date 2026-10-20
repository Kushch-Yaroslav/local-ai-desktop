import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { _electron as electron } from 'playwright-core';

const permissionsOnly = process.argv.includes('--permissions-only');
const root = await mkdtemp(join(tmpdir(), 'local-ai-electron-approval-'));
execFileSync('git', ['init', '-q', root]);
execFileSync('git', ['-C', root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'initial']);
let command = 'git switch -c allowed';
let repetitions = 1;
let finalGate, releaseFinal;
let toolName = 'run_terminal';
const requests = [];
let scenario = 0; let scenarioCalls = 0;
const beginScenario = () => { requests.length = 0; scenario += 1; scenarioCalls = 0; };
const server = createServer(async (request, response) => {
  let body = ''; for await (const chunk of request) body += chunk;
  const parsed = JSON.parse(body); requests.push(parsed);
  // Provider execution count must survive legitimate model-context cleanup.
  const hasResult = scenarioCalls >= repetitions;
  const delta = hasResult ? { content: 'Operation result reported.' } : { tool_calls: [{ index: 0, id: `fixture-${scenario}-call-${scenarioCalls++}`, type: 'function', function: { name: toolName, arguments: JSON.stringify(toolName === 'list_directory' ? { path: '.' } : { command }) } }] };
  if (hasResult && finalGate) await finalGate;
  if (toolName === 'list_directory') await new Promise(done => setTimeout(done, 40));
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.end(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: hasResult ? 'stop' : 'tool_calls' }] })}\n\ndata: [DONE]\n\n`);
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
let application;
try {
  application = await electron.launch({ executablePath: resolve('node_modules/electron/dist/electron'), args: [resolve('test-fixtures/agent-reliability/approval-electron-main.cjs')], env: { ...process.env, LOCAL_AI_RUNTIME_ROOT: join(root, 'app-data'), LOCAL_AI_APPROVAL_FIXTURE_ROOT: root, LOCAL_AI_APPROVAL_FIXTURE_ENDPOINT: `http://127.0.0.1:${server.address().port}/v1/chat/completions` }, timeout: 30_000 });
  const page = await application.firstWindow(); const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  if (!permissionsOnly) {
  await page.waitForSelector('.mermaid-canvas svg');
  await page.waitForFunction(() => document.querySelectorAll('.mermaid-canvas svg').length === 3);
  assert.equal(await page.locator('.mermaid-source').count(), 4);
  assert.match(await page.locator('.mermaid-status').innerText(), /Parse error|Lexical error/);
  await page.locator('.mermaid-source').first().locator('summary').click();
  assert.match(await page.locator('.mermaid-source').first().innerText(), /sharp \(npm\)\\nсжатие\/конверт/);
  assert.match(await page.locator('code.language-python').innerText(), /ordinary code survives/);
  await page.getByRole('button', { name: /Повторить отрисовку|Retry render/ }).click();
  await page.waitForSelector('.mermaid-status');
  }
  const waitForRun = async () => {
    const deadline = Date.now() + 15000;
    while (JSON.parse(await readFile(join(root, 'app-data/approval-active.json'), 'utf8')).active) {
      if (Date.now() > deadline) throw new Error('Agent fixture failed to finish');
      await new Promise(done => setTimeout(done, 50));
    }
  };
  const waitForRequest = async () => {
    const deadline = Date.now() + 10000;
    while (!requests.length) {
      if (Date.now() > deadline) throw new Error('Agent fixture did not request a model turn');
      await new Promise(done => setTimeout(done, 20));
    }
  };
  const send = async text => { beginScenario(); await page.locator('.composer textarea').fill(text); await page.locator('.composer textarea').press('Enter'); try { await page.waitForSelector('.approval-panel', { timeout: 10000 }); } catch (error) { console.error('fixture requests', requests.map(request => request.messages.map(message => ({ role: message.role, content: String(message.content).slice(-1500) })))); console.error('fixture bridge', await application.evaluate(() => global.approvalFixture.transcript.slice(-8))); console.error('fixture UI', (await page.locator('body').innerText()).slice(-2500)); throw error; } };
  await send('Create a branch');
  assert.match(await page.locator('.approval-panel').innerText(), /git switch -c allowed/);
  assert.equal(await page.locator('.approval-panel pre').count(), 1, 'command has exactly one main presentation');
  assert.equal(await page.locator('.approval-panel details').count(), 0, 'no empty or duplicate diagnostics');
  const badge = page.locator('.approval-panel .project-folder-badge');
  assert.equal(await badge.getAttribute('title'), root);
  await badge.focus(); assert.equal(await badge.evaluate(node => node === document.activeElement), true);
  assert.equal(await badge.locator('svg').getAttribute('width'), '20');
  await page.screenshot({ path: '/tmp/agent-permission-dark.png' });
  const contrast = await page.locator('.approval-panel .agent-button').evaluateAll(buttons => buttons.map(button => { const c = getComputedStyle(button); return { fg: c.color, bg: c.backgroundColor, border: c.borderStyle }; }));
  assert(contrast.every(c => c.fg !== c.bg && c.border === 'solid'));
  await page.getByRole('button', { name: 'Copy command', exact: true }).click();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'git switch -c allowed');

  for (const language of ['ru', 'en']) {
    await application.evaluate(({ BrowserWindow }, language) => { for (const w of BrowserWindow.getAllWindows()) w.webContents.send('settings:language', language); }, language);
    await page.getByRole('button', { name: language === 'ru' ? 'Разрешить один раз' : 'Allow once', exact: true }).waitFor();
    assert(!/Authorize agent operation|Maximum control/.test(await page.locator('.approval-panel').innerText()));
  }
  for (const light of [true, false]) {
    await page.evaluate(light => {
      const r = document.documentElement;
      const values = { '--bg': '#f7f9fb', '--surface': '#fff', '--surface-raised': '#eef2f6', '--text': '#202832', '--text-muted': '#465362', '--border': '#b8c4cf', '--border-strong': '#8c9bab' };
      for (const [key,value] of Object.entries(values)) { if (light) r.style.setProperty(key,value); else r.style.removeProperty(key); }
    }, light);
    const ratios = await page.locator('.permission-actions button').evaluateAll(buttons => {
      const luminance = color => { const rgb = color.match(/[\d.]+/g).slice(0,3).map(Number).map(v => v/255).map(v => v <= .04045 ? v/12.92 : ((v+.055)/1.055)**2.4); return .2126*rgb[0]+.7152*rgb[1]+.0722*rgb[2]; };
      return buttons.map(button => { const c = getComputedStyle(button); const a=luminance(c.color), b=luminance(c.backgroundColor); return (Math.max(a,b)+.05)/(Math.min(a,b)+.05); });
    });
    assert(ratios.every(r => r >= 4.5), `Button contrast ratios ${ratios}`);
    if (light) await page.screenshot({ path: '/tmp/agent-permission-light.png' });
  }
  await page.getByRole('button', { name: /^(Разрешить один раз|Allow once)$/ }).click();
  await waitForRun();
  assert.equal(await readFile(join(root, '.git/HEAD'), 'utf8'), 'ref: refs/heads/allowed\n');
  assert(requests.some(request => request.messages.some(message => message.role === 'tool' && message.content.includes('exit_code'))));
  command = "python3 -c 'import sys; print(\"Useful partial output\"); sys.exit(1)'";
  finalGate = new Promise(done => { releaseFinal = done; });
  await send('An authorized command with output and a nonzero exit');
  await page.getByRole('button', { name: /^(Разрешить один раз|Allow once)$/ }).click();
  const card = page.locator('.agent-timeline-action.error').last(); await card.waitFor();
  const failure = await application.evaluate(() => global.approvalFixture.transcript.findLast(e => e.type === 'tool' && e.activity.terminal?.finishedAt)?.activity);
  assert.equal(failure.terminal.exitCode, 1); assert.equal(failure.state, 'error');
  assert.match(failure.terminal.stdout, /Useful partial output/);
  if (!await card.locator('.agent-timeline-action-body').count()) await card.locator('.agent-timeline-action-head').click();
  assert(!((await card.locator('.agent-timeline-action-head').innerText()).includes(command)));
  assert.equal(await card.locator('pre').evaluateAll((nodes, command) => nodes.filter(n => n.textContent.includes(command)).length, command), 1);
  await card.getByText('Technical details', { exact: true }).click();
  assert(!((await card.locator('details').last().innerText()).includes(command)));
  releaseFinal(); finalGate = undefined; await waitForRun();
  command = 'git switch -c denied'; await send('Try a different branch');
  await page.getByRole('button', { name: /^(Отклонить|Deny)$/ }).click();
  await waitForRun();
  assert.equal(await readFile(join(root, '.git/HEAD'), 'utf8'), 'ref: refs/heads/allowed\n');
  assert(requests.some(request => request.messages.some(message => message.role === 'tool' && message.content.includes('PERMISSION_DENIED'))));
  command = 'git config fixture.permission granted'; repetitions = 2;
  await send('Authorize the same scoped operation for this run');
  await page.getByRole('button', { name: /Всегда разрешать в этой сессии|Always allow for this session/ }).click();
  await waitForRun();
  assert(requests.some(request => request.messages.slice(request.messages.findLastIndex(message => message.role === 'user') + 1).filter(message => message.role === 'tool').length === 2));
  repetitions = 1;
  beginScenario();await page.locator('.composer textarea').fill('Repeat the approved exact operation in the same chat session');await page.locator('.composer textarea').press('Enter');await waitForRun();assert.equal(await page.locator('.approval-panel').count(),0,'Chat grant survives a completed run');
  command = 'git switch -c cancelled'; await send('Cancel this approval');
  await page.evaluate(() => window.localAi.chat.stop('approval-fixture'));
  await waitForRun();
  await page.waitForFunction(() => !document.querySelector('.approval-panel'));
  assert.equal(await readFile(join(root, '.git/HEAD'), 'utf8'), 'ref: refs/heads/allowed\n');
  // Mode updates acknowledge while a host permission dialog is still pending;
  // the existing request still requires an explicit decision.
  command = 'git switch -c pending-mode'; await send('Mode change must not authorize a pending request');
  await page.locator('.autonomy-trigger').click();
  await page.getByRole('button', { name: 'Advanced settings', exact: true }).click();
  await page.getByRole('button', { name: 'Absolute Autopilot', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.autonomy-trigger')?.textContent.includes('Autopilot'));
  assert.equal(await page.locator('.approval-panel').count(), 1);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: /^(Отклонить|Deny)$/ }).click(); await waitForRun();
  assert.equal(await readFile(join(root, '.git/HEAD'), 'utf8'), 'ref: refs/heads/allowed\n');
  command = 'git switch -c autonomous'; beginScenario();
  await page.locator('.composer textarea').fill('Create the branch in the authorized workspace'); await page.locator('.composer textarea').press('Enter');
  await waitForRequest(); await waitForRun();
  assert.equal(await readFile(join(root, '.git/HEAD'), 'utf8'), 'ref: refs/heads/autonomous\n');
  assert.equal(await page.locator('.approval-panel').count(), 0);
  // Real Rust executes the narrowly scoped compound inspection without a
  // permission prompt in an explicitly trusted workspace.
  await page.locator('.autonomy-trigger').click();
  await page.getByRole('button', { name: 'Absolute Autopilot', exact: true }).click();
  await page.keyboard.press('Escape');
  command = 'cd . && ls .git && cat .git/HEAD'; beginScenario();
  await page.locator('.composer textarea').fill('Inspect the trusted workspace with a scoped read-only chain'); await page.locator('.composer textarea').press('Enter');
  await waitForRequest(); await waitForRun();
  assert.equal(await page.locator('.approval-panel').count(), 0);
  assert(!await application.evaluate(() => global.approvalFixture.transcript.some(e => e.type === 'approval-request')));
  const inspection = await application.evaluate(() => global.approvalFixture.transcript.findLast(e => e.type === 'tool' && e.activity.terminal?.finishedAt)?.activity.terminal);
  assert.equal(inspection?.exitCode, 0, JSON.stringify(inspection));
  assert.match(inspection.stdout, /refs\/heads\/autonomous/);
  await page.locator('.autonomy-trigger').click();
  await page.getByRole('button', { name: 'Absolute Autopilot', exact: true }).click();
  await page.keyboard.press('Escape');
  // Keyboard tooltip, touch-accessible details and theme tokens.
  await page.locator('.autonomy-trigger').focus();
  assert.equal(await page.locator('.autonomy-tooltip').isVisible(), true);
  await page.keyboard.press('Enter');
  if (!await page.locator('.autonomy-advanced').count()) await page.getByRole('button', { name: 'Advanced settings', exact: true }).click();
  await page.locator('.autonomy-option details').first().locator('summary').click();
  assert.match(await page.locator('.autonomy-popover').innerText(), /Automatically allowed/);
  for (const light of [false, true]) {
    await page.evaluate(light => {
      const root = document.documentElement; root.dataset.theme = light ? 'light' : 'dark';
      if (light) { root.style.setProperty('--surface', '#ffffff'); root.style.setProperty('--text', '#202832'); root.style.setProperty('--border', '#bcc4cc'); root.style.setProperty('--text-muted', '#465362'); }
      else { for (const key of ['--surface', '--text', '--border', '--text-muted']) root.style.removeProperty(key); }
    }, light);
    const colors = await page.locator('.autonomy-popover').evaluate(el => ({ background: getComputedStyle(el).backgroundColor, text: getComputedStyle(el).color }));
    assert.notEqual(colors.background, colors.text); assert.notEqual(colors.background, 'rgba(0, 0, 0, 0)');
  }
  await page.keyboard.press('Escape');
  // Two modes, no trust controls and no obsolete unrestricted-host consent dialog.
  await application.evaluate(({ dialog }) => { global.autopilotConfirmation = []; dialog.showMessageBox = async options => { global.autopilotConfirmation.push(options); return { response: 1 }; }; });
  await page.locator('.autonomy-trigger').click();
  assert.equal(await page.locator('.autonomy-option').count(),2);
  assert.equal(await page.getByRole('button',{name:'Trust selected workspaces',exact:true}).count(),0);
  await page.getByRole('button', { name: 'Absolute Autopilot', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.agent-controls')?.classList.contains('autonomy-autonomous'));
  assert.equal((await application.evaluate(() => global.autopilotConfirmation)).length,0);
  await page.keyboard.press('Escape');
  if (!permissionsOnly) {
  const waitForStage = async (stage, count = 1) => {
    const deadline = Date.now() + 15000;
    while (true) {
      const state = JSON.parse(await readFile(join(root, 'app-data/approval-active.json'), 'utf8'));
      if (state.loopStages.filter(value => value === stage).length >= count) return;
      if (Date.now() > deadline) throw Error(`Missing loop stage ${stage} #${count}: ${JSON.stringify(state)}`);
      await new Promise(done => setTimeout(done, 50));
    }
  };
  // Soft recovery is automatic. Ambiguous read loops must pause, not discard
  // useful observations. Manual continuation re-arms rather than suppresses detection.
  toolName = 'list_directory'; repetitions = 1000; beginScenario();
  await page.locator('.composer textarea').fill('Inspect repeatedly to exercise bounded loop recovery'); await page.locator('.composer textarea').press('Enter');
  await waitForStage('paused');
  await page.getByRole('button', { name: 'Correct and resume', exact: true }).waitFor();
  const pausedCount = requests.length; await new Promise(done => setTimeout(done, 150)); assert.equal(requests.length, pausedCount);
  await waitForStage('soft_recovery');
  const stageCount = async stage => JSON.parse(await readFile(join(root, 'app-data/approval-active.json'), 'utf8')).loopStages.filter(value => value === stage).length;
  const beforeRepair = await stageCount('paused');
  await page.getByRole('button', { name: 'Correct and resume', exact: true }).click();
  await waitForStage('repair_requested'); await waitForStage('paused', beforeRepair + 1);
  assert(requests.some(request => request.messages[0].content.includes('Agent runtime notice')));
  const beforeContinue = await stageCount('paused');
  await page.getByRole('button', { name: 'Continue anyway', exact: true }).click();
  await waitForStage('continued'); await waitForStage('paused', beforeContinue + 1);
  assert(requests.length > pausedCount, 'manual Continue allows work but detection pauses another loop');
  repetitions = 0; // A changed provider strategy now finishes without another tool.
  await page.getByRole('button', { name: 'Continue anyway', exact: true }).click(); await waitForRun();
  assert.equal(await page.locator('.agent-loop-warning').count(), 0);
  // Cancellation remains available during a strong suspension.
  beginScenario(); repetitions = 1000;
  await page.locator('.composer textarea').fill('Stop a suspended loop'); await page.locator('.composer textarea').press('Enter');
  await page.getByRole('button', { name: 'Continue anyway', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Stop', exact: true }).click(); await waitForRun();
  assert.equal(await page.locator('.agent-loop-warning').count(), 0);
  await page.locator('.autonomy-trigger').click();
  await page.getByRole('button', { name: 'Ask for confirmation', exact: true }).click();
  await page.keyboard.press('Escape');
  // Revocation buttons change actual run-local authorization, including while paused.
  for (const all of [false, true]) {
    toolName = 'run_terminal'; command = 'git config fixture.revocable granted'; repetitions = 22;
    await send(`Exercise ${all ? 'all' : 'individual'} grant revocation`);
    await page.getByRole('button', { name: /Always allow for this session/ }).click();
    await page.getByRole('button', { name: 'Continue anyway', exact: true }).waitFor();
    await page.locator('.autonomy-trigger').click();
    if (!await page.locator('.autonomy-advanced').count()) await page.getByRole('button', { name: 'Advanced settings', exact: true }).click();
    await page.locator('.session-grant').waitFor();
    if (all) await page.getByRole('button', { name: 'Revoke all session permissions', exact: true }).click();
    else await page.locator('.session-grant').getByRole('button', { name: 'Revoke', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('.session-grant').length === 0);
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Continue anyway', exact: true }).click();
    await page.waitForSelector('.approval-panel');
    repetitions = 0;
    await page.getByRole('button', { name: 'Deny', exact: true }).click(); await waitForRun();
  }
  }
  assert.deepEqual(errors, []);
  console.log('Real Electron/preload/renderer → broker → Rust: Ask/Autopilot, pending-approval mode changes, scoped session reuse, allow/deny/cancel and keyboard/theme controls passed.');
  if (!permissionsOnly) console.log('Loop warning actions, live pause/resume/Stop, grant revocation and Mermaid rendering passed.');
} catch (error) { console.error(error); throw error; } finally { releaseFinal?.();
  server.closeAllConnections();
  if (application) await application.close(); server.closeAllConnections(); await new Promise(done => server.close(done)); await rm(root, { recursive: true, force: true });
}
