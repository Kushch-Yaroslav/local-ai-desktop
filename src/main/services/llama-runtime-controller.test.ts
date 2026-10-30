import './test-runtime-isolation';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureAppDirectories, paths } from './paths';
import { loadRuntimeConfiguration, saveRuntimeConfiguration } from './runtime-settings';
import { builtinModelCatalog } from '../models/model-catalog';
import { SERVER_ABSENT, LlamaRuntimeController, parseLlamaRuntimeState } from './llama-runtime-controller';

const qwen = 'qwen3.8:27b-q4_K_M';
const secondaryModel = 'qwen3.6:35b-a3b-ud-q4_k_m';

async function fixture(timeoutMs = 5_000) {
  const dir = await mkdtemp(join(tmpdir(), 'llama-runtime-'));
  const files = { stateFile: join(dir, 'state.json'), requestFile: join(dir, 'request.env'), launcherPidFile: join(dir, 'launcher.pid') };
  await writeFile(files.launcherPidFile, '4242\n');
  const signals: number[] = [];
  let clock = 0;
  return { files, signals, dir, make: (onSignal: (request: Record<string, string>) => Promise<void>, extra: {ensureLauncher?:()=>Promise<void>;readText?:(path:string)=>Promise<string>}={}) => new LlamaRuntimeController(files, timeoutMs, {
    readText: async (path) => path === '/proc/4242/cmdline' ? '/bin/bash\0/media/yaroslav/DATA/local-ai-desktop/run-local-ai-desktop-llama-cpp-mtp.sh' : path === '/proc/1/cmdline' ? ['/test/custom-server', '--port', '8081', '--ctx-size', '65536'].join('\0') : readFile(path, 'utf8'),
    signal: (pid) => {
      signals.push(pid);
      void readFile(files.requestFile, 'utf8').then((text) => onSignal(Object.fromEntries(text.trim().split('\n').map((line) => line.split('=') as [string, string]))));
    },
    sleep: async () => { clock += 500; await new Promise((resolve) => setTimeout(resolve,5)); },
    now: () => clock,
    ...extra,
    capabilityLimit: async (modelId) => modelId === qwen ? 262144 : 131072,
  }) };
}

const state = (fields: Record<string, unknown>) => JSON.stringify({ status: 'ready', requestId: '', modelId: '', contextWindow: 0, kvCacheType: 'f16', kvOffload: true, serverPid: 1, launcherPid: 4242, error: '', rolledBack: false, ...fields });

export async function runLlamaRuntimeControllerRegression(): Promise<void> {
  ensureAppDirectories();
  const config=loadRuntimeConfiguration();
  const missing=builtinModelCatalog.filter(model=>[qwen,secondaryModel].includes(model.id)&&!config.models.some(entry=>entry.id===model.id));
  if(missing.length)saveRuntimeConfiguration({...config,models:[...config.models,...missing.map(model=>({id:model.id,displayName:model.displayName,modelPath:join(paths.models,model.modelPath),mmprojPath:'',gpuLayers:null,supportsTools:true,speculative:'mtp' as const,builtin:true}))]});
  {
    const { files, make } = await fixture();
    const controller = make(async request => {
      assert.equal(request.CONTEXT, '110592'); assert.equal(request.KV_TYPE, 'f16');
      await writeFile(files.stateFile, state({ requestId: request.REQUEST_ID, modelId: qwen, contextWindow: 65536, kvCacheType: 'q8_0' }));
    });
    const result = await controller.switchTo(qwen, 110592, 'f16');
    assert.equal(result.ok, false, '64K Q8 must not acknowledge an explicit 108K FP16 request');
    if (!result.ok) { assert.match(result.error, /108K f16.*64K q8_0/); assert.equal(result.state.contextWindow, 65536); assert.equal(result.state.kvCacheType, 'q8_0'); }
  }
  {
    const {files,make,signals}=await fixture();await rm(files.launcherPidFile);
    await writeFile(files.stateFile,state({launcherPid:999999,serverPid:999999}));let starts=0;
    const control=make(async request=>{await writeFile(files.stateFile,state({requestId:request.REQUEST_ID,modelId:qwen,contextWindow:Number(request.CONTEXT),kvCacheType:request.KV_TYPE}));},
      {ensureLauncher:async()=>{starts++;await writeFile(files.launcherPidFile,'4242');await writeFile(files.stateFile,state({status:'idle',serverPid:0}));}});
    const results=await Promise.all([control.switchTo(qwen,4096),control.switchTo(qwen,8192)]);
    assert(results.every(r=>r.ok));assert.equal(starts,1);assert.equal(signals.length,2);assert.equal((await control.state()).contextWindow,8192);
    await writeFile(files.stateFile,state({serverPid:999999}));assert.equal((await control.state()).status,'offline');
    assert((await control.switchTo(qwen,4096)).ok,'Crash recovery keeps the live supervisor');assert.equal(starts,1);
  }
  {
    const {files,make,signals}=await fixture();await rm(files.launcherPidFile);
    const control=make(async()=>{}, {ensureLauncher:async()=>{throw Error('fixture executable denied');}});
    const failed=await control.switchTo(qwen,4096);assert(!failed.ok);if(!failed.ok)assert.match(failed.error,/fixture executable denied/);assert.equal(signals.length,0);
  }
  {
    const {make}=await fixture();let dead=false;
    const control=make(async()=>{dead=true;},{readText:async path=>path==='/proc/4242/cmdline'?dead?'':'bash\0/project/run-local-ai-desktop-llama-cpp-mtp.sh':readFile(path,'utf8')});
    const failure=await control.switchTo(qwen,4096);assert(!failure.ok);if(!failure.ok)assert.match(failure.error,/завершился во время загрузки/);
  }
  assert.equal(parseLlamaRuntimeState('not json'), null);
  assert.equal(parseLlamaRuntimeState(state({ status: 'weird' })), null);
  assert.deepEqual(parseLlamaRuntimeState(state({ modelId: qwen, contextWindow: 65_536, kvCacheType: 'f16', kvOffload: true })), { status: 'ready', modelId: qwen, contextWindow: 65_536, kvCacheType: 'f16', kvOffload: true, launcherPid: 4242, serverPid: 1 });

  {
    // A live launcher cannot vouch for a server that died after startup.
    const { files, make } = await fixture();
    await writeFile(files.stateFile, state({ modelId: qwen, contextWindow: 65_536, serverPid: 999_999 }));
    const offline = await make(async () => undefined).state();
    assert.equal(offline.status, 'offline');
    assert.equal(offline.modelId, null);
    assert.equal(offline.contextWindow, null);
    assert.equal(offline.error, SERVER_ABSENT);
  }
  {
    const { files, make } = await fixture();
    const controller = make(async request => {
      assert.equal(request.PROJECTOR_DEVICE, 'gpu');
      await writeFile(files.stateFile, state({ requestId: request.REQUEST_ID, modelId: qwen, contextWindow: 32768, projectorDevice: 'gpu' }));
    });
    const result = await controller.switchTo(qwen, 32768, 'f16', true, 'gpu');
    assert.equal(result.ok, true);
    assert.equal(result.state.projectorDevice, 'gpu');
  }
  {
    const { files, signals, make } = await fixture();
    let captured: Record<string, string> = {};
    const controller = make(async (request) => { captured = request; await writeFile(files.stateFile, state({ status: 'ready', requestId: request.REQUEST_ID, modelId: request.MODEL_ID, contextWindow: Number(request.CONTEXT), kvCacheType: request.KV_TYPE, kvOffload: request.KV_OFFLOAD === '1' })); });
    const result = await controller.switchTo(qwen, 73_728, 'q8_0', false);
    assert.equal(result.ok, true, 'a confirmed switch must succeed');
    if (result.ok) {
      assert.equal(result.state.contextWindow, 73_728);
      assert.equal(result.state.kvCacheType, 'q8_0');
      assert.equal(result.state.kvOffload, false);
    }
    assert.equal(captured.KV_TYPE, 'q8_0');
    assert.equal(captured.KV_OFFLOAD, '0');
    assert.deepEqual(signals, [4242]);
  }
  for (const [context, kv] of [[73728, 'f16'], [110592, 'q8_0']] as const) {
    const { files, make } = await fixture();
    const controller = make(async request => {
      assert.equal(Number(request.CONTEXT), context); assert.equal(request.KV_TYPE, kv);
      await writeFile(files.stateFile, state({ requestId: request.REQUEST_ID, modelId: qwen, contextWindow: context, kvCacheType: kv, kvOffload: true }));
    });
    const result = await controller.switchTo(qwen, context, kv);
    assert(result.ok); assert.equal(result.state.contextWindow, context); assert.equal(result.state.kvCacheType, kv);
  }
  {
    // The requested runtime failed, the launcher restored the previous one: the switch is a failure and the active model is the previous one.
    const { files, make } = await fixture();
    const controller = make(async (request) => { await writeFile(files.stateFile, state({ status: 'ready', requestId: request.REQUEST_ID, modelId: secondaryModel, contextWindow: 65_536, error: 'CUDA out of memory', rolledBack: true })); });
    const result = await controller.switchTo(qwen, 65_536);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.error, /out of memory/);
      assert.equal(result.state.modelId, secondaryModel, 'the rolled-back state must name the model that really runs');
      assert.equal(result.state.rolledBack, true);
    }
  }
  {
    const { files, make } = await fixture();
    const controller = make(async (request) => { await writeFile(files.stateFile, state({ status: 'offline', requestId: request.REQUEST_ID, error: 'server exited' })); });
    const result = await controller.switchTo(qwen, 65_536);
    assert.equal(result.ok, false);
    if (!result.ok) { assert.equal(result.state.status, 'offline'); assert.equal(result.state.modelId, null); }
  }
  {
    // A state left by a previous request must never confirm the current one.
    const { files, make } = await fixture(2_000);
    await writeFile(files.stateFile, state({ status: 'ready', requestId: 'older-request', modelId: qwen, contextWindow: 65_536 }));
    const controller = make(async () => undefined);
    const result = await controller.switchTo(qwen, 65_536);
    assert.equal(result.ok, false, 'a stale ready state confirmed a new request');
    if (!result.ok) assert.match(result.error, /не ответил/);
  }
  {
    // A state file left behind by a launcher that no longer exists describes nothing.
    const { files, make } = await fixture();
    await writeFile(files.stateFile, state({ status: 'ready', modelId: qwen, contextWindow: 65_536, launcherPid: 999_999 }));
    const stale = await make(async () => undefined).state();
    assert.equal(stale.status, 'offline');
    assert.match(stale.error??'',/устарело/);
    await writeFile(files.stateFile, state({ status: 'ready', modelId: qwen, contextWindow: 65_536, launcherPid: 4242 }));
    assert.equal((await make(async () => undefined).state()).status, 'ready', 'a live launcher vouches for its state');
  }
  {
    const { files, make } = await fixture();
    const controller = make(async () => undefined);
    assert.equal((await controller.switchTo('unknown-model', 65_536)).ok, false);
    assert.equal((await controller.switchTo(qwen, 12_345)).ok, false, 'an unsupported context was sent to the launcher');
    assert.equal((await controller.switchTo(qwen, 131_076)).ok, false, 'unaligned custom context was sent to the launcher');
    assert.equal((await controller.switchTo(qwen, 266_240)).ok, false, 'context above the model limit was sent to the launcher');
    await writeFile(files.launcherPidFile, '');
    assert.equal((await controller.switchTo(qwen, 65_536)).ok, false, 'without a launcher there is nothing to switch');
  }
  for (const [requested, applied, speculative, ok] of [
    ['on', 'on', 'mtp', true], ['off', 'off', 'none', true],
    ['auto', 'auto', 'none', true], ['on', 'on', 'none', false],
    ['off', 'off', 'mtp', false], ['on', 'auto', 'mtp', false],
  ] as const) {
    const { files, make } = await fixture();
    const controller = make(async request => {
      assert.equal(request.MTP_MODE, requested, 'mode must reach the owned launcher');
      await writeFile(files.stateFile, state({ requestId: request.REQUEST_ID, modelId: qwen, contextWindow: 32768, mtpMode: applied, speculativeMode: speculative }));
    });
    const result = await controller.switchTo(qwen, 32768, 'f16', true, undefined, requested);
    assert.equal(result.ok, ok, `${requested} cannot be acknowledged by ${applied}/${speculative}`);
  }
  {
    // Concurrent switches are serialized: the second request is written only after the first finished.
    const { files, make } = await fixture();
    const seen: string[] = [];
    const controller = make(async (request) => { seen.push(request.MODEL_ID); await writeFile(files.stateFile, state({ status: 'ready', requestId: request.REQUEST_ID, modelId: request.MODEL_ID, contextWindow: Number(request.CONTEXT) })); });
    const [first, second] = await Promise.all([controller.switchTo(qwen, 65_536), controller.switchTo(secondaryModel, 32_768)]);
    assert.equal(first.ok && second.ok, true);
    assert.deepEqual(seen, [qwen, secondaryModel]);
  }
}

if (require.main === module) void runLlamaRuntimeControllerRegression().then(() => console.log('llama runtime controller regression passed'), (error: unknown) => { console.error(error); process.exitCode = 1; });
