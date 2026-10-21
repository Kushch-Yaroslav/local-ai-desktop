import assert from 'node:assert/strict';
import Module, { createRequire } from 'node:module';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Conversation } from '../../shared/types';
import type { LlamaRuntimeState } from '../services/llama-runtime-controller';
import type { ContextDiscoveryResult, ContextDiscoveryProgress, RuntimeContextEstimate } from '../../shared/context-estimator';

/** Shared unit/Electron fixture: real IPC handlers + SQLite, mocked GPU,
 * process state and discovery. Never contacts or signals a user server. */
export async function contextProfileFixture(root: string, realElectron = false, fixtureModel = 'qwen3.8:27b-q4_K_M') {
  process.env.LOCAL_AI_RUNTIME_ROOT = root;
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const loader = Module as unknown as { _load: (name: string, ...args: unknown[]) => unknown };
  const originalLoad = loader._load;
  if (!realElectron) loader._load = (name, ...args) => name === 'electron' ? { ipcMain: { handle: (channel: string, handler: (...args: unknown[]) => unknown) => handlers.set(channel, handler) } } : originalLoad(name, ...args);
  const { ensureAppDirectories } = await import('../services/paths'); ensureAppDirectories();
  // Never depend on the developer's sibling GGUF directory or launcher. This
  // fixture must behave identically in a clean source snapshot and after restart.
  const runtimeSettings = await import('../services/runtime-settings');
  if (!existsSync(runtimeSettings.settingsFile)) {
    const config = runtimeSettings.normalizeConfiguration({ ...runtimeSettings.loadRuntimeConfiguration(), models: {} });
    const modelsPath = join(root, 'fixture-models'); mkdirSync(modelsPath, { recursive: true });
    const u64 = (n: number) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
    const text = (s: string) => Buffer.concat([u64(Buffer.byteLength(s)), Buffer.from(s)]);
    const header = Buffer.alloc(24); header.write('GGUF'); header.writeUInt32LE(3, 4); header.writeBigUInt64LE(1n, 16);
    const type = Buffer.alloc(4); type.writeUInt32LE(8);
    const gguf = Buffer.concat([header, text('general.architecture'), type, text('fixture')]);
    const server = join(root, 'fixture-llama-server'); writeFileSync(server, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const models = config.models.map((model, index) => {
      const modelPath = join(modelsPath, `model-${index}.gguf`);
      const modelHeader=Buffer.from(header);modelHeader.writeBigUInt64LE(2n,16);const architecture=model.id.startsWith('qwen3.6:')?'qwen35moe':'qwen35';const template='{% if enable_thinking %}thinking{% endif %}'+(model.id.startsWith('qwen3.6:')?'':'{{ reasoning_effort }} xhigh');
      writeFileSync(modelPath,Buffer.concat([modelHeader,text('general.architecture'),type,text(architecture),text('tokenizer.chat_template'),type,text(template)]));
      const mmprojPath = model.mmprojPath ? join(modelsPath, `projector-${index}.gguf`) : '';
      if (mmprojPath) writeFileSync(mmprojPath, gguf);
      return { ...model, modelPath, mmprojPath };
    });
    writeFileSync(runtimeSettings.settingsFile, JSON.stringify({ ...config, modelsPath, models, llamaServerPath: server, setupDismissed: true, language: 'en' }));
  }
  const v2=process.env.LOCAL_AI_TEST_PROFILES_V2==='1';
  if(v2){
    const config=runtimeSettings.loadRuntimeConfiguration();writeFileSync(config.llamaServerPath!, '#!/bin/sh\necho "--model --ctx-size --port --fit --fit-target --load-mode --n-cpu-moe --cpu-moe --threads --threads-batch --batch-size --ubatch-size --flash-attn --override-tensor"\n', {mode:0o755});const modelPath=join(config.modelsPath,'harmony.gguf');
    const u32=(n:number)=>{const b=Buffer.alloc(4);b.writeUInt32LE(n);return b;},u64=(n:number)=>{const b=Buffer.alloc(8);b.writeBigUInt64LE(BigInt(n));return b;},str=(s:string)=>Buffer.concat([u64(Buffer.byteLength(s)),Buffer.from(s)]);
    const metadata={'general.architecture':'gpt-oss','general.file_type':15,'gpt-oss.block_count':36,'gpt-oss.expert_count':128,'gpt-oss.context_length':131072,'tokenizer.chat_template':'<|start|>assistant<|message|>{{ reasoning_effort }} {% if tools %}tools{% endif %}'};
    const entries=Object.entries(metadata);writeFileSync(modelPath,Buffer.concat([Buffer.from('GGUF'),u32(3),u64(0),u64(entries.length),...entries.flatMap(([k,v])=>[str(k),u32(typeof v==='string'?8:4),typeof v==='string'?str(v):u32(v)])]));
    runtimeSettings.saveRuntimeConfiguration({...config,models:[...config.models.filter(m=>m.id!==fixtureModel),{id:fixtureModel,displayName:'GPT-OSS fixture',modelPath,mmprojPath:'',gpuLayers:12,supportsTools:true,speculative:'none',mtpMode:'off',builtin:false}]});
  }
  const { Database } = await import('../services/database');
  const { LlamaRuntimeController } = await import('../services/llama-runtime-controller');
  const backend = await import('../backends/llama-cpp-backend');
  const discovery = await import('../services/context-discovery');
  const gguf = await import('../services/gguf-context');
  const artifacts = await import('../services/gguf-artifacts');
  const hardware = await import('../services/hardware');
  const estimates = await import('../services/context-estimate');
  const fs = createRequire(__filename)('node:fs/promises') as typeof import('node:fs/promises');
  const { createVramBudget } = await import('../../shared/vram-budget');
  const { buildContextDiscoveryIdentity, contextDiscoveryKey } = await import('../services/context-discovery-persistence');
  const { llamaRuntimeProfile } = await import('../models/llama-runtime-policy');
  const modelId = fixtureModel, GiB = 1024 ** 3;
  const modelLimit=Number(process.env.LOCAL_AI_CONTEXT_FIXTURE_LIMIT ?? 262144);
  const realFetch = globalThis.fetch;
  globalThis.fetch = async input => {
    const url = input instanceof Request ? input.url : String(input);
    if (new URL(url).pathname === '/v1/models') return new Response(JSON.stringify({ data: [{ id: modelId, meta: { n_ctx_train: modelLimit } }] }));
    throw new Error(`Unexpected HTTP request in context fixture: ${new URL(url).pathname}`);
  };
  const fp16 = fixtureModel.startsWith('qwen3.6:') ? 110592 : 73728, q8 = fixtureModel.startsWith('qwen3.6:') ? 163840 : 110592;
  let state: LlamaRuntimeState = { status: 'idle', modelId: null, contextWindow: null };
  let pressure = false, startupFailure = false, discoveryFailure = false, mismatch = false, freshPair = false;
  let backgroundMiB = 1024, missingTelemetry = false, incompleteTelemetry = false, telemetryDelayMs = 0, budgetReads = 0;
  let nearBoundary = false, loadDelayMs = 0;
  const launches: Array<{ contextWindow: number; kvCacheType: string }> = [];
  const budget = () => {
    // Pressure consumes the reserved capacity, not just the baseline tolerance.
    const driver = nearBoundary ? 457 * 1024 ** 2 : 0;
    const background = pressure ? 4 * GiB - driver : backgroundMiB * 1024 ** 2;
    return createVramBudget(24 * GiB, 20 * GiB + background, 4 * GiB - background - driver, 20 * GiB);
  };
  const args = () => ['/fixture/llama-server', '-m', llamaRuntimeProfile(modelId)!.modelPath!, '--ctx-size', String(state.contextWindow ?? 32768), '--cache-type-k', state.kvCacheType ?? 'f16', '--cache-type-v', state.kvCacheType ?? 'f16', '--kv-offload', '--gpu-layers', mismatch ? '1' : '999'];
  hardware.getGpuIdentity = async () => ({ name: 'Fixture GPU', vramTotalBytes: 24 * GiB });
  hardware.getHardwareStats = async () => ({}) as Awaited<ReturnType<typeof hardware.getHardwareStats>>;
  hardware.getOwnedServerVramBudget = async () => {
    budgetReads++;
    if (telemetryDelayMs) await new Promise(resolve => setTimeout(resolve, telemetryDelayMs));
    if (missingTelemetry) throw new Error('fixture telemetry temporarily unavailable');
    return budget();
  };
  artifacts.ggufArtifactFingerprint = () => 'fixture-size:mtime';
  gguf.llamaCapabilityLimit = async () => modelLimit;
  const read = fs.readFile;
  fs.readFile = (async (...params: unknown[]) => params[0] === `/proc/${process.pid}/cmdline` ? args().join('\0') : Reflect.apply(read, fs, params)) as typeof fs.readFile;
  backend.LlamaCppBackend.prototype.getStatus = async () => ({ available: true });
  backend.LlamaCppBackend.prototype.getRuntimeContextEvidence = async () => null;
  estimates.collectRuntimeContextEstimate = async () => ({ backend: 'llama-cpp', modelId, configuredMaxTokens: modelLimit, modelTrainContextTokens: modelLimit,
    observedContextTokens: state.contextWindow, status: 'estimated', activeKvCacheType: state.kvCacheType, activeKvOffload: true,
    memoryBaseline: incompleteTelemetry ? null : { hostAvailableBytes: 50 * GiB, deviceAvailableBytes: 24 * GiB }, memoryHeadroom: { hostBytes: 40 * GiB, deviceBytes: 3 * GiB },
    unknownReasons: [], vramBudget: budget(), modelFileSizeBytes: 10 * GiB, observedResidentBytes: null, observedDeviceResidentBytes: null, hardwareSafeTokens: 262144, source: 'startup-log', estimator: null,
    allocationEvidence: { contextTokens: state.contextWindow ?? 32768, sequenceSlots: 1, speculativeSlots: 1, speculativeMode: 'mtp', kvTypeK: state.kvCacheType ?? 'f16', kvTypeV: state.kvCacheType ?? 'f16', speculativeKvTypeK: state.kvCacheType ?? 'f16', speculativeKvTypeV: state.kvCacheType ?? 'f16', unknownReasons: [], allocations: { kv: { device: GiB }, speculativeKv: { device: 0 }, weights: { device: 19 * GiB }, compute: { device: 0 }, speculativeWeights: { device: 0 }, speculativeCompute: { device: 0 }, output: { device: 0 }, ssm: { device: 0 } } },
  }) as RuntimeContextEstimate;
  LlamaRuntimeController.prototype.state = async () => state;
  LlamaRuntimeController.prototype.switchTo = async (id, contextWindow, kvCacheType = 'f16', kvOffload = true, _projectorDevice, mtpMode) => {
    launches.push({ contextWindow, kvCacheType });
    const configured=runtimeSettings.effectiveRuntimeConfiguration().models.find(m=>m.id===id);
    if(v2&&configured?.gpuLayers===20){state={...state,rolledBack:true,error:'fixture CUDA out of memory (controlled failure)'};return {ok:false,state,error:state.error!};}
    if (loadDelayMs) await new Promise(resolve=>setTimeout(resolve,loadDelayMs));
    if (mismatch) return { ok: false, state, error: 'fixture configuration mismatch' };
    if (startupFailure && contextWindow !== 16384) { state = { ...state, rolledBack: true, error: 'fixture CUDA out of memory' }; return { ok: false, state, error: state.error! }; }
    state = { status: 'ready', modelId: id, contextWindow, kvCacheType, kvOffload, serverPid: process.pid, launcherPid: process.pid, speculativeMode: mtpMode === 'off' ? 'none' : 'mtp', ...(mtpMode ? { mtpMode } : {}),...(v2?{profileFingerprint:(await import('../services/runtime-profile-identity')).runtimeProfileFingerprint(id),profileConfiguration:configured,launchArguments:['/fixture/llama-server','--gpu-layers',String(configured?.gpuLayers)]}:{}) };
    return { ok: true, state };
  };
  if(v2)LlamaRuntimeController.prototype.unload=async()=>{state={status:'stopped',modelId:null,contextWindow:null};return {ok:true,state};};
  const db = new Database(); const existing = db.listConversations()[0]; const chat = existing ?? db.createConversation(modelId);
  if (!existing) {
    db.updateConversation(chat.id, { contextWindow: fp16, llamaKvCacheType: 'f16' });
    db.addMessage(chat.id, 'user', 'History must survive context selection'); db.addMessage(chat.id, 'assistant', 'Saved answer');
  }
  const option = (contextWindow: number, kvCacheType: 'f16' | 'q8_0') => {
    const llmMiB = kvCacheType === 'f16' ? 22554 : 22544;
    const measured = nearBoundary ? createVramBudget(24 * GiB, (1142 + llmMiB) * 1024 ** 2, (24576 - 1142 - llmMiB - 457) * 1024 ** 2, llmMiB * 1024 ** 2) : budget();
    return { modelId, contextWindow, kvCacheType, kvOffload: true, discoveredAt: new Date().toISOString(), memoryBaseline: { hostAvailableBytes: 50 * GiB, deviceAvailableBytes: 24 * GiB }, measuredHeadroom: { hostBytes: 40 * GiB, deviceBytes: measured.freeBytes }, vramBudget: measured };
  };
  const key = contextDiscoveryKey(buildContextDiscoveryIdentity({ modelId, modelFingerprint: 'fixture-size:mtime', projectorFingerprint: llamaRuntimeProfile(modelId)!.mmprojPath ? 'fixture-size:mtime' : null, runtimeFingerprint: '/fixture/llama-server:fixture-size:mtime', arguments: args(), speculative: 'mtp', hardLimit: 262144, gpu: { name: 'Fixture GPU', vramTotalBytes: 24 * GiB }, hostReserveBytes: 8 * GiB }));
  if (!db.loadLatestContextDiscoveryOptions(modelId).length) db.saveContextDiscoveryOptions(key.key, key.serialized, [option(fp16, 'f16'), option(q8, 'q8_0')]);
  discovery.discoverContextBoundary = async deps => {
    deps.progress('fixture probing', 1);
    await new Promise(resolve => setTimeout(resolve, 150));
    await deps.restore();
    if (discoveryFailure) throw new Error('fixture interrupted discovery');
    return { modelId, options: [option(freshPair ? 77824 : fp16, 'f16'), option(freshPair ? 114688 : q8, 'q8_0')], unsupported: [], restored: true, probeContextTokens: 16384 };
  };
  const { registerIpc } = await import('./register-ipc'); registerIpc();
  const streamEvents: Array<{ type?: string; message?: string; details?: string }> = [];
  const invoke = async <T>(channel: string, ...params: unknown[]) => await handlers.get(channel)!({ sender: { send(_channel: string, value: { type?: string; message?: string; details?: string }) { streamEvents.push(value); } } }, ...params) as T;
  return { db, chat, modelId, fp16, q8, launches, streamEvents, invoke, key, budgetReads: () => budgetReads, state: () => state, set: (flags: { loadDelayMs?: number; pressure?: boolean; startupFailure?: boolean; discoveryFailure?: boolean; mismatch?: boolean; freshPair?: boolean; cold?: boolean; backgroundMiB?: number; missingTelemetry?: boolean; incompleteTelemetry?: boolean; telemetryDelayMs?: number; nearBoundary?: boolean }) => {
    if (flags.cold) state = { status: 'idle', modelId: null, contextWindow: null };
    loadDelayMs = flags.loadDelayMs ?? loadDelayMs;
    freshPair = flags.freshPair ?? freshPair;
    backgroundMiB = flags.backgroundMiB ?? backgroundMiB;
    missingTelemetry = flags.missingTelemetry ?? missingTelemetry;
    incompleteTelemetry = flags.incompleteTelemetry ?? incompleteTelemetry;
    telemetryDelayMs = flags.telemetryDelayMs ?? telemetryDelayMs;
    nearBoundary = flags.nearBoundary ?? nearBoundary;
    pressure = flags.pressure ?? pressure; startupFailure = flags.startupFailure ?? startupFailure; discoveryFailure = flags.discoveryFailure ?? discoveryFailure; mismatch = flags.mismatch ?? mismatch;
  }, close: () => { fs.readFile = read; loader._load = originalLoad; globalThis.fetch = realFetch; } };
}

async function run() {
  const root = mkdtempSync(join(tmpdir(), 'context-profiles-'));
  const f = await contextProfileFixture(root, false, 'qwen3.6:35b-a3b-ud-q4_k_m');
  const { fp16, q8 } = f;
  try {
    await f.invoke('conversations:update', f.chat.id, { workingDirectory: root });
    const permission = await f.invoke<{ mode: string; trusted_roots: string[] }>('chat:set-permissions', f.chat.id, 'autonomous', false);
    assert.equal(permission.mode, 'autonomous'); assert.deepEqual(permission.trusted_roots, []);
    await f.invoke('conversations:update', f.chat.id, { workingDirectory: null });
    assert.equal((await f.invoke<{mode:string}>('chat:permissions', f.chat.id)).mode,'autonomous','Autopilot remains enabled without a selected project');
    assert.deepEqual((await f.invoke<{ trusted_roots: string[] }>('chat:permissions', f.chat.id)).trusted_roots, [], 'workspace removal does not introduce hidden permission switches');
    const catalog = await f.invoke<ContextDiscoveryProgress>('context:discovery-status', f.modelId);
    assert.equal(catalog.result?.pendingValidation, true); assert.deepEqual(catalog.result?.options.map(o => o.contextWindow), [fp16, q8]); assert.equal(f.launches.length, 0);
    f.set({ startupFailure: true });
    await assert.rejects(f.invoke('conversations:update', f.chat.id, { modelId: f.modelId }), /fixture CUDA out of memory/);
    assert.equal(f.db.getConversation(f.chat.id)?.contextWindow, fp16); assert.notEqual(f.state().contextWindow, 16384, 'explicit loading must not start a baseline');
    assert.deepEqual(f.launches, [{ contextWindow: fp16, kvCacheType: 'f16' }]);
    const refused = await f.invoke<LlamaRuntimeState>('runtime:state');
    assert.equal(refused.activation?.contextWindow, fp16); assert.equal(refused.activation?.kvCacheType, 'f16');
    assert.match(refused.activation?.error ?? '', /Не загружено.*108K f16/);
    await f.invoke('chat:send', { conversationId: f.chat.id, generationId: 'refused-selection', model: f.modelId, persistUserMessage: true, messages: [{ id: 'blocked', role: 'user', content: 'Do not use a fallback.' }] });
    assert(f.streamEvents.some(event => event.type === 'error' && /Загрузите запрошенную/.test(event.details ?? event.message ?? '')));
    assert.equal(f.db.listMessages(f.chat.id).length, 2, 'failed activation cannot run or alter chat under the baseline');
    f.set({ startupFailure: false });
    const selected = await f.invoke<Conversation>('conversations:update', f.chat.id, { modelId: f.modelId });
    assert.equal(selected.contextWindow, fp16); assert.equal(selected.llamaKvCacheType, 'f16');
    assert.deepEqual(f.launches.map(o => o.contextWindow), [fp16, fp16]);
    const q8Selected = await f.invoke<Conversation>('conversations:update', f.chat.id, { contextWindow: q8, llamaKvCacheType: 'q8_0' });
    assert.equal(q8Selected.contextWindow, q8); assert.equal(f.state().kvCacheType, 'q8_0');
    const statuses = (progress: ContextDiscoveryProgress) => progress.result?.options.map(o => [o.kvCacheType, o.conditions, o.conditionWarning]);
    const baseline = statuses(await f.invoke<ContextDiscoveryProgress>('context:discovery-status', f.modelId));
    assert(baseline?.every(row => row[1] === 'comparable'));
    for (const backgroundMiB of [1290, 1270, 1290, 1270, 1290, 1270]) {
      f.set({ backgroundMiB });
      assert.deepEqual(statuses(await f.invoke<ContextDiscoveryProgress>('context:discovery-status', f.modelId)), baseline, 'idle desktop redraw jitter cannot flip FP16/Q8');
    }
    f.set({ backgroundMiB: 1024, missingTelemetry: true });
    const missing = await f.invoke<ContextDiscoveryProgress>('context:discovery-status', f.modelId);
    assert.deepEqual(statuses(missing), baseline, 'brief missing telemetry retains the last confirmed conditions');
    assert.equal(missing.currentVramBudget, undefined, 'historical VRAM must not be shown as a live reading');
    assert.equal(missing.error, undefined, 'a sampling failure is not a discovery failure');
    f.set({ missingTelemetry: false, incompleteTelemetry: true });
    assert.deepEqual(statuses(await f.invoke<ContextDiscoveryProgress>('context:discovery-status', f.modelId)), baseline);
    f.set({ incompleteTelemetry: false, telemetryDelayMs: 20 });
    const readCount = f.budgetReads();
    const concurrent = await Promise.all(Array.from({ length: 8 }, () => f.invoke<ContextDiscoveryProgress>('context:discovery-status', f.modelId)));
    assert.equal(f.budgetReads() - readCount, 1, 'concurrent status polls share one telemetry sample');
    concurrent.forEach(progress => assert.deepEqual(statuses(progress), baseline));
    f.set({ telemetryDelayMs: 0 });
    // Actual production Chat lifecycle must not manufacture a stale warning
    // merely because a request is active or has just completed.
    const { LlamaCppBackend } = await import('../backends/llama-cpp-backend');
    const originalStream=LlamaCppBackend.prototype.streamWithTools;
    const originalEnsure=LlamaCppBackend.prototype.ensureModelAvailable;
    const originalContext=LlamaCppBackend.prototype.resolveContextWindow;
    let started!:()=>void, release!:()=>void;
    const entered=new Promise<void>(resolve=>{started=resolve;});
    const gate=new Promise<void>(resolve=>{release=resolve;});
    LlamaCppBackend.prototype.ensureModelAvailable=async()=>{};
    LlamaCppBackend.prototype.resolveContextWindow=async(_model,requested)=>({requested,active:requested,supported:requested});
    LlamaCppBackend.prototype.streamWithTools=async function*(){ started();await gate;yield {type:'token',content:'Fixture completed.'};yield {type:'response',response:{role:'assistant',content:'Fixture completed.'}}; };
    const requestChat=f.db.createConversation(f.modelId);
    await f.invoke('conversations:update',requestChat.id,{modelId:f.modelId,mode:'chat',contextWindow:q8,llamaKvCacheType:'q8_0',webMode:'off'});
    const beforeRequest=await f.invoke<ContextDiscoveryProgress>('context:discovery-status',f.modelId);
    let finished:Promise<unknown>|undefined;
    let deadline:ReturnType<typeof setTimeout>|undefined;
    try {
      finished=f.invoke('chat:send',{conversationId:requestChat.id,generationId:'context-first-request',model:f.modelId,mode:'chat',persistUserMessage:true,messages:[{id:'first-request-user',conversationId:requestChat.id,role:'user',content:'Fixture request',createdAt:new Date().toISOString()}]});
      await Promise.race([entered,finished.then(()=>{throw new Error('fixture stream did not start');}),new Promise((_,reject)=>{deadline=setTimeout(()=>reject(new Error('fixture startup timeout')),10000);})]);
      const during=await f.invoke<ContextDiscoveryProgress>('context:discovery-status',f.modelId);
      assert.deepEqual(during.result?.options.map(o=>[o.conditions,o.conditionWarning]),beforeRequest.result?.options.map(o=>[o.conditions,o.conditionWarning]));
      release();await finished;
      const after=await f.invoke<ContextDiscoveryProgress>('context:discovery-status',f.modelId);
      assert.deepEqual(after.result?.options.map(o=>[o.conditions,o.conditionWarning]),beforeRequest.result?.options.map(o=>[o.conditions,o.conditionWarning]),'first request completion alone is not discovery invalidation');
    } finally {
      clearTimeout(deadline);release();await finished;
      LlamaCppBackend.prototype.streamWithTools=originalStream;LlamaCppBackend.prototype.ensureModelAvailable=originalEnsure;LlamaCppBackend.prototype.resolveContextWindow=originalContext;
    }
    f.set({ backgroundMiB: 1350 });
    for (let i = 0; i < 3; i++) {
      if (i) await new Promise(resolve => setTimeout(resolve, 2050));
      const drifted = await f.invoke<ContextDiscoveryProgress>('context:discovery-status', f.modelId);
      if (i === 2) assert(drifted.result?.options.every(o => o.conditions === 'changed'), 'sustained baseline drift still warns through production IPC');
    }
    f.set({ backgroundMiB: 1024, pressure: true });
    const pressured = await f.invoke<ContextDiscoveryProgress>('context:discovery-status', f.modelId);
    assert(pressured.result?.options.every(option => option.conditions !== 'comparable'),'memory changes cannot remain GPU-safe');
    assert.equal((await f.invoke<ContextDiscoveryProgress>('context:discovery-status', f.modelId)).result?.options.length, 2, 'memory pressure must not erase catalog');
    await f.invoke('conversations:update', f.chat.id, { contextWindow: fp16, llamaKvCacheType: 'f16' });
    assert.equal(f.state().contextWindow, fp16, 'changed memory is advisory, not a load veto');
    await f.invoke('conversations:update', f.chat.id, { contextWindow: q8, llamaKvCacheType: 'q8_0' });
    f.set({ pressure: false, startupFailure: true });
    await assert.rejects(f.invoke('conversations:update', f.chat.id, { contextWindow: fp16, llamaKvCacheType: 'f16' }), /fixture CUDA out of memory/);
    assert.equal(f.db.getConversation(f.chat.id)?.contextWindow, q8, 'failed load preserves the last committed conversation configuration'); assert.equal(f.state().contextWindow, q8);
    f.set({ startupFailure: false });
    const fresh = await f.invoke<ContextDiscoveryResult>('context:discover', f.modelId); assert.equal(fresh.options.length, 2);
    f.set({ pressure: true }); assert.equal((await f.invoke<ContextDiscoveryProgress>('context:discovery-status', f.modelId)).result?.options.length, 2, 'fresh discovery cannot disappear during polling');
    f.set({ pressure: false, discoveryFailure: true });
    await assert.rejects(f.invoke('context:discover', f.modelId), /fixture interrupted discovery/);
    assert.equal((await f.invoke<ContextDiscoveryProgress>('context:discovery-status', f.modelId)).result?.options.length, 2);
    assert.equal(f.db.loadContextDiscoveryOptions(f.key.key, f.modelId).length, 2);
    assert.equal(f.db.listMessages(f.chat.id).length, 2);
    const freshChat = f.db.createConversation(f.modelId);
    f.set({ startupFailure: false });
    await f.invoke('conversations:update', freshChat.id, { modelId: f.modelId, contextWindow: fp16, llamaKvCacheType: 'f16' });
    assert.equal(f.db.getConversation(freshChat.id)?.contextWindow, fp16, 'saved option can load in a new chat');
    await f.invoke('conversations:update', freshChat.id, { contextWindow: 102400, llamaKvCacheType: 'q8_0' });
    assert.equal(f.state().contextWindow, 102400, 'manual unmeasured context can load');
    const launchCount = f.launches.length;
    // Another chat has changed the active context. Strategy/effort must not
    // implicitly acquire KV launch fields and reload the old chat's context.
    await f.invoke('conversations:update', f.chat.id, { reasoningMode: 'deep' });
    assert.equal(f.launches.length, launchCount, 'reasoning-only updates never restart a differing runtime');
    assert.equal(f.state().contextWindow, 102400);
    f.set({ mismatch: true });
    assert((await f.invoke<ContextDiscoveryProgress>('context:discovery-status', f.modelId)).result?.options.every(o => o.conditions === 'changed'), 'runtime identity changes warn immediately');
    await assert.rejects(f.invoke('conversations:update', f.chat.id, { contextWindow: fp16, llamaKvCacheType: 'f16' }), /mismatch|Конфигурация/i);
    console.log('Actual IPC/SQLite: restored FP16/Q8, explicit saved activation, nonstandard sizes, fresh/failed discovery, memory pressure, startup failure and history preservation passed.');
  } finally { f.close(); rmSync(root, { recursive: true, force: true }); }
}
if (require.main === module) void run().catch(error => { console.error(error); process.exitCode = 1; });
