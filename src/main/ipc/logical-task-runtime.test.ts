import assert from 'node:assert/strict';
import Module from 'node:module';
import childProcess from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import type { ChildProcess } from 'node:child_process';
import type { ChatRequest, Conversation, StreamEvent } from '../../shared/types';
import type { LlamaRuntimeState } from '../services/llama-runtime-controller';

/** Real Rust + production IPC, deterministic local model protocol. No inference;
 * only disposable project files, sandbox commands and owned runtime children. */
async function run() {
  const root = mkdtempSync(join(tmpdir(), 'lad-task-runtime-'));
  // A developer project must be separate from protected application data.
  process.env.LOCAL_AI_RUNTIME_ROOT = join(root, 'app-data');
  let phase = 'A', iteration = 0;
  const project = join(root, 'project');
  const prompts: Record<string, unknown>[] = [];
  const provider = createServer((request, response) => {
    const chunks: Buffer[] = []; request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>; prompts.push(body);
      const index = iteration++;
      const call = (name: string, args: unknown) => ({ tool_calls: [{ index: 0, id: `${phase}-${index}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
      let delta: unknown, finish = 'tool_calls';
      if (phase === 'A' || phase === 'B') {
        if (index === 0) delta = call('read_file', { path: phase === 'A' ? 'a.txt' : 'b.txt' });
        else if (index === 1) delta = call('task_memory', { action: 'record', finding: `${phase} isolated finding`, status: 'confirmed', evidence: 'obs-00000001' });
        else { delta = { content: `${phase} complete.` }; finish = 'stop'; }
      } else if (phase === 'verify-code') {
        const ids = ['code','tests','all'];
        if (index === 0) delta = call('write_file', { path: 'calculator.py', content: 'def is_even(n):\n    return n % 2 == 0\n' });
        else if (index === 1) delta = call('write_file', { path: 'test_calculator.py', content: 'import unittest\nfrom calculator import is_even\nclass Tests(unittest.TestCase):\n' + Array.from({length:18},(_,i)=>`    def test_${i}(self):\n        self.assertEqual(is_even(${i}), ${i%2===0 ? 'True':'False'})\n`).join('') + 'if __name__ == "__main__":\n    unittest.main()\n' });
        else if (index === 2 || index === 9) delta = call('run_terminal', { command: `cd '${project}' && python3 test_calculator.py -v`, timeout_ms: 3000, ...(index===9 ? {deliverable_ids:ids}:{}) });
        else if (index >= 3 && index <= 5) delta = call('deliverables', {action:'add',id:ids[index-3],text:`Requested calculator ${ids[index-3]} deliverable`,check:'test',paths:index===5 ? [project] : [join(project,index===3?'calculator.py':'test_calculator.py')]});
        else if (index >= 6 && index <= 8) delta = call('deliverables',{action:'implemented',id:ids[index-6]});
        else if (index >= 10 && index <= 12) delta = call('deliverables',{action:'verify',id:ids[index-10]});
        else { delta={content:'18 tests and three deliverables verified.'};finish='stop'; }
      } else if (phase === 'loop-implemented') {
        if (index < 2) delta=call('deliverables',{action:'add',id:`loop-${index}`,text:`Requested follow-up ${index}`,check:'test'});
        else if (JSON.stringify(body).includes('Selective loop recovery:')) {
          if (!JSON.stringify(body).includes('New information after recovery')) delta=call('read_file',{path:'new-observation.txt'});
          else {delta={content:'Recovered after selective metadata cleanup.'};finish='stop';}
        } else delta=call('deliverables',{action:'implemented',id:`loop-${index%2}`});
      } else if (phase === 'ContinueEdit') {
        if (index === 0) delta = call('write_file', { path: 'a.txt', content: 'A continued edit' });
        else if (index === 1) delta = call('run_terminal', { command: `python3 -c "from pathlib import Path; assert Path('a.txt').read_text() == 'A continued edit'; print('continued-python-ok')"`, timeout_ms: 3000 });
        else { delta = { content: 'Continued task edited and checked.' }; finish = 'stop'; }
      } else if (phase === 'loop-stop') delta = call('deliverables', { action: 'view' });
      else if (phase === 'loop') {
        if (index < 70) delta = call('deliverables', { action: 'view' });
        else if (index === 70) delta = call('read_file', { path: 'new-observation.txt' });
        else { delta = { content: 'New observation after bounded recovery.' }; finish = 'stop'; }
      } else if (index === 0) delta = call('task_memory', { action: 'view' });
      else if (index === 1) delta = call('observation_read', { id: 'obs-00000001' });
      else { delta = { content: 'A continued.' }; finish = 'stop'; }
      const frame = (value: unknown, reason: string | null) => `data: ${JSON.stringify({ choices: [{ index: 0, delta: value, finish_reason: reason }] })}\n\n`;
      response.writeHead(200, { 'content-type': 'text/event-stream' }); response.end(frame(delta, null) + frame({}, finish) + 'data: [DONE]\n\n');
    });
  });
  provider.requestTimeout = 10000;
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
  const address = provider.address(); assert(address && typeof address !== 'string');
  process.env.LOCAL_AI_AGENT_ENDPOINT = `http://127.0.0.1:${address.port}/v1/chat/completions`;
  const cp = childProcess; const spawn = cp.spawn;
  const children: ChildProcess[] = [];
  cp.spawn = ((...args: Parameters<typeof spawn>) => { const child = spawn(...args); children.push(child); return child; }) as typeof spawn;
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const loader = Module as unknown as { _load: (name: string, ...args: unknown[]) => unknown }; const load = loader._load;
  loader._load = (name, ...args) => name === 'electron' ? { ipcMain: { handle: (key: string, fn: (...args: unknown[]) => unknown) => handlers.set(key, fn) } } : load(name, ...args);
  const { paths, ensureAppDirectories } = await import('../services/paths'); ensureAppDirectories();
  const { Database } = await import('../services/database'); const db = new Database();
  const { agentEvidenceDir } = await import('../services/agent-evidence');
  const { LlamaRuntimeController } = await import('../services/llama-runtime-controller');
  const { LlamaCppBackend } = await import('../backends/llama-cpp-backend');
  let runtime: LlamaRuntimeState = { status: 'idle', modelId: null, contextWindow: null };
  LlamaRuntimeController.prototype.state = async () => runtime;
  LlamaRuntimeController.prototype.switchTo = async (modelId, contextWindow) => ({ ok: true, state: runtime = { status: 'ready', modelId, contextWindow } });
  LlamaCppBackend.prototype.ensureModelAvailable = async () => {};
  LlamaCppBackend.prototype.resolveContextWindow = async (_, requested) => ({ requested, active: requested, supported: requested });
  const fetch = globalThis.fetch; globalThis.fetch = async () => new Response(JSON.stringify({ data: [] }), { status: 200 });
  const events: Array<StreamEvent & { generationId: string }> = [];
  let recoveryConversation = '', pauses = 0;
  const controls: Promise<unknown>[] = [];
  const invoke = async <T>(key: string, ...args: unknown[]) => await handlers.get(key)!({ sender: { send: (_key: string, event: StreamEvent & { generationId: string }) => {
    events.push(event);
    if (phase === 'loop' && event.type === 'loop-state' && event.paused && event.notice) {
      pauses += 1;
      // Strong recovery is automatic. Do not race it with a redundant repair command.
      if (event.notice.repair_exhausted) controls.push(invoke('chat:loop-control', recoveryConversation, event.generationId, event.notice.signature, 'continue_anyway'));
    }
    if (phase === 'loop-stop' && event.type === 'loop-state' && event.paused) controls.push(invoke('chat:stop', recoveryConversation, event.generationId));
  } } }, ...args) as T;
  try {
    const { registerIpc } = await import('./register-ipc'); registerIpc();
    const model = 'qwen3.8:27b-q4_K_M'; mkdirSync(project);
    writeFileSync(join(project, 'a.txt'), 'A source'); writeFileSync(join(project, 'b.txt'), 'B source');
    const chat = await invoke<Conversation>('conversations:create');
    await invoke('conversations:update', chat.id, { modelId: model, mode: 'agent', workingDirectory: project, webMode: 'off' });
    const send = async (generationId: string, text: string, continuation?: string) => {
      const request: ChatRequest = { conversationId: chat.id, generationId, model, mode: 'agent', persistUserMessage: true, continueLogicalTaskId: continuation, messages: [...db.listMessages(chat.id), { id: generationId + '-user', conversationId: chat.id, role: 'user', content: text, createdAt: new Date().toISOString() }] };
      const timeout = setTimeout(() => { void invoke('chat:stop', chat.id, generationId); }, 15000);
      try { await invoke('chat:send', request); } finally { clearTimeout(timeout); }
      assert(!events.some(event => event.generationId === generationId && ['error', 'cancelled', 'approval-request'].includes(event.type)), JSON.stringify(events.filter(event => event.generationId === generationId)));
      const run = db.listAnalysisRuns(chat.id).at(-1)!; assert.equal(run.status, 'completed');
      assert(!run.actions.some(action => action.state === 'error'), JSON.stringify(run.actions.filter(action => action.state === 'error')));
      return run;
    };
    const a = await send('task-A', 'Inspect a.txt and remember the observed finding.');
    assert.equal(a.taskPlan?.taskMemory?.entries[0]?.finding, 'A isolated finding');
    const frozen = JSON.stringify(a.taskPlan);
    const lineage = (taskId: string) => JSON.parse(readFileSync(join(agentEvidenceDir(paths.userData, chat.id, taskId), 'active.json'), 'utf8')) as { run_dir: string };
    const firstLineage = lineage(a.logicalTaskId!).run_dir;
    phase = 'B'; iteration = 0; const b = await send('task-B', 'Inspect b.txt and remember its independent finding.');
    assert.notEqual(a.logicalTaskId, b.logicalTaskId); assert.equal(b.taskPlan?.taskMemory?.entries[0]?.finding, 'B isolated finding');
    assert.equal(b.taskPlan?.taskMemory?.entries.length, 1);
    await invoke('chat:set-permissions',chat.id,'autonomous',false);
    await invoke('conversations:update',chat.id,{workingDirectory:null});
    assert.equal((await invoke<{mode:string}>('chat:permissions',chat.id)).mode,'autonomous');
    phase = 'Continue'; iteration = 0; const offset = prompts.length;
    const continued = await send('continue-A', 'Continue the first task: show its memory and recover its saved observation.', a.logicalTaskId);
    assert.equal(continued.logicalTaskId, a.logicalTaskId); assert.equal(lineage(a.logicalTaskId!).run_dir, firstLineage, 'interleaved independent request must not break canonical task journal continuity');
    assert.equal(continued.taskPlan?.taskMemory?.entries[0]?.finding, 'A isolated finding');
    assert(!JSON.stringify(prompts.slice(offset)).includes('B isolated finding'), 'unrelated task evidence/context never enters continuation');
    assert.equal(JSON.stringify(db.listAnalysisRuns(chat.id)[0].taskPlan), frozen);
    assert(JSON.stringify(prompts.slice(offset)).includes('A source'), 'selected task observations remain recoverable after another task');
    console.log(`production IPC + real Rust: A → B → Continue A passed (${prompts.length} deterministic model requests); separate journals, confirmed memory, immutable snapshots, observation recovery`);
    assert(db.getTaskScope(chat.id,a.logicalTaskId!)?.projects.some(p=>p.root===project),'scope was restored without evidence reset');
    phase='ContinueEdit'; iteration=0;
    const edited = await send('continue-no-ui-project','Continue A: edit and run a Python assertion.',a.logicalTaskId);
    assert.equal(edited.logicalTaskId,a.logicalTaskId);
    assert.equal(readFileSync(join(project,'a.txt'),'utf8'),'A continued edit');
    assert(JSON.stringify(edited.actions).includes('continued-python-ok'));
    assert.equal(db.getConversation(chat.id)?.workingDirectory,null,'restoration must not change UI project settings');
    assert.equal(JSON.stringify(db.listAnalysisRuns(chat.id)[0].taskPlan),frozen);
    await invoke('chat:set-permissions',chat.id,'strict',false);
    assert.equal((await invoke<{mode:string}>('chat:permissions',chat.id)).mode,'strict');
    console.log('production IPC + real Rust: no-UI-project continuation restores only its task scope; Autopilot edit/Python, mode switching, no prompts and unchanged historical snapshot passed');
    await invoke('chat:set-permissions',chat.id,'autonomous',false);
    await invoke('conversations:update',chat.id,{workingDirectory:project});
    phase='verify-code';iteration=0;
    const verified=await send('verified-python','Create calculator and eighteen unittest checks; verify three deliverables.');
    assert.equal(verified.taskPlan?.taskMemory?.deliverables?.items.filter(item=>item.status==='verified').length,3);
    const ledger=verified.taskPlan?.taskMemory?.verification;
    assert(ledger?.records.some(record=>record.kind==='test' && record.pass && record.epoch===ledger.epoch));
    const savedVerified=JSON.stringify(verified.taskPlan);
    writeFileSync(join(project,'new-observation.txt'),'New information after recovery');
    await invoke('conversations:update',chat.id,{workingDirectory:null});
    phase='loop-implemented';iteration=0;
    const promptStart=prompts.length;
    const repaired=await send('implemented-loop','Continue calculator: inspect the next concrete task step instead of repeating implemented.',verified.logicalTaskId);
    const repairEvents=repaired.timeline?.flatMap(event=>event.kind==='loop'?[event.lifecycle]:[])??[];
    assert(repairEvents.some(event=>event.stage==='soft_recovery'));
    assert.equal(repairEvents.filter(event=>event.stage==='context_excluded').length,1);
    const nextRequest=prompts.slice(promptStart).find(prompt=>JSON.stringify(prompt).includes('Selective loop recovery:'))!;
    assert(nextRequest,'cleanup must affect the actual next HTTP model request');
    const modelMessages=nextRequest.messages as Array<Record<string,unknown>>;
    const retainedCalls=modelMessages.flatMap(message=>(message.tool_calls??[]) as Array<{id:string;function:{name:string;arguments:string}}>);
    const loopCalls=retainedCalls.filter(call=>call.function.name==='deliverables' && JSON.parse(call.function.arguments).action==='implemented' && JSON.parse(call.function.arguments).id.startsWith('loop-'));
    assert.equal(loopCalls.length,4,'preserve initial status transitions and first complete stable cycle, not repetitive successors');
    const loopActions=repaired.actions.filter(action=>action.toolName==='deliverables' && action.arguments?.action==='implemented');
    assert(loopActions.length<20,'Stage B must not wait for a second twenty-action threshold');
    assert(loopActions.length>loopCalls.length,'full persisted history retains excluded actions');
    assert(JSON.stringify(nextRequest).includes('calculator.py'),'productive coding observations remain available');
    assert.equal(JSON.stringify(db.listAnalysisRuns(chat.id).find(run=>run.id===verified.id)?.taskPlan),savedVerified,'earlier verified snapshot stays immutable');
    assert.equal(repaired.logicalTaskId,verified.logicalTaskId);
    console.log('production IPC + real Rust: 18 actual unittest tests, late registration, 3/3 verification; alternating implemented recovery, exact cleaned HTTP payload and immutable history passed');
    await invoke('chat:set-permissions',chat.id,'strict',false);
    if (process.env.LOCAL_AI_TEST_LOOP_RECOVERY === '1') {
      writeFileSync(join(project, 'new-observation.txt'), 'New information after recovery');
      phase = 'loop'; iteration = 0; recoveryConversation = chat.id;
      const recovered = await send('task-loop', 'Continue A; observe bounded recovery without changing files.', a.logicalTaskId);
      await Promise.all(controls);
      assert(pauses >= 2, 'failed repair and manual continuation must pause again');
      const lifecycle = recovered.timeline?.flatMap(event => event.kind === 'loop' ? [event.lifecycle] : []) ?? [];
      assert.equal(lifecycle.filter(event => event.stage === 'repair_requested').length, 0);
      assert.equal(lifecycle.filter(event => event.stage === 'context_excluded').length, 2, 'both confirmed-loop repairs clean only model-facing context');
      assert(lifecycle.some(event => event.stage === 'soft_recovery'), 'suspected loop injects a soft warning without cleanup');
      assert(lifecycle.filter(event => event.stage === 'recovery_failed').length >= 2);
      assert(lifecycle.filter(event => event.stage === 'paused').length >= 2);
      assert(lifecycle.some(event => event.stage === 'paused' && event.notice.repair_exhausted));
      assert.equal(lifecycle.at(-1)?.stage, 'recovery_succeeded');
      assert(prompts.some(prompt => JSON.stringify(prompt).includes('This is task metadata only')));
      assert(iteration >= 72 && iteration <= 74, 'tool recovery and bounded final verification review must terminate');
      assert.equal(JSON.stringify(db.listAnalysisRuns(chat.id)[0].taskPlan), frozen);
      console.log('production IPC + real Rust: 70 repeated views and bounded final review, repeated pauses, 2 selective repairs, soft recovery, manual Continue and observed progress persisted chronologically');
      phase = 'loop-stop'; iteration = 0;
      const stopId = 'stop-live-loop';
      await invoke('chat:send', { conversationId: chat.id, generationId: stopId, model, mode: 'agent', persistUserMessage: true, continueLogicalTaskId: a.logicalTaskId, messages: [...db.listMessages(chat.id), { id: stopId + '-user', conversationId: chat.id, role: 'user', content: 'Continue A; stop the isolated loop fixture.', createdAt: new Date().toISOString() }] });
      await Promise.all(controls);
      const stopped = db.listAnalysisRuns(chat.id).at(-1)!;
      assert.equal(stopped.status, 'cancelled');
      assert(stopped.timeline?.some(event => event.kind === 'loop' && event.lifecycle.stage === 'paused'));
      const viewed = stopped.actions.filter(action => action.toolName === 'deliverables' && action.arguments?.action === 'view').length;
      assert.equal(viewed, 11, `Stop must release the live loop pause at 11 repeated view calls; provider requests=${iteration}`);
      phase = 'resume-after-loop'; iteration = 0;
      const resumed = await send('resume-loop', 'Continue the stopped logical task using its saved observation.', a.logicalTaskId);
      assert.equal(resumed.logicalTaskId, a.logicalTaskId);
      assert.equal(JSON.stringify(db.listAnalysisRuns(chat.id)[0].taskPlan), frozen);
      console.log('production IPC + real Rust: Stop at a live loop pause and fresh task continuation completed without inherited suppression');
    }
  } finally {
    globalThis.fetch = fetch; loader._load = load; cp.spawn = spawn;
    // Wait for our ChildProcess handles, never find or signal another runtime.
    await Promise.all(children.map(child => new Promise<void>(resolve => {
      if (!child.pid || child.exitCode !== null || child.signalCode !== null) { resolve(); return; }
      const timer = setTimeout(() => { child.kill('SIGKILL'); }, 2000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
      child.stdin?.end(); child.kill('SIGTERM');
    })));
    provider.closeAllConnections(); await new Promise<void>(resolve => provider.close(() => resolve())); db.close(); rmSync(root, { recursive: true, force: true });
  }
}
void run().catch(error => { console.error(error); process.exitCode = 1; });
