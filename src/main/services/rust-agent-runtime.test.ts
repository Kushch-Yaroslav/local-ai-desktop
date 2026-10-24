import { ensureAppDirectories } from './paths';
import { setLanguage } from '../../shared/locale';
import assert from 'node:assert/strict';
import type { ChatMessage } from '../../shared/types';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RustAgentRuntime, runtimeTextEvent, splitAgentRunHistory, taskPlan } from './rust-agent-runtime';
import { deliverablesChecklist, displayToolResult, toolResultSummary } from '../../renderer/components/AgentTimeline';

const message = (role: ChatMessage['role'], content: string): ChatMessage => ({
  id: `${role}-${content}`, conversationId: 'test', role, content, createdAt: '2026-01-01T00:00:00.000Z',
});

/** Regression coverage for the Electron→Rust ownership boundary. In each
 * sequence the current prompt must remain a real user node, never an adjacent
 * project/system/assistant record. */
export function runRustAgentRuntimeRegression(): void {
  // The timeline fixtures below verify Russian localized labels.
  setLanguage('ru');
  const scenarios = [
    [message('system', 'Project 1'), message('user', 'first prompt')],
    [message('user', 'old prompt'), message('assistant', 'old answer'), message('user', 'next prompt')],
    [message('system', 'Project 1'), message('user', 'old'), message('assistant', 'answer'), message('system', 'Project 2'), message('user', 'switched project')],
    [message('user', 'regenerated prompt'), message('assistant', 'optimistic placeholder')],
    [message('user', 'completed prompt'), message('assistant', 'completed answer'), message('user', 'next after completion')],
    [message('user', 'old compacted prompt'), message('assistant', 'summary'), message('system', 'compaction context'), message('user', 'next after compaction')],
  ];
  for (const history of scenarios) {
    const split = splitAgentRunHistory(history);
    const expected = history.filter((entry) => entry.role === 'user').at(-1)!;
    assert.equal(split.user, expected.content);
    assert(!split.prior.includes(expected));
  }
  assert.throws(() => splitAgentRunHistory([message('system', 'no prompt')]));
  const plan = taskPlan({ milestones: [{ id: 'goal-1', label: 'Inspect', status: 'in_progress', work_plan: { tasks: [{ id: 'work-1', label: 'Read runtime', status: 'completed' }, { id: 'work-2', label: 'Map IPC', status: 'in_progress' }] } }], active_milestone_id: 'goal-1' });
  assert.equal(plan.activeMilestoneId, 'goal-1');
  assert.equal(plan.milestones?.[0]?.id, 'goal-1');
  assert.equal(plan.milestones?.[0]?.workPlan.tasks[1]?.id, 'work-2');
  // Historical SQLite messages may still contain a removed tool call; generic
  // timeline rendering must remain safe without reactivating its semantics.
  const legacyToolActivity = { id: 'legacy', label: 'Действие агента', detail: 'project_knowledge_read', kind: 'file_read' as const, state: 'completed' as const, output: JSON.stringify({ entries: [{ path: 'sources/App.tsx' }] }) };
  assert.doesNotThrow(() => displayToolResult(legacyToolActivity));
  assert.equal(toolResultSummary(legacyToolActivity), 'project_knowledge_read');
  const partialTerminal = { ...legacyToolActivity, kind: 'terminal' as const, output: JSON.stringify({ command: 'rg api src | head -n 1', exit_code: 141, status: 'partial_success', stdout: 'src/App.tsx:1: api' }) };
  assert.match(displayToolResult(partialTerminal) ?? '', /частичный результат поиска/);
  const deliverables = { id: 'd', label: 'Требуемый результат', detail: 'deliverables', kind: 'planning' as const, state: 'completed' as const, output: JSON.stringify({ updated: true, deliverables: { items: [
    { id: 'd-001', text: 'режим «с ботом» выбирается в интерфейсе', status: 'verified', task: 'бот', proof: ['ev-002'] },
    { id: 'd-002', text: 'переключатель темы', status: 'pending' },
    { id: 'd-003', text: 'тема из чужого проекта', status: 'blocked', reason: 'папка недоступна' },
    { id: 'd-004', text: 'снято пользователем', status: 'dropped', reason: 'пользователь отказался' },
    { id: 'd-005', text: 'сохранение партии', status: 'implemented', failing: 'node check.js (exit 1)' },
    { id: 'd-006', text: 'старый формат', status: 'done' },
  ] } }) };
  assert.equal(toolResultSummary(deliverables), 'проверено 1 из 5 · реализовано, не проверено 2 · осталось 1', 'only verified items count as checked');
  assert.equal(displayToolResult(deliverables), '✓ режим «с ботом» выбирается в интерфейсе\n○ переключатель темы\n⊘ тема из чужого проекта — не выполнено: папка недоступна\n◐ сохранение партии — реализовано, не проверено; проверка не прошла: node check.js (exit 1)\n◐ старый формат — реализовано, не проверено', 'deliverables must render as a checklist, hide dropped items and never show implemented work as checked');
  const planActivity = { id: 'p', label: 'План выполнения', detail: 'plan', kind: 'planning' as const, state: 'completed' as const, output: JSON.stringify({ updated: true, plan: { steps: [{ id: 's1', text: 'прочитать код', status: 'completed' }, { id: 's2', text: 'добавить бота', status: 'in_progress' }, { id: 's3', text: 'запустить проверку', status: 'blocked', note: 'нет браузера' }] } }) };
  assert.equal(toolResultSummary(planActivity), 'шагов выполнено 1 из 3');
  assert.equal(displayToolResult(planActivity), '✓ прочитать код\n▶ добавить бота\n⊘ запустить проверку — нет браузера');
  assert.equal(deliverablesChecklist('not json'), undefined);
  assert.equal(deliverablesChecklist(JSON.stringify({ other: 1 })), undefined);
  const legacy = taskPlan({ steps: [{ id: 'legacy-task', label: 'Old item', status: 'completed' }] });
  const budget = { used: 140, limit: 160, maximum: 256, extensions: 1, decision: 'extended', reason: 'changed_code_check_passed' };
  assert.deepEqual(taskPlan({ milestones: [], workBudget: budget }).workBudget, budget, 'saved budget projection must survive normalization');
  assert.equal(legacy.milestones?.[0]?.workPlan.tasks[0]?.id, 'legacy-task');

  const statusAndFinal = [
    runtimeTextEvent({ type: 'agent_status', content: 'Planning the audit' }, 'run', 1),
    runtimeTextEvent({ type: 'agent_status', content: 'Continuing source inspection' }, 'run', 2),
    runtimeTextEvent({ type: 'content_delta', content: 'Accepted final answer' }, 'run', 2),
  ];
  assert.deepEqual(statusAndFinal.map((event) => event?.type), ['tool', 'tool', 'token']);
  assert.equal(statusAndFinal.filter((event) => event?.type === 'token').map((event) => event?.type === 'token' ? event.content : '').join(''), 'Accepted final answer');
  assert.equal(statusAndFinal[0]?.type === 'tool' && statusAndFinal[0].activity.kind, 'progress');
  assert.equal(statusAndFinal[1]?.type === 'tool' && statusAndFinal[1].activity.output, 'Continuing source inspection');
  assert.equal(runtimeTextEvent({ type: 'withheld_draft', content: 'Rejected answer' }, 'run', 2), null);

}

/** A stand-in runtime that speaks the stdin/stdout protocol: it checks that the structured pause intent reaches the
 * runtime and that its `run_paused` event surfaces as a distinct stream event before completion. */
export async function runSteeringBridgeRegression(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'agent-bridge-'));
  try {
    const script = join(dir, 'fake-runtime.js');
    const received = join(dir, 'received.json');
    writeFileSync(script, `#!/usr/bin/env node
const fs = require('node:fs');
const readline = require('node:readline');
const out = (event) => process.stdout.write(JSON.stringify(event) + '\\n');
const rl = readline.createInterface({ input: process.stdin });
const seen = [];
rl.on('line', (line) => {
  const request = JSON.parse(line); seen.push(request);
  if (request.type === 'run') {
    out({ type: 'work_budget', budget: { used: 140, limit: 160, maximum: 256, extensions: 1, decision: 'extended', reason: 'changed_code_check_passed' } });
    out({ type: 'thinking_delta', content: 'думаю' });
  }
  if (request.type === 'steer') {
    fs.writeFileSync(${JSON.stringify(received)}, JSON.stringify(seen));
    out({ type: 'steering_accepted' }); out({ type: 'steering_applied', content: request.content });
    out({ type: 'pause_started', source: 'user_control' }); out({ type: 'run_paused', checkpoint_turns: 1 });
    out({ type: 'final', content: 'Работа поставлена на паузу.' });
  }
});
`);
    chmodSync(script, 0o755);
    const runtime = new RustAgentRuntime('http://127.0.0.1:1', script);
    const controller = new AbortController();
    const events: string[] = [];
    for await (const event of runtime.stream('model', [message('user', 'task')], [], controller.signal, 4096, 'fast', 'off', 'run-1', undefined, 'conversation')) {
      events.push(event.type);
      if (event.type === 'work-budget') assert.equal(event.budget.limit, 160);
      if (event.type === 'thinking') void runtime.steer('run-1', 'Пауза', 'pause');
    }
    assert.deepEqual(events.filter((type) => type !== 'token'), ['work-budget', 'thinking', 'steering', 'paused', 'done']);
    const requests = JSON.parse(readFileSync(received, 'utf8')) as Array<{ type: string; intent?: string }>;
    assert.equal(requests.find((request) => request.type === 'steer')?.intent, 'pause', 'the pause intent was not forwarded to the runtime');
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

export async function runFatalBridgeRegression(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'agent-fatal-bridge-'));
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2000);
  try {
    const script = join(dir, 'fake-runtime.js');
    writeFileSync(script, `#!/usr/bin/env node
require('node:readline').createInterface({input:process.stdin}).on('line', () => {
 process.stdout.write(JSON.stringify({type:'agent_error',message:'model HTTP status: HTTP/1.1 500 Internal Server Error'}) + '\\n');
});
`);
    chmodSync(script, 0o755);
    const events: import('../../shared/types').StreamEvent[] = [];
    const runtime = new RustAgentRuntime('http://127.0.0.1:1', script);
    for await (const event of runtime.stream('model', [message('user', 'task')], [], controller.signal, 4096, 'fast', 'off', 'failed-run', undefined, 'conversation')) events.push(event);
    assert.equal(controller.signal.aborted, false, 'fatal runtime events must end the stream without waiting for supervisor EOF');
    assert.deepEqual(events.map((event) => event.type), ['error']);
    await assert.rejects(runtime.steer('failed-run', 'continue'), /заверш|актив/i);
  } finally { clearTimeout(timeout); rmSync(dir, {recursive:true, force:true}); }
}
export async function runWorkerExitRegression(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'agent-worker-exit-'));
  try {
    for (const [name, body, executable, expected] of [
      ['unexecutable', '', false, 'error'],
      ['process-death', "process.stderr.write('worker died');process.exit(9)", true, 'error'],
      ['empty-stream', 'process.exit(0)', true, 'error'],
      ['stopped', "process.stdout.write(JSON.stringify({type:'agent_stopped'})+'\\n')", true, 'cancelled'],
    ] as const) {
      const script = join(dir, name + '.js');
      writeFileSync(script, `#!/usr/bin/env node\nrequire('node:readline').createInterface({input:process.stdin}).on('line',()=>{${body}});\n`);
      chmodSync(script, executable ? 0o755 : 0o600);
      const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 2000);
      try {
        const events = [];
        for await (const event of new RustAgentRuntime('http://127.0.0.1:1', script).stream('model', [message('user', 'task')], [], controller.signal, 4096, 'fast', 'off', name)) events.push(event);
        assert.equal(controller.signal.aborted, false, `${name}: terminal stream did not close`);
        assert.deepEqual(events.map(event => event.type), [expected], name);
        if (name === 'unexecutable') assert(events.some(event => event.type === 'error' && event.details?.includes('EACCES')));
      } finally { clearTimeout(timeout); }
    }
  } finally { rmSync(dir, { recursive:true, force:true }); }
}

export async function runInvalidRequestOwnershipRegression(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'agent-invalid-request-'));
  try {
    const script = join(dir, 'fake-runtime.js');
    // Safety deadline also makes the regression finite on the broken version.
    writeFileSync(script, '#!/usr/bin/env node\nsetTimeout(() => process.exit(0), 500);\n');
    chmodSync(script, 0o755);
    const runtime = new RustAgentRuntime('http://127.0.0.1:1', script);
    const stream = runtime.stream('model', [message('system', 'no user')], [], new AbortController().signal, 4096, 'fast', 'off', 'invalid-request');
    await assert.rejects(stream[Symbol.asyncIterator]().next(), /нет текущего сообщения/);
    assert.equal(runtime.hasRun('invalid-request'), false, 'invalid preparation must not retain a worker control');
    await assert.rejects(runtime.steer('invalid-request', 'continue'), /не готов|заверш/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

export async function runRejectedSecurityControlRegression(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'agent-security-control-'));
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 5000);
  try {
    const script = join(dir, 'worker.js'), received = join(dir, 'reply.json');
    writeFileSync(script, `#!/usr/bin/env node
const fs=require('node:fs'),out=e=>process.stdout.write(JSON.stringify(e)+'\\n');
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const r=JSON.parse(line);
 if(r.type==='run')out({type:'thinking_delta',content:'ready'});
 if(r.type==='control'){out({type:'control_rejected',id:r.id,message:'fixture rejected'});out({type:'host_tool_call',id:'open',name:'web_project',arguments:{action:'open'}});}
 if(r.type==='host_tool_result'){fs.writeFileSync(${JSON.stringify(received)},JSON.stringify(r.result));out({type:'final'});}
});`);
    chmodSync(script, 0o755);
    const runtime = new RustAgentRuntime('', script);
    let approvals = 0;
    for await (const event of runtime.stream('fixture', [message('user', 'inspect')], [{id:'p1',slot:1,root:dir,label:'Fixture'}], controller.signal,4096,'fast','auto','rejected-control',undefined,undefined,true,undefined,[],undefined,async () => { approvals++; return {approved:false,reason:'user_rejected'}; })) {
      if (event.type === 'thinking') await assert.rejects(runtime.control('rejected-control',{permissions:{mode:'autonomous',trusted_roots:[]}}), /fixture rejected/);
    }
    assert.equal(controller.signal.aborted,false);
    assert.equal(approvals,1,'rejected control cannot change browser preview authorization');
    assert.equal(JSON.parse(readFileSync(received,'utf8')).code,'PERMISSION_DENIED');
  } finally { clearTimeout(timer); rmSync(dir,{recursive:true,force:true}); }
}
export async function runWebImageBridgeRegression(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'agent-web-images-'));
  try {
    for (const mode of ['auto', 'off'] as const) {
      setLanguage(mode === 'auto' ? 'en' : 'ru');
      const script = join(dir, `${mode}.js`), received = join(dir, `${mode}.json`);
      writeFileSync(script, `#!/usr/bin/env node
const fs = require('node:fs'); let run;
const out = event => process.stdout.write(JSON.stringify(event)+'\\n');
require('node:readline').createInterface({input:process.stdin}).on('line', line => {
 const request = JSON.parse(line);
 if(request.type === 'run') { run = request; out({type:'host_tool_call', id:'web-1', name:'web_open', arguments:{url:'https://example.com'}}); }
 if(request.type === 'host_tool_result') { fs.writeFileSync(${JSON.stringify(received)}, JSON.stringify({run,result:request})); out({type:'final',content:'done'}); }
});`);
      chmodSync(script, 0o755);
      let opened = 0, closed = 0;
      const web = { openSession: async () => { opened++; return { execute: async (call: { name: string; arguments: unknown }) => { assert.equal(call.name, 'web_open'); assert.deepEqual(call.arguments, { url: 'https://example.com' }); return JSON.stringify({ title: 'Example', content: 'Public page', links: [] }); }, close: async () => { closed++; } }; } };
      const runtime = new RustAgentRuntime('http://127.0.0.1:1', script, web as unknown as import('../web/web-tools').WebBrowserService);
      const images = ['data:image/png;base64,iVBORw==', 'data:image/jpeg;base64,/9j/', 'data:image/webp;base64,UklGRg=='];
      const old = { ...message('user', 'old image'), images: [images[0]] };
      const current: ChatMessage = { ...message('user', 'new image'), images, attachments: images.map((_url, index) => ({
        id: `current-image-${index}`, messageId: 'current', index, kind: 'image', mimeType: 'image/png', filename: `${index}.png`, size: 4, storageRef: '/fixture', status: 'ready', createdAt: '', updatedAt: '',
      })) };
      const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 5000);
      try { for await (const _event of runtime.stream('model', [old, message('assistant', 'prior answer'), current], [], controller.signal, 32768, 'fast', mode, `web-${mode}`, undefined, undefined, true, { main: { chat_template_kwargs: { enable_thinking: mode === 'off' } } })) { assert.notEqual(_event.type, 'error'); } }
      finally { clearTimeout(timeout); }
      const request = JSON.parse(readFileSync(received, 'utf8'));
      assert.deepEqual(request.run.user_images, images); assert.deepEqual(request.run.user_image_refs, ['current-image-0', 'current-image-1', 'current-image-2']); assert.deepEqual(request.run.history[0].images, [images[0]]);
      assert.deepEqual(request.run.reasoning_options, { main: { chat_template_kwargs: { enable_thinking: mode === 'off' } } });
      assert.equal(request.run.supports_reasoning, true);
      assert.equal(request.run.ui_language, mode === 'auto' ? 'en' : 'ru');
      assert.match(request.run.system, mode === 'auto' ? /Interface language: English/ : /Язык интерфейса: русский/);
      assert.equal(request.run.web_tools.length, mode === 'auto' ? 6 : 0);
      assert.equal(request.run.artifact_tools.some((tool: { function?: { name?: string } }) => tool.function?.name === 'create_visual_artifact'), true);
      assert.equal(opened, mode === 'auto' ? 1 : 0); assert.equal(closed, opened);
      if (mode === 'auto') assert.equal(request.result.result.content, 'Public page');
      else assert.match(request.result.result.error, /unavailable/);
    }
  } finally { setLanguage('ru'); rmSync(dir, { recursive: true, force: true }); }
}

export async function runAgentRichArtifactBridgeRegression(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'agent-rich-artifact-'));
  try {
    const script = join(dir, 'artifact-worker.js');
    const received = join(dir, 'artifact-result.json');
    writeFileSync(script, `#!/usr/bin/env node
const fs = require('node:fs');
const out = event => process.stdout.write(JSON.stringify(event)+'\\n');
require('node:readline').createInterface({input:process.stdin}).on('line', line => {
 const request = JSON.parse(line);
 if(request.type === 'run') {
   if(!request.artifact_tools.some(tool => tool.function.name === 'create_visual_artifact')) process.exit(3);
   out({type:'host_tool_call', id:'artifact-1', name:'create_visual_artifact', arguments:{artifact:{version:1,type:'chart',chart:'bar',title:'Fixture',xKey:'x',series:[{key:'y',name:'Y'}],data:[{x:'A',y:2}]}}});
 }
 if(request.type === 'host_tool_result') { fs.writeFileSync(${JSON.stringify(received)}, JSON.stringify(request)); out({type:'final',content:'Chart generated.'}); }
});`);
    chmodSync(script, 0o755);
    const runtime = new RustAgentRuntime('http://127.0.0.1:1', script);
    const events: import('../../shared/types').StreamEvent[] = [];
    for await (const event of runtime.stream('model', [message('user', 'Chart this fixture')], [], new AbortController().signal, 4096, 'fast', 'off', 'artifact-run')) events.push(event);
    const artifact = events.find((event) => event.type === 'rich-artifact');
    assert(artifact?.type === 'rich-artifact' && artifact.artifact.type === 'chart', 'Agent host bridge did not emit validated chart data');
    assert.deepEqual(JSON.parse(readFileSync(received, 'utf8')), { type: 'host_tool_result', run_id: 'artifact-run', id: 'artifact-1', result: { accepted: true, artifact_id: artifact.artifact.id, type: 'chart', stage: 'emitted_to_ui', presentation: 'Artifact accepted and emitted to the conversation UI. This is not a renderer acknowledgement. Do not repeat it in Markdown or claim a failed gallery succeeded.' } }, 'Agent bridge did not return structured artifact acceptance');
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
export async function runWebCancellationRegression() {
  const dir = mkdtempSync(join(tmpdir(), 'agent-web-cancel-'));
  try {
    const script = join(dir, 'worker.js');
    writeFileSync(script, `#!/usr/bin/env node
const out = event => process.stdout.write(JSON.stringify(event)+'\\n');
require('node:readline').createInterface({input:process.stdin}).on('line', line => {
 const request = JSON.parse(line);
 if(request.type === 'run') out({type:'host_tool_call',id:'cancel-web',name:'web_read',arguments:{}});
 if(request.type === 'cancel') out({type:'agent_stopped'});
});`); chmodSync(script, 0o755);
    const controller = new AbortController(); let closed = 0;
    let fail: (error: Error) => void = () => {};
    const web = { openSession: async () => ({
      execute: async () => new Promise<string>((_resolve, reject) => { fail = reject; controller.abort(); }),
      close: async () => { closed++; fail(new Error('Browser cancelled')); },
    }) };
    const runtime = new RustAgentRuntime('http://127.0.0.1:1', script, web as unknown as import('../web/web-tools').WebBrowserService);
    const events: string[] = []; const timeout = setTimeout(() => controller.abort(), 3000);
    try { for await (const event of runtime.stream('model', [message('user', 'task')], [], controller.signal, 32768, 'fast', 'auto', 'cancel-web')) events.push(event.type); }
    finally { clearTimeout(timeout); }
    assert(closed > 0, 'Stop did not close the browser session'); assert(events.includes('cancelled'));
    const alreadyStopped = new AbortController(); alreadyStopped.abort();
    const early = [];
    for await (const event of new RustAgentRuntime('', '/does-not-exist').stream('model', [message('user', 'task')], [], alreadyStopped.signal, 32768, 'fast', 'auto', 'early')) early.push(event.type);
    assert.deepEqual(early, ['cancelled']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
/** Protocol fixture: accounting survives the Electron bridge without substituting
 * the post-compaction target for the trigger. No real inference is involved. */
export async function runAccountingBridgeRegression(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'agent-accounting-'));
  try {
    const script = join(dir, 'worker.js');
    const events = [
      { type: 'context_optimized', before: 88956, after: 23337 },
      { type: 'compaction_diagnostics', trigger_reason: 'proactive_threshold', context_window: 110592, projected_input_before: 88956, projected_input_after: 23337, trigger_threshold_tokens: 88473, compaction_target_tokens: 60825, preferred_output_tokens: 8192, safety_reserve_tokens: 1024 },
      { type: 'loop_diagnostics', observations: 222, guidance: 0, warnings: 0, pauses: 0 },
      { type: 'final', content: 'Done' },
    ];
    writeFileSync(script, `#!/usr/bin/env node\nrequire('node:readline').createInterface({input:process.stdin}).on('line',()=>{for(const event of ${JSON.stringify(events)})process.stdout.write(JSON.stringify(event)+'\\n');});\n`);
    chmodSync(script, 0o755);
    const seen: import('../../shared/types').StreamEvent[] = [];
    for await (const event of new RustAgentRuntime('', script).stream('fixture', [message('user', 'task')], [], new AbortController().signal, 110592, 'deep', 'off', 'accounting')) seen.push(event);
    const cards = seen.filter(e => e.type === 'tool');
    assert.equal(cards[0].activity.id, cards[1].activity.id, 'diagnostics must enrich the same compaction card');
    assert.equal(cards[1].activity.metadata?.trigger_threshold_tokens, 88473);
    assert.notEqual(cards[1].activity.metadata?.trigger_threshold_tokens, cards[1].activity.metadata?.compaction_target_tokens);
    assert(seen.some(e => e.type === 'agent-telemetry' && e.telemetry.loopObservations === 222));
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
async function runPermissionTransportRegression(): Promise<void> {
  const dir=mkdtempSync(join(tmpdir(),'permission-bridge-'));
  try {
    const script=join(dir,'runtime.js'),received=join(dir,'reply.json');
    writeFileSync(script, `#!/usr/bin/env node
const fs=require('node:fs');const out=e=>process.stdout.write(JSON.stringify(e)+'\\n');
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const r=JSON.parse(line);
 if(r.type==='run')out({type:'host_tool_call',id:'permission',name:'request_permission',arguments:{operation:'run_terminal',arguments:{command:'printf never-executed'}}});
 if(r.type==='host_tool_result'){fs.writeFileSync(${JSON.stringify(received)},JSON.stringify(r.result));out({type:'final',content:'No operation authorized.'});}
});`);
    chmodSync(script,0o755);
    const abort=new AbortController(),timer=setTimeout(()=>abort.abort(),5000);
    try {
      let receivedEvent = false;
      for await (const event of new RustAgentRuntime('',script).stream('fixture',[message('user','permission failure')],[],abort.signal,4096,'fast','off','permission-regression',undefined,'fixture',false,undefined,[],undefined,async()=>{throw new Error('renderer disconnected');})) { receivedEvent ||= Boolean(event); }
      assert(receivedEvent, 'the bridge emits events while handling the tool result');
      assert(!abort.signal.aborted);
      const result=JSON.parse(readFileSync(received,'utf8'));
      assert.equal(result.code,'PERMISSION_DENIED');assert.equal(result.retrySameArguments,false);
      assert.equal(result.reason,'ui_unavailable');assert.equal(result.approved,false);
    } finally { clearTimeout(timer); }
  } finally {rmSync(dir,{recursive:true,force:true});}
}

async function runProjectBrowserBridgeRegression(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'project-browser-bridge-'));
  try {
    const script = join(dir, 'worker.js'), received = join(dir, 'reply.json');
    writeFileSync(script, `#!/usr/bin/env node
const fs=require('node:fs'); let run; const out=e=>process.stdout.write(JSON.stringify(e)+'\\n');
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const r=JSON.parse(line);
 if(r.type==='run'){run=r;out({type:'host_tool_call',id:'preview',name:'web_project',arguments:{action:'open',path:'index.html'}});}
 if(r.type==='host_tool_result'){fs.writeFileSync(${JSON.stringify(received)},JSON.stringify({run,result:r.result}));out({type:'final',content:'done'});}
});`);
    chmodSync(script, 0o755);
    for (const mode of ['auto', 'off'] as const) {
      const projects = [{ id: 'fixture', slot: 1 as const, root: dir, label: 'Fixture' }];
      const abort = new AbortController(), timer = setTimeout(() => abort.abort(), 5000);
      try {
        // No approval transport: must fail closed before launching a browser.
        for await (const event of new RustAgentRuntime('', script).stream('fixture', [message('user','verify project')], projects, abort.signal,4096,'fast',mode,`preview-${mode}`)) { assert.notEqual(event.type, 'error', JSON.stringify(event)); }
        assert(!abort.signal.aborted);
        const reply = JSON.parse(readFileSync(received,'utf8'));
        assert.equal(reply.run.web_tools.some((tool: { function: { name: string } }) => tool.function.name === 'web_project'), mode === 'auto');
        if (mode === 'auto') assert.equal(reply.result.code, 'PERMISSION_DENIED', JSON.stringify(reply.result));
        else assert.match(reply.result.error,/unavailable/);
      } finally { clearTimeout(timer); }
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

if (require.main === module) {
  ensureAppDirectories();
  runRustAgentRuntimeRegression();
  void (async () => {
    await runProjectBrowserBridgeRegression();
    await runPermissionTransportRegression();
    await runAccountingBridgeRegression();
    await runSteeringBridgeRegression();
    await runFatalBridgeRegression();
    await runWorkerExitRegression();
    await runInvalidRequestOwnershipRegression();
    await runRejectedSecurityControlRegression();
    await runWebImageBridgeRegression();
    await runAgentRichArtifactBridgeRegression();
    await runWebCancellationRegression();
  })().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
}

// A continuation reuses its durable journal rather than reimporting history.
// Current structured evidence must therefore travel with the current user turn.
{
  const user = {...message('user','Inspect selected region'),id:'current-reference'};
  const context = {...message('system','region metadata: text-clipping, original viewport 1920'),id:'regions-'+user.id};
  const split = splitAgentRunHistory([message('user','Earlier task'),context,user]);
  assert(split.user.includes('text-clipping'));
  assert(split.user.startsWith(user.content));
  assert(!split.prior.some(node=>node.id===context.id));
  assert.equal(user.content,'Inspect selected region');
}
