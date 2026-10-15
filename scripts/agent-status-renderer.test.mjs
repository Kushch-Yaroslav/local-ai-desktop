// Real production renderer; only the preload/provider boundary is a deterministic fixture.
// No model is launched by this UI test. Use LOCAL_AI_TEST_BROWSER to select a Chromium executable.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { chromium } from 'playwright-core';

const root = resolve('dist/renderer');
const server = createServer(async (request, response) => {
  const pathname = new URL(request.url, 'http://fixture').pathname;
  const path = resolve(root, `.${pathname === '/' ? '/index.html' : pathname}`);
  if (!path.startsWith(`${root}/`)) { response.writeHead(403).end(); return; }
  try {
    const types = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html' };
    response.setHeader('content-type', types[extname(path)] ?? 'application/octet-stream');
    response.end(await readFile(path));
  } catch { response.writeHead(404).end(); }
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
let browser;
try {
  browser = await chromium.launch({ executablePath: process.env.LOCAL_AI_TEST_BROWSER ?? '/usr/bin/google-chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 920 } });
  const errors = []; page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() => {
    const chat = (id) => ({ id, title: id, modelId: 'fixture', mode: 'agent', contextWindow: 32768, reasoningMode: 'fast', workingDirectory: null, createdAt: '2026-10-06', updatedAt: '2026-10-06' });
    const chats = [chat('Current task'), { ...chat('Other task'), mode: 'chat' }, { ...chat('Regenerate task'), thinkingEnabled: false }];
    const plans = new Map(); const messages = new Map(); const runs = new Map();
    let listener, languageListener, request, resolveSend, reasoning = '';
    const emit = (event) => listener({ conversationId: request.conversationId, generationId: request.generationId, ...event });
    window.statusFixture = {
      language: (language) => languageListener(language),
      budget: (budget) => { plans.set(request.conversationId, { ...plans.get(request.conversationId), workBudget: budget }); emit({ type: 'work-budget', budget }); },
      update: (memory) => { plans.set(request.conversationId, { ...plans.get(request.conversationId), taskMemory: memory }); emit({ type: 'task-memory', memory }); },
      action: (activity) => emit({ type: 'tool', activity }),
      loopState: (notice,paused) => emit({type:'loop-state',notice,paused}),
      loop: (stage, position) => emit({ type: 'loop-event', timelinePosition: position, lifecycle: { stage, notice: { signature: 'fixture', level: 3, evidence: 'Repeated view result', guidance: 'Use existing observations', repair_exhausted: stage === 'recovery_failed' }, attempt: 2 } }),
      thinking: (text, position) => { reasoning += text; emit({ type: 'thinking', content: text, timelinePosition: position }); },
      finish: (failed = false) => {
        const assistant = { id: request.generationId, conversationId: request.conversationId, role: 'assistant', content: 'Finished', thinking: reasoning, ...(request.mode === 'agent' ? { taskPlan: structuredClone(plans.get(request.conversationId)) } : {}), createdAt: '2026-10-06' };
        messages.set(request.conversationId, [...request.messages, assistant]);
        runs.set(request.conversationId, []);
        if (failed) {
          const run = { id: 'failed-' + request.generationId, conversationId: request.conversationId, assistantMessageId: null, status: 'error', actionCount: 0, actions: [], taskPlan: structuredClone(plans.get(request.conversationId)), createdAt: new Date().toISOString(), completedAt: new Date().toISOString() };
          runs.set(request.conversationId, [run]); messages.set(request.conversationId, request.messages); emit({ type: 'analysis-run', run });
        }
        emit(failed ? { type: 'error', message: 'HTTP 500 fixture failure' } : { type: 'done', assistant }); resolveSend();
      },
    };
    const branch = (id, content) => {
      const [chatId, entries] = [...messages].find(([, entries]) => entries.some(message => message.id === id));
      const index = entries.findIndex(message => message.id === id);
      const saved = entries.slice(0, index + 1).map(message => message.id === id && content !== undefined ? { ...message, content } : message);
      messages.set(chatId, saved); runs.set(chatId, []); plans.delete(chatId); return saved;
    };
    const settings = { llamaRuntime: { status: 'ready', modelId: 'fixture', contextWindow: 32768, kvCacheType: 'q8_0', kvOffload: true }, modelsPath: '', llamaServerPath: null };
    window.localAi = {
      conversations: { list: async () => chats, update: async (id, patch) => Object.assign(chats.find((chat) => chat.id === id), patch) },
      messages: { list: async (id) => messages.get(id) ?? [], regenerate: async id => branch(id), edit: async (id, content) => branch(id, content) }, analysis: { list: async (id) => runs.get(id) ?? [] },
      agentPlans: { get: async (id) => plans.get(id) ?? null },
      settings: { onLanguageChanged: (listener) => { languageListener = listener; return () => {}; }, get: async () => settings }, hardware: { get: async () => null },
      models: { list: async () => [{ id: 'fixture', name: 'Fixture model', shortName: 'Fixture', installed: true, maxContext: 262144, supportedContextPresets: [32768], reasoning: { thinkingToggle: true, efforts: [] } }] },
      contextEstimate: async () => ({ unknownReasons: [], configuredMaxTokens: 262144 }), contextDiscoveryStatus: async () => ({ busy: false }),
      chat: { permissions: async () => ({ mode: 'trusted', trusted_roots: [] }), grants: async () => [], setPermissions: async (_id, mode) => ({ mode, trusted_roots: [] }), revokeApprovals: async () => true, loopControl: async () => { window.pendingControlCount=(window.pendingControlCount??0)+1; if(window.deferRecovery) await new Promise(resolve=>{window.releaseRecovery=resolve;}); }, onDiagramValidation: () => () => {}, diagramValidationResult: () => {}, stop: async () => {
        const run = { id: `stopped-${request.generationId}`, conversationId: request.conversationId, assistantMessageId: null, reasoningMode: 'fast', status: 'cancelled', actionCount: 1, actions: [{ id: 'stopped-tool', label: 'Stopped attempt tool', kind: 'file_read', state: 'completed', output: 'Stopped attempt observation' }], createdAt: new Date().toISOString(), completedAt: new Date().toISOString(), timeline: [{ id: 'stopped-action', kind: 'activity', activityId: 'stopped-tool', position: 1 }] };
        messages.set(request.conversationId, request.messages); runs.set(request.conversationId, [run]);
        emit({ type: 'analysis-run', run }); emit({ type: 'cancelled' }); resolveSend();
      }, onStream: (callback) => { listener = callback; return () => {}; }, send: (value) => { reasoning = '';request = value; return new Promise((done) => { resolveSend = done; }); } },
    };
  });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.locator('.autonomy-trigger').waitFor();
  await page.locator('.autonomy-trigger').click();
  assert.equal(await page.locator('.autonomy-option').count(),2,'only Ask and scoped Autopilot are exposed, including legacy fixture settings');
  await page.locator('.autonomy-trigger').click();
  await page.waitForSelector('.composer textarea');
  await page.evaluate(() => window.statusFixture.language('en'));
  await page.getByRole('button', { name: 'New chat', exact: true }).waitFor();
  await page.evaluate(() => window.statusFixture.language('ru'));
  await page.getByRole('button', { name: 'Новый чат', exact: true }).waitFor();
  const send = async (text) => { await page.locator('.composer textarea').fill(text); await page.locator('.composer textarea').press('Enter'); await page.waitForSelector('.send-button.stop'); };
  await send('Work on the project');

  await page.evaluate(() => window.statusFixture.budget({ used: 2, limit: 128, maximum: 256, extensions: 0, decision: 'initial', reason: 'initial' }));
  assert.equal(await page.locator('.agent-status-panel').count(), 0, 'simple questions must not show a budget-only panel');
  const memory = { entries: [], plan: { steps: [{ id: '1', text: 'Study the project', status: 'completed' }, { id: '2', text: 'Check implementation', status: 'in_progress' }, { id: '3', text: 'Final verification', status: 'pending' }] }, deliverables: { items: [{ id: 'build', text: 'Game starts', status: 'verified' }, { id: 'theme', text: 'Theme switches', status: 'implemented' }, { id: 'bot', text: 'Bot makes a move', status: 'pending' }] } };
  await page.evaluate((memory) => window.statusFixture.update(memory), memory);
  const panel = page.locator('.composer-wrap .agent-status-panel');
  await panel.waitFor(); assert.equal(await panel.count(), 1);
  assert.equal(await panel.locator('button').getAttribute('aria-expanded'), 'false');
  await panel.locator('button').click();
  await page.evaluate(() => window.statusFixture.budget({ used: 140, limit: 160, maximum: 256, extensions: 1, decision: 'extended', reason: 'changed_code_check_passed' }));
  assert(!/140\/160|Рабочие ходы|Максимум 256/.test(await panel.innerText()));

  assert(await panel.locator('.implemented').innerText().then((text) => text.includes('Реализовано, не проверено')));
  assert(await panel.locator('.verified').innerText().then((text) => text.includes('Проверено')));
  memory.deliverables.items[0].proof = ['ev-runtime'];
  memory.verification = { epoch: 2, records: [
    { id: 'ev-runtime', kind: 'browser', class: 'functional', subject: 'browser runtime', pass: true, epoch: 2, turn: 1, deliverable_ids: ['build'] },
    { id: 'ev-warning', kind: 'test', class: 'functional', subject: 'project suite', pass: false, epoch: 2, turn: 2, baseline_failure: 'ev-baseline', detail: 'independent assertion' },
  ] };
  await page.evaluate((memory) => window.statusFixture.update(memory), memory);
  await panel.getByText('browser runtime — Пройдена').waitFor();
  assert(await panel.innerText().then((text) => text.includes('Предупреждения проекта') && text.includes('Сбой наблюдался до изменений') && text.includes('independent assertion')));
  assert(await panel.locator('.verified').innerText().then((text) => text.includes('Проверено')), 'project warning must not replace the verified acceptance status');
  const position = await page.evaluate(() => ({ panel: document.querySelector('.agent-status-panel').getBoundingClientRect().bottom, composer: document.querySelector('.composer-toolbar').getBoundingClientRect().top }));
  assert(position.composer - position.panel >= 0 && position.composer - position.panel <= 12, 'panel must sit immediately above the composer toolbar');
  await panel.locator('button').click(); assert.equal(await panel.locator('button').getAttribute('aria-expanded'), 'false');
  assert.equal(await panel.locator('li').count(), 0, 'collapsed panel must not keep a hidden full DOM tree');
  assert.match(await panel.innerText(), /План 1\/3.*Результат 1\/3/s);
  memory.plan.steps[1].status = 'completed'; memory.deliverables.items[1].status = 'verified';
  await page.evaluate((memory) => window.statusFixture.update(memory), memory);
  await page.waitForFunction(() => document.querySelector('.agent-status-toggle').textContent.includes('2/3'));
  await panel.locator('button').click();
  for (let index = 0; index < 30; index++) {
    await page.evaluate(({ index, memory }) => {
      window.statusFixture.action({ id: `plan-${index}`, kind: 'planning', detail: 'plan', label: 'Plan', state: 'completed', output: JSON.stringify({ plan: memory.plan }), timelinePosition: index * 2 + 2 });
      window.statusFixture.action({ id: `result-${index}`, kind: 'planning', detail: 'deliverables', label: 'Required result', state: 'completed', output: JSON.stringify({ deliverables: memory.deliverables }), timelinePosition: index * 2 + 3 });
    }, { index, memory });
  }
  assert.equal(await page.locator('.conversation .agent-status-panel, .conversation .task-plan-panel').count(), 0);
  assert.equal(await page.locator('.conversation .agent-timeline-action').filter({ hasText: '140/160' }).count(), 0, 'budget updates must not create timeline cards');
  assert.equal(await page.locator('.agent-timeline-action.planning').count(), 0, 'successful status snapshots must not duplicate into the timeline');
  await page.evaluate(() => {
    for (let index = 0; index < 35; index++) window.statusFixture.thinking(`Reasoning paragraph ${index}.\n\n`, index + 65);
    window.statusFixture.action({ id: 'terminal', kind: 'terminal', label: 'Terminal', state: 'completed', output: JSON.stringify({ command: 'npm test', exit_code: 0, stdout: 'Tests passed' }), timelinePosition: 110 });
  });
  await page.waitForSelector('.agent-timeline-thought');
  await page.waitForTimeout(400);
  const scroll = () => page.evaluate(() => { const node = document.querySelector('.conversation'); return { top: node.scrollTop, remaining: node.scrollHeight - node.scrollTop - node.clientHeight }; });
  assert((await scroll()).remaining < 96, 'stream should keep following at the bottom');
  await page.evaluate(() => { for (const [index, stage] of ['detected', 'soft_recovery', 'paused', 'repair_requested', 'context_excluded', 'recovery_attempted', 'recovery_failed', 'paused', 'continued', 'recovery_succeeded'].entries()) window.statusFixture.loop(stage, 111 + index); });
  await page.waitForSelector('[data-loop-stage="recovery_succeeded"]');
  await page.waitForTimeout(120); // bottom-follow is intentionally scheduled on the next animation frame
  assert.deepEqual(await page.locator('[data-loop-stage]').evaluateAll(nodes => nodes.map(node => node.dataset.loopStage)), ['detected', 'soft_recovery', 'paused', 'repair_requested', 'context_excluded', 'recovery_attempted', 'recovery_failed', 'paused', 'continued', 'recovery_succeeded']);
  assert((await scroll()).remaining < 96, 'recovery events preserve bottom-follow');
  await page.evaluate(() => { window.deferRecovery=true;window.statusFixture.loopState({signature:'pending',level:3,evidence:'same metadata',guidance:'change strategy',repair_exhausted:false},true); });
  const repair=page.locator('.agent-loop-warning .agent-button').first();
  await repair.click();
  await page.locator('.loop-control-pending').waitFor();
  assert(await repair.isDisabled(),'pending control remains disabled until processing completes');
  await repair.evaluate(button=>button.click());
  assert.equal(await page.evaluate(()=>window.pendingControlCount),1,'duplicate recovery requests are serialized');
  assert(await page.locator('.send-button.stop').isEnabled(),'Stop stays available while recovery is pending');
  await page.evaluate(()=>window.releaseRecovery());
  await page.waitForFunction(()=>!document.querySelector('.loop-control-pending'));
  await page.evaluate(()=>window.statusFixture.loopState(null,false));

  await panel.locator('button').click(); await page.waitForTimeout(120);
  assert((await scroll()).remaining < 96, 'status resize preserves bottom-follow');
  await panel.locator('button').click(); await page.waitForTimeout(120);
  assert((await scroll()).remaining < 96, 'expanding details preserves bottom-follow');
  await page.locator('.conversation').evaluate((node) => { node.scrollTop = 0; }); await page.waitForTimeout(100);
  await page.evaluate((memory) => window.statusFixture.update(memory), memory);
  assert.equal((await scroll()).top, 0, 'panel updates must not pull a scrolled-up reader to the bottom');
  await panel.locator('button').click(); await panel.locator('button').click(); await page.waitForTimeout(120);
  assert.equal((await scroll()).top, 0, 'panel resize must preserve an earlier reader');
  await page.evaluate(() => window.statusFixture.loop('detected', 121)); await page.waitForTimeout(120);
  assert.equal((await scroll()).top, 0, 'new recovery events preserve an earlier reader');
  await page.getByRole('button', { name: /Other task/ }).click(); await panel.waitFor({ state: 'detached' });
  await page.getByRole('button', { name: /Current task/ }).click(); await panel.waitFor();
  if (await panel.locator('button').getAttribute('aria-expanded') === 'false') await panel.locator('button').click();
  assert.match(await panel.innerText(), /Результат 2\/3/);
  memory.plan.steps[2].status = 'in_progress';
  await page.evaluate((memory) => window.statusFixture.update(memory), memory);
  await panel.locator('[aria-current="step"]').waitFor();
  assert(!(await panel.innerText()).includes('Сохранённое состояние'));
  await page.evaluate(() => window.statusFixture.finish()); await page.waitForSelector('.send-button:not(.stop)');
  assert.equal(await panel.count(), 0, 'completed panel moves into immutable history');
  const historyCard = page.locator('.task-history-card').first();
  await historyCard.locator('button').first().click();
  await historyCard.getByText('Сохранённое состояние').waitFor();
  assert((await historyCard.innerText()).includes('Незавершённый шаг'));
  assert.equal(await historyCard.locator('[aria-current]').count(), 0, 'historical steps are not active');
  assert.match(await historyCard.innerText(), /План 2\/3/);
  await send('New independent task'); assert.equal(await panel.count(), 0, 'new request starts without old plan');
  await page.evaluate((memory) => window.statusFixture.update(memory), memory);
  await panel.locator('button').click(); await panel.locator('[aria-current="step"]').waitFor();
  assert(!(await panel.innerText()).includes('Сохранённое состояние'));
  await page.evaluate(() => window.statusFixture.finish(true)); await page.waitForSelector('.send-button:not(.stop)');
  assert.equal(await panel.count(), 0, 'failed active panel also moves into history');
  await page.getByRole('button', { name: /Other task/ }).click(); await page.getByRole('button', { name: /Current task/ }).click();
  assert.equal(await panel.count(), 0, 'idle chat reload does not resurrect active panel');
  assert.equal(await page.locator('.task-history-card').count(), 2);
  await page.getByRole('button', { name: /Other task/ }).click();
  await send('Analyze this image');
  await page.evaluate(() => window.statusFixture.thinking('Actual model reasoning.', undefined));
  const chatThought = page.locator('.agent-timeline-thought');
  await chatThought.getByText('Actual model reasoning.').waitFor();
  assert.equal(await chatThought.count(), 1, 'Chat uses one reasoning presentation, not two copies');
  await chatThought.locator('button').click();
  assert.equal(await chatThought.locator('button').getAttribute('aria-expanded'), 'false');
  await chatThought.locator('button').click();
  await page.evaluate(() => window.statusFixture.finish());
  await page.waitForSelector('.send-button:not(.stop)');
  await chatThought.getByText('Actual model reasoning.').waitFor();
  const mode = page.locator('.control').filter({ has: page.locator('select option[value="chat"]') }).locator('select');
  await mode.selectOption('agent');
  assert.equal(await chatThought.count(), 1);
  await mode.selectOption('chat');
  await page.getByRole('button', { name: /Current task/ }).click();
  await page.getByRole('button', { name: /Other task/ }).click();
  await chatThought.getByText('Actual model reasoning.').waitFor();
  assert.equal(await chatThought.count(), 1, 'restored Chat reasoning belongs only to its own message');
  assert.equal(await panel.count(), 0, 'Chat reasoning does not create an Agent progress panel');
  await page.getByRole('button', { name: 'Сгенерировать ответ заново', exact: true }).click();
  await page.waitForSelector('.send-button.stop');
  assert.equal(await chatThought.count(), 0, 'regeneration removes previous answer and its reasoning');
  await page.evaluate(() => window.statusFixture.thinking('Regenerated reasoning.', undefined));
  await chatThought.getByText('Regenerated reasoning.').waitFor();
  await page.evaluate(() => window.statusFixture.finish()); await page.waitForSelector('.send-button:not(.stop)');
  assert.equal(await chatThought.count(), 1);
  await page.getByRole('button', { name: 'Редактировать сообщение', exact: true }).click();
  await page.locator('.message-editor textarea').fill('Edited image question');
  await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await page.waitForSelector('.send-button.stop');
  assert.equal(await chatThought.count(), 0, 'editing removes old reasoning rather than attaching it to the new answer');
  await page.evaluate(() => window.statusFixture.thinking('Edited reasoning.', undefined));
  await chatThought.getByText('Edited reasoning.').waitFor();
  await page.evaluate(() => window.statusFixture.finish()); await page.waitForSelector('.send-button:not(.stop)');
  await send('Answer without thinking');
  await page.evaluate(() => window.statusFixture.finish()); await page.waitForSelector('.send-button:not(.stop)');
  assert.equal(await page.locator('.message.assistant').last().locator('.agent-timeline-thought').count(), 0, 'no model reasoning means no fabricated Thinking section');

  await page.getByRole('button', { name: /Regenerate task/ }).click();
  const thinkingControl = page.locator('.control').filter({ has: page.locator('select option[value="on"]') }).locator('select');
  assert.equal(await thinkingControl.inputValue(), 'off');
  await send('Run the stopped-regenerate fixture');
  await page.locator('.send-button.stop').click();
  await page.getByText('Агент остановлен', { exact: true }).waitFor();
  await thinkingControl.selectOption('on');
  await page.getByRole('button', { name: 'Сгенерировать ответ заново', exact: true }).click();
  await page.waitForSelector('.send-button.stop');
  assert.equal(await page.getByText('Агент остановлен', { exact: true }).count(), 0, 'stopped attempt must not be merged into regeneration');
  assert.equal(await page.getByText('Stopped attempt tool', { exact: false }).count(), 0);
  await page.evaluate(() => window.statusFixture.thinking('Fresh regenerated Agent reasoning.', 1));
  await page.getByText('Fresh regenerated Agent reasoning.', { exact: true }).waitFor();
  await page.evaluate(() => window.statusFixture.finish()); await page.waitForSelector('.send-button:not(.stop)');
  await page.getByRole('button', { name: /Other task/ }).click();
  await page.getByRole('button', { name: /Regenerate task/ }).click();
  await page.getByText('Fresh regenerated Agent reasoning.', { exact: true }).waitFor();
  assert.equal(await page.getByText('Агент остановлен', { exact: true }).count(), 0, 'reopening retains only the new attempt');
  await page.reload(); await panel.waitFor({ state: 'detached' }); // Fixture starts a separate empty process/view.
  assert.deepEqual(errors, []);
  // Final screenshot of the populated projection.
  await send('Inspect UI'); await page.evaluate((memory) => window.statusFixture.update(memory), memory); await panel.waitFor();
  // The collapsed memoized row must tick without any new IPC/output or expansion.
  await page.evaluate(() => window.statusFixture.action({ id: 'clock', kind: 'terminal', state: 'running', startedAt: new Date(Date.now()-3_600_000).toISOString(), terminal: {command:'sleep 10', status:'running', startedAt:new Date(Date.now()-5_000).toISOString()}, timelinePosition:1 }));
  const clock = page.locator('[data-action-id=clock]');
  await clock.locator('.action-elapsed').waitFor();
  assert.match(await clock.locator('.action-elapsed').textContent(), /^[56] [sс]$/, 'use process start, not request/mount time');
  const initialClock = await clock.locator('.action-elapsed').textContent();
  await page.waitForFunction(previous => document.querySelector('[data-action-id=clock] .action-elapsed')?.textContent !== previous, initialClock);
  assert.equal(await clock.locator('button').getAttribute('aria-expanded'),'false');
  assert.equal(await clock.locator('.terminal-running-indicator').count(),1);
  await page.setViewportSize({width:1100,height:800});
  for (const status of ['completed','timed_out','cancelled','error']) {
    await page.evaluate(status => window.statusFixture.action({id:'clock',kind:'terminal',state:status==='completed'?'completed':'error',terminal:{status,startedAt:'2026-10-15T10:00:00Z',finishedAt:'2026-10-15T10:00:03Z'}}),status);
    await page.waitForFunction(() => ['3 с','3 s'].includes(document.querySelector('[data-action-id=clock] .action-elapsed')?.textContent));
    await page.waitForTimeout(1100);
    assert.match(await clock.locator('.action-elapsed').textContent(),/^3 [sс]$/);
    assert.equal(await clock.locator('.terminal-running-indicator').count(),0);
  }
  await page.evaluate(() => window.statusFixture.action({id:'awaiting',kind:'terminal',state:'running',startedAt:new Date().toISOString(),terminal:{command:'printf awaiting',status:'running'},timelinePosition:2}));
  const awaiting=page.locator('.agent-timeline-action.terminal.running');
  assert.equal(await awaiting.locator('.action-elapsed').count(),0,'waiting for approval is not command execution');
  await page.evaluate(() => window.statusFixture.action({id:'awaiting',kind:'terminal',state:'error',finishedAt:new Date().toISOString(),terminal:{status:'error'}}));
  console.log('Terminal lifecycle UI: collapsed live clock, actual process timestamps and terminal-state freeze passed.');
  await page.setViewportSize({width:1440,height:920});
  await page.locator('.conversation').evaluate(node=>{node.scrollTop=node.scrollHeight;node.dispatchEvent(new Event('scroll'));});
  await page.waitForTimeout(150);
  if (process.env.LOCAL_AI_UI_SCREENSHOT) { await mkdir(resolve(process.env.LOCAL_AI_UI_SCREENSHOT, '..'), { recursive: true }); await page.screenshot({ path: process.env.LOCAL_AI_UI_SCREENSHOT }); }
  console.log('Production renderer: scoped passing proof and baseline warnings, live plan/deliverables, collapse/expand, snapshot suppression, chronological reasoning/tools, follow-scroll, chat switching, Continue, completion/failure, Chat reasoning streaming/restoration/regeneration/editing, mode switching, localization passed');
} finally {
  if (browser) await browser.close(); await new Promise((done) => server.close(done));
}
