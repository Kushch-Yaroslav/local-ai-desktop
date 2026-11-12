import { existsSync } from 'node:fs';
// Local AI Desktop: real process/HTTP integration without allocating model weights.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, writeFile, rm, access, mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
vi.mock('electron', () => ({ app: {}, ipcMain: {}, BrowserWindow: { getAllWindows: () => [] } }));
import { ManagedGguf } from './managedGguf';
import { probeRuntime, validateProfile } from './ggufConfig';
import type { GgufProfile } from './ggufTypes';
import { speculativeFixture } from './test/ggufFixtures';
let dir: string;
let service: ManagedGguf;
let base: GgufProfile;
let marker: string;
let activity: string;
beforeEach(async () => {
  const testRoot = join(process.cwd(), '.managed-gguf-test-tmp');
  await mkdir(testRoot, { recursive: true });
  dir = await mkdtemp(join(testRoot, 'case-'));
  service = new ManagedGguf(dir);
  marker = join(dir, 'starts');
  activity = join(dir, 'max-active');
  const model = join(dir, 'fixture.gguf');
  const executable = join(dir, 'fixture-server');
  await writeFile(model, 'GGUF fixture weights');
  await writeFile(
    executable,
    `#!/usr/bin/env node
if(process.argv.includes('--help')){console.log('LLAMA_API_KEY --verbose --model --host --port --gpu-layers --ctx-size --alias --api-key --list-devices --threads --batch-size --ubatch-size --parallel --slot-save-path --kv-unified --no-kv-unified --no-context-shift --cache-type-k --cache-type-v f16 q8_0 --flash-attn --mmproj --cpu-moe --n-cpu-moe --override-tensor --jinja --chat-template --spec-type none,draft-simple,draft-mtp --spec-draft-n-max --spec-draft-n-min --spec-draft-model --gpu-layers-draft');process.exit(0);}
if(process.argv.includes('--version')){console.log('fixture 1');process.exit(0);}
if(process.argv.includes('--list-devices')){console.log('Available devices: (none)');process.exit(0);}
require('fs').appendFileSync(${JSON.stringify(marker)},'start\\n');
const http=require('http');
let active=0,maximum=0;
const server=http.createServer((req,res)=>{
 if(req.headers.authorization!=='Bearer '+process.env.LLAMA_API_KEY){res.writeHead(401).end();return;}
 if(req.url==='/health'){res.end('{}');return;}
 if(req.url==='/props'){
  const arg=(flag,fallback)=>{const i=process.argv.indexOf(flag);return i<0?fallback:Number(process.argv[i+1]);};
  const context=arg('--ctx-size',8192),slots=arg('--parallel',4),unified=process.argv.includes('--kv-unified');
  res.setHeader('Content-Type','application/json');
  res.end(JSON.stringify({total_slots:slots,default_generation_settings:{n_ctx:unified?context:Math.floor(context/slots)}}));return;
 }
 if(req.url.startsWith('/slots/')){res.setHeader('Content-Type','application/json');res.end('{}');return;}
 if(req.url==='/apply-template'||req.url==='/tokenize'){
  const chunks=[];req.on('data',b=>chunks.push(b));req.on('end',()=>{const parsed=JSON.parse(Buffer.concat(chunks));res.setHeader('Content-Type','application/json');res.end(JSON.stringify(req.url==='/apply-template'?{prompt:JSON.stringify(parsed.messages)}:{tokens:Array.from({length:parsed.content.includes('TOO_LARGE_CHILD')?174080:10},()=>1)}));});return;
 }
 if(req.url==='/v1/chat/completions'){
  const chunks=[];req.on('data',b=>chunks.push(b));req.on('end',()=>{const body=Buffer.concat(chunks);const parsed=JSON.parse(body);
  if(parsed.max_tokens===64&&parsed.seed===42&&parsed.cache_prompt===false){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({choices:[{message:{role:'assistant',content:'synthetic, no actual MTP'}}]}));return;}
  if(parsed.testScenario==='echo'){res.setHeader('Content-Type','application/json');res.end(body);return;}
  if(parsed.testScenario==='stream-protocol'){res.writeHead(200,{'Content-Type':'text/event-stream'});const bytes=Buffer.from(parsed.fixtureSse);let i=0;const timer=setInterval(()=>{if(i>=bytes.length){clearInterval(timer);res.end();return;}res.write(bytes.subarray(i,i+7));i+=7;},1);return;}
  if(parsed.testScenario==='broken-stream'){res.writeHead(200,{'Content-Type':'text/event-stream'});res.write('data: {"choices":[{"delta":{"content":"synthetic"}}]}\\n\\n');setTimeout(()=>res.destroy(),50);return;}
  if(parsed.testScenario==='upstream-error'){res.writeHead(400,{'Content-Type':'application/json'});res.end(JSON.stringify({error:{message:'prompt exceeds context limit'}}));return;}
  if(parsed.testScenario==='upstream-memory-error'){res.writeHead(500,{'Content-Type':'application/json'});res.end(JSON.stringify({error:{message:'cudaMalloc failed: out of memory'}}));return;}
  if(parsed.testScenario==='upstream-close'){res.destroy();return;}
  if(parsed.testScenario==='slow'){
   active++;maximum=Math.max(active,maximum);require('fs').writeFileSync(${JSON.stringify(activity)},String(maximum));
   res.writeHead(200,{'Content-Type':'text/event-stream'});res.write('data: {"choices":[{"delta":{"content":"LOCAL_OK"}}]}\\n\\n');
   setTimeout(()=>{active--;res.end('data: [DONE]\\n\\n');},140);return;
  }
  res.writeHead(200,{'Content-Type':'text/event-stream'});res.write('data: {"choices":[{"delta":{"content":"LOCAL_OK"}}]}\\n\\n');
  const timer=setTimeout(()=>res.end('data: [DONE]\\n\\n'),100);res.on('close',()=>clearTimeout(timer));});return;
 }
 res.writeHead(404).end();
});
const delay=process.argv.includes('--threads')&&process.argv[process.argv.indexOf('--threads')+1]==='2'?2500:0;
if(process.argv.includes('--threads')&&process.argv[process.argv.indexOf('--threads')+1]==='3')console.error('current-child-startup-evidence:'+ 'x'.repeat(1024));
setTimeout(()=>server.listen(Number(process.argv[process.argv.indexOf('--port')+1]),'127.0.0.1'),delay);
`,
    { mode: 0o700 }
  );
  base = { name: 'Fixture', model, executable, gpuLayers: 0, context: 8192 };
});
afterEach(async () => {
  await service.shutdown();
  await rm(dir, { recursive: true, force: true });
  await rm(join(process.cwd(), '.managed-gguf-test-tmp'), { recursive: true, force: true });
});
const waitFor = async (condition: () => boolean) => {
  for (let i = 0; i < 200; i++) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw Error('Timed out');
};
const request = (endpoint: { url: string; key: string }, signal?: AbortSignal) =>
  fetch(endpoint.url + '/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${endpoint.key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'local-gguf',
      messages: [{ role: 'user', content: 'hello' }],
      stream: true,
    }),
    signal,
  });
const runtimeContext = (endpoint: { url: string; key: string }) =>
  fetch(endpoint.url + '/v1/models?context_limit=1', {
    headers: { Authorization: `Bearer ${endpoint.key}` },
  });
function u32(value: number) {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32LE(value);
  return bytes;
}
function u64(value: number) {
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64LE(BigInt(value));
  return bytes;
}
function ggufString(value: string) {
  const bytes = Buffer.from(value);
  return Buffer.concat([u64(bytes.length), bytes]);
}
async function writeValidGguf(file: string, context = 131072) {
  const fields = [
    Buffer.concat([ggufString('general.architecture'), u32(8), ggufString('qwen2')]),
    Buffer.concat([ggufString('qwen2.context_length'), u32(4), u32(context)]),
  ];
  await writeFile(
    file,
    Buffer.concat([Buffer.from('GGUF'), u32(3), u64(0), u64(fields.length), ...fields])
  );
}
describe('profile registry', () => {
  it.each([16 * 1024 ** 2 - 64, 16 * 1024 ** 2, 16 * 1024 ** 2 + 64])(
    'retains current-child startup evidence with %i bytes of existing diagnostic history',
    async (previousBytes) => {
      await writeValidGguf(base.model);
      const profile = await service.save({ ...base, threads: 3 });
      const log = join(dir, `gguf-${profile.id}.log`);
      await writeFile(log, Buffer.alloc(previousBytes, '.'));
      const endpoint = await service.activate(profile.id!);
      expect(service.state.phase).toBe('ready');
      expect(endpoint.args).toContain('--threads');
      expect(await readFile(log, 'utf8')).toContain('current-child-startup-evidence:');
      if (previousBytes > 16 * 1024 ** 2)
        expect((await readFile(log + '.1')).length).toBe(previousBytes);
      await service.unload();
      await service.activate(profile.id!);
      expect((await readFile(log, 'utf8')).match(/current-child-startup-evidence:/g)?.length).toBe(
        previousBytes > 16 * 1024 ** 2 ? 2 : 1
      );
    }
  );
  it('saves multiple profiles without spawning weights, migrates legacy and never deletes external weights', async () => {
    const a = await service.save(base);
    const b = await service.save({ ...base, name: 'Second' });
    expect((await service.list()).length).toBe(2);
    await expect(access(marker)).rejects.toThrow();
    await service.delete(b.id!);
    expect(await readFile(base.model, 'utf8')).toBe('GGUF fixture weights');
    await service.shutdown();
    service = new ManagedGguf(dir);
    expect((await service.list())[0].profile.id).toBe(a.id);
    await rm(base.model);
    expect((await service.list())[0].available).toBe(false);
    expect((await service.list()).length).toBe(1);
  });
  it('migrates the previous single profile without launching it', async () => {
    await writeFile(join(dir, 'gguf-profile.json'), JSON.stringify(base));
    expect((await service.list())[0].profile.name).toBe('Fixture');
    await expect(access(marker)).rejects.toThrow();
  });
  it.each(['off', 'auto', undefined] as const)(
    'preserves legacy Flash Attention %s without loading weights',
    async (flashAttention) => {
      await writeFile(join(dir, 'gguf-profile.json'), JSON.stringify({ ...base, flashAttention }));
      expect((await service.list())[0].profile.flashAttention).toBe(flashAttention);
      await service.shutdown();
      service = new ManagedGguf(dir);
      expect((await service.list())[0].profile.flashAttention).toBe(flashAttention);
      await expect(access(marker)).rejects.toThrow();
    }
  );
  it('saves an unloaded context override separately from defaults and uses it after reopening', async () => {
    await writeValidGguf(base.model);
    const profile = await service.save({ ...base, flashAttention: 'on' });
    await service.prepare(profile.id!);
    const owner = { id: 71, once: () => undefined } as never;
    const token = await service.acquireRuntimeLease(owner);
    await expect(service.applyContext(profile.id!, 65536, 'q8_0', token)).resolves.toMatchObject({
      applied: false,
      loaded: false,
      context: 65536,
      kv: 'q8_0',
    });
    expect((await service.list())[0].profile.context).toBe(8192);
    await expect(access(marker)).rejects.toThrow();
    await service.shutdown();
    service = new ManagedGguf(dir);
    await service.list();
    const reopened = (await service.list())[0].profile;
    const endpoint = await service.activate(reopened.id!);
    expect(endpoint.args).toContain('65536');
    expect(endpoint.args).toContain('q8_0');
    expect(reopened.context).toBe(8192);
  });
  it('rejects missing files, unsupported flags, bad values and unavailable GPU for the selected runtime', async () => {
    await expect(validateProfile({ ...base, model: 'relative.gguf' })).rejects.toThrow(
      'GGUF:absolutePath'
    );
    await expect(validateProfile({ ...base, gpuLayers: -1 })).rejects.toThrow('GGUF:invalidValue');
    await expect(
      validateProfile({ ...base, moeCacheMiB: 100, cpuMoe: true, gpuLayers: 1 })
    ).rejects.toThrow('GGUF:unsupportedFlag:--moe-cache-mib');
    await expect(validateProfile({ ...base, gpuLayers: 1 })).rejects.toThrow(
      'GGUF:devicesInaccessible'
    );
    const probe = await probeRuntime(base.executable);
    expect(probe.executable).toBe(base.executable);
    expect(probe.gpuAvailable).toBe(false);
    await expect(
      validateProfile({ ...base, cacheK: 'q8_0' }, { ...probe, cacheTypes: ['f16'] })
    ).rejects.toThrow('GGUF:unsupportedValue:cacheK=q8_0');
  });
});
describe('owned lazy process', () => {
  it('leases the one shared runtime, rejects active work and queues new local requests until release', async () => {
    const p = await service.save(base);
    const endpoint = await service.prepare(p.id!);
    const activeResponse = await request(endpoint);
    expect(activeResponse.ok).toBe(true);
    await expect(
      service.acquireRuntimeLease({ id: 42, once: () => undefined } as never)
    ).rejects.toThrow('GGUF:runtimeBusy');
    await activeResponse.text();

    const owner = { id: 42, once: () => undefined } as never;
    const token = await service.acquireRuntimeLease(owner);
    await expect(service.activate(p.id!)).rejects.toThrow('GGUF:runtimeBusy');
    await expect(service.unload()).rejects.toThrow('GGUF:runtimeBusy');
    const startsBefore = (await readFile(marker, 'utf8')).trim().split('\n').length;
    const queued = request(endpoint);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect((await readFile(marker, 'utf8')).trim().split('\n')).toHaveLength(startsBefore);
    service.releaseAcquiredLease(token);
    const response = await queued;
    expect(await response.text()).toContain('LOCAL_OK');
    expect(service.state.phase).toBe('ready');
  });

  it('serializes requests from two chats that select different profiles on the same owned server', async () => {
    const a = await service.save(base);
    const b = await service.save({ ...base, name: 'Second profile' });
    const endpointA = await service.prepare(a.id!);
    const endpointB = await service.prepare(b.id!);
    const responseA = await request(endpointA);
    const pendingB = request(endpointB);
    expect(await responseA.text()).toContain('LOCAL_OK');
    const responseB = await pendingB;
    expect(await responseB.text()).toContain('LOCAL_OK');
    expect(service.state.profileId).toBe(b.id);
    expect((await readFile(marker, 'utf8')).trim().split('\n')).toHaveLength(2);
  });

  it('keeps listing lightweight, authenticates, lazily streams one request and reuses the loaded process', async () => {
    const p = await service.save(base);
    const endpoint = await service.prepare(p.id!);
    expect((await fetch(endpoint.url + '/v1/models')).status).toBe(401);
    const models = await fetch(endpoint.url + '/v1/models', {
      headers: { Authorization: `Bearer ${endpoint.key}` },
    });
    const listing = await models.json();
    expect(listing.data[0].id).toBe('local-gguf');
    expect(listing.data[0].meta).toBeUndefined();
    expect(
      await access(marker).then(
        () => true,
        () => false
      )
    ).toBe(false);
    await expect(access(marker)).rejects.toThrow();
    const liveContext = await runtimeContext(endpoint);
    expect((await liveContext.json()).data[0].meta).toMatchObject({
      n_ctx: 8192,
      total_slots: 4,
      kv_unified: true,
    });
    expect((await readFile(marker, 'utf8')).trim().split('\n')).toHaveLength(1);
    const response = await request(endpoint);
    expect(response.ok).toBe(true);
    await expect(service.unload()).rejects.toThrow('GGUF:runtimeBusy');
    expect(await response.text()).toContain('LOCAL_OK');
    expect(service.state.phase).toBe('ready');
    const first = await service.activate(p.id!);
    await service.save({ ...p, name: 'Renamed without reload' });
    const second = await service.activate(p.id!);
    expect(first.url).toBe(second.url);
    expect((await readFile(marker, 'utf8')).trim().split('\n')).toHaveLength(1);
    expect(service.state.args?.join(' ')).not.toContain(first.key);
    await service.unload();
    expect(service.state.phase).toBe('idle');
    await expect(fetch(first.url + '/health')).rejects.toThrow();
  });
  it.each([
    ['70K FP16', 70 * 1024, 'f16'],
    ['112K Q8', 112 * 1024, 'q8_0'],
    ['170K Q8', 170 * 1024, 'q8_0'],
  ] as const)('reports the applied single-agent context for %s', async (_label, context, cache) => {
    const p = await service.save({
      ...base,
      context,
      cacheK: cache,
      cacheV: cache,
      ...(cache === 'q8_0' ? { flashAttention: 'on' as const } : {}),
    });
    const endpoint = await service.prepare(p.id!);
    const response = await runtimeContext(endpoint);
    expect(response.status, await response.clone().text()).toBe(200);
    const listing = await response.json();
    expect(listing.data[0].context_window).toBe(context);
    expect(listing.data[0].meta.n_ctx).toBe(context);
    const runtime = await service.activate(p.id!);
    expect(runtime.args).toContain(String(context));
    expect(runtime.args).toContain(cache);
    expect(runtime.args).toContain('--kv-unified');
    expect(listing.data[0].meta).toMatchObject({ total_slots: 4, kv_unified: true });
    expect((await readFile(marker, 'utf8')).trim().split('\n')).toHaveLength(1);
  });
  it('reports each non-unified slot context and admits up to the measured server slot count', async () => {
    const p = await service.save({ ...base, context: 96 * 1024, parallel: 3 });
    const endpoint = await service.prepare(p.id!);
    const response = await runtimeContext(endpoint);
    const item = (await response.json()).data[0];
    expect(item.context_window).toBe(32 * 1024);
    expect(item.meta).toMatchObject({ n_ctx: 32 * 1024, total_slots: 3, kv_unified: false });
    const runtime = await service.activate(p.id!);
    expect(runtime.args).toContain('--parallel');
    expect(runtime.args).toContain('3');
    expect(runtime.args).toContain('--no-kv-unified');

    const responsePromises = Array.from({ length: 4 }, () =>
      fetch(endpoint.url + '/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${endpoint.key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'local-gguf', messages: [], testScenario: 'slow' }),
      })
    );
    let queueStatus: Awaited<ReturnType<ManagedGguf['diagnostics']>> | undefined;
    for (let i = 0; i < 100; i++) {
      queueStatus = await service.diagnostics(p.id!);
      if (queueStatus.inferenceQueue.waiting > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(queueStatus?.inferenceQueue).toMatchObject({ capacity: 3, active: 3, waiting: 1 });
    const responses = await Promise.all(responsePromises);
    await Promise.all(responses.map((result) => result.text()));
    expect(await readFile(activity, 'utf8')).toBe('3');
    expect((await readFile(marker, 'utf8')).trim().split('\n')).toHaveLength(1);
  });
  it('generates three budgeted subagents concurrently in a 170K pool and restores the main chat limit', async () => {
    const p = await service.save({
      ...base,
      context: 170 * 1024,
      cacheK: 'q8_0',
      cacheV: 'q8_0',
      flashAttention: 'on',
    });
    const endpoint = await service.prepare(p.id!);
    const childHeaders = {
      Authorization: `Bearer ${endpoint.key}`,
      'Content-Type': 'application/json',
      'X-Local-AI-Agent-Role': 'subagent',
    };
    const budgetResponse = await fetch(endpoint.url + '/v1/models?context_limit=1', {
      headers: childHeaders,
    });
    const childBudget = (await budgetResponse.json()).data[0].meta.n_ctx;
    expect(childBudget).toBe(Math.floor((170 * 1024) / 4 / 256) * 256);
    const replies = await Promise.all(
      Array.from({ length: 3 }, () =>
        fetch(endpoint.url + '/v1/chat/completions', {
          method: 'POST',
          headers: childHeaders,
          body: JSON.stringify({
            model: 'local-gguf',
            messages: [{ role: 'user', content: 'child' }],
            testScenario: 'slow',
          }),
        })
      )
    );
    await Promise.all(replies.map((reply) => reply.text()));
    expect(await readFile(activity, 'utf8')).toBe('3');
    const echo = await fetch(endpoint.url + '/v1/chat/completions', {
      method: 'POST',
      headers: childHeaders,
      body: JSON.stringify({
        model: 'local-gguf',
        messages: [],
        testScenario: 'echo',
        n_predict: 999999,
      }),
    });
    const bounded = await echo.json();
    expect(bounded.max_tokens).toBe(childBudget - 11);
    expect(bounded.n_predict).toBe(bounded.max_tokens);
    expect((await (await runtimeContext(endpoint)).json()).data[0].meta.n_ctx).toBe(170 * 1024);
    expect(await (await request(endpoint)).text()).toContain('LOCAL_OK');
    expect((await readFile(marker, 'utf8')).trim().split('\n')).toHaveLength(1);
  });
  it('rejects a child prompt exceeding its share before inference and accepts the next main chat', async () => {
    const p = await service.save({ ...base, context: 170 * 1024 });
    const endpoint = await service.prepare(p.id!);
    const response = await fetch(endpoint.url + '/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${endpoint.key}`,
        'Content-Type': 'application/json',
        'X-Local-AI-Agent-Role': 'subagent',
      },
      body: JSON.stringify({
        model: 'local-gguf',
        messages: [{ role: 'user', content: 'TOO_LARGE_CHILD' }],
      }),
    });
    expect(response.status).toBe(413);
    const detail = (await response.json()).error;
    expect(detail).toMatchObject({ effectiveLimit: 43520, promptTokens: 174080 });
    expect(detail.message).toContain('effective limit: 43520, templated prompt: 174080');
    expect(await (await request(endpoint)).text()).toContain('LOCAL_OK');
  });
  it('keeps child compaction budgeted and releases scheduler capacity after failure and cancellation', async () => {
    const p = await service.save({ ...base, context: 114688 });
    const endpoint = await service.prepare(p.id!);
    const headers = {
      Authorization: `Bearer ${endpoint.key}`,
      'Content-Type': 'application/json',
      'X-Local-AI-Agent-Role': 'subagent',
      'agent-session-id': 'child-compaction',
    };
    const payload = {
      model: 'local-gguf',
      messages: [
        { role: 'system', content: 'PRIVATE_COMPACTION_SOURCE' },
        { role: 'user', content: 'Please summarize the conversation history' },
      ],
    };
    const failed = await fetch(endpoint.url + '/v1/chat/completions', {
      method: 'POST',
      headers,
      body: JSON.stringify({ ...payload, testScenario: 'upstream-error' }),
    });
    expect(failed.status).toBe(400);
    await failed.text();
    const echo = await fetch(endpoint.url + '/v1/chat/completions', {
      method: 'POST',
      headers,
      body: JSON.stringify({ ...payload, testScenario: 'echo' }),
    });
    expect((await echo.json()).max_tokens).toBe(28672 - 11);
    const abort = new AbortController();
    const streaming = await fetch(endpoint.url + '/v1/chat/completions', {
      method: 'POST',
      headers,
      signal: abort.signal,
      body: JSON.stringify({ ...payload, testScenario: 'slow' }),
    });
    abort.abort();
    await streaming.text().catch(() => {});
    for (let i = 0; i < 100; i++) {
      if ((await service.diagnostics(p.id!)).inferenceQueue.active === 0) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect((await service.diagnostics(p.id!)).inferenceQueue).toMatchObject({
      active: 0,
      waiting: 0,
    });
    expect(await (await request(endpoint)).text()).toContain('LOCAL_OK');
    await service.shutdown();
    const files = (await readdir(dir)).filter((file) => file.startsWith('gguf-inference-'));
    const telemetry = (
      await Promise.all(files.map((file) => readFile(join(dir, file), 'utf8')))
    ).join('');
    expect(telemetry).toContain('child-compaction');
    expect(telemetry).toContain('prompt_counted');
    expect(telemetry).toContain('first_output');
    expect(telemetry).toContain('released');
    expect(telemetry).not.toContain('PRIVATE_COMPACTION_SOURCE');
    expect(telemetry).not.toContain(endpoint.key);
  });
  it('serializes unified KV requests so each may use the full shared per-request context', async () => {
    const p = await service.save({ ...base, context: 72 * 1024 });
    const endpoint = await service.prepare(p.id!);
    const responses = await Promise.all(
      Array.from({ length: 3 }, () =>
        fetch(endpoint.url + '/v1/chat/completions', {
          method: 'POST',
          headers: { Authorization: `Bearer ${endpoint.key}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: 'local-gguf', messages: [], testScenario: 'slow' }),
        })
      )
    );
    await Promise.all(responses.map((result) => result.text()));
    expect(await readFile(activity, 'utf8')).toBe('1');
    expect((await readFile(marker, 'utf8')).trim().split('\n')).toHaveLength(1);
  });
  it('keeps three concurrent session histories isolated on one managed server', async () => {
    const p = await service.save({ ...base, context: 72 * 1024 });
    const endpoint = await service.prepare(p.id!);
    const sessions = Array.from({ length: 3 }, (_, index) => ({
      model: 'local-gguf',
      testScenario: 'echo',
      stream: false,
      messages: [
        { role: 'system', content: `isolated-system-${index}` },
        { role: 'user', content: `isolated-history-${index}` },
      ],
    }));
    const results = await Promise.all(
      sessions.map(async (session) => {
        const response = await fetch(endpoint.url + '/v1/chat/completions', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${endpoint.key}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(session),
        });
        expect(response.status, await response.clone().text()).toBe(200);
        return response.json();
      })
    );

    expect(results).toEqual(sessions);
    expect((await readFile(marker, 'utf8')).trim().split('\n')).toHaveLength(1);
  });
  it('refreshes the reported context after a profile context change and server restart', async () => {
    const p = await service.save({ ...base, context: 70 * 1024 });
    const endpoint = await service.prepare(p.id!);
    expect((await (await runtimeContext(endpoint)).json()).data[0].meta.n_ctx).toBe(70 * 1024);
    await service.unload();
    await service.save({
      ...p,
      context: 170 * 1024,
      cacheK: 'q8_0',
      cacheV: 'q8_0',
      flashAttention: 'on',
    });
    const response = await runtimeContext(endpoint);
    expect(response.status, await response.clone().text()).toBe(200);
    expect((await response.json()).data[0].meta.n_ctx).toBe(170 * 1024);
    const restarted = await service.activate(p.id!);
    expect(restarted.args).toContain(String(170 * 1024));
    expect((await readFile(marker, 'utf8')).trim().split('\n')).toHaveLength(2);
  });
  it('shares concurrent launches and cancels startup cleanly', async () => {
    const p = await service.save({ ...base, threads: 2 });
    const a = service.activate(p.id!);
    const b = service.activate(p.id!);
    const failures = Promise.allSettled([a, b]);
    await waitFor(() => service.state.phase === 'starting');
    // Spawn publication precedes execution of the child marker.
    await waitFor(() => existsSync(marker));
    await service.unload();
    expect((await failures).every((result) => result.status === 'rejected')).toBe(true);
    expect(service.state.phase).toBe('idle');
    expect((await readFile(marker, 'utf8')).trim().split('\n')).toHaveLength(1);
  });
  it('aborted chat requests cancel a pending model start without replaying messages', async () => {
    const p = await service.save({ ...base, threads: 2 });
    const endpoint = await service.prepare(p.id!);
    const abort = new AbortController();
    const pending = request(endpoint, abort.signal).catch(() => null);
    await waitFor(() => service.state.phase === 'starting');
    abort.abort();
    await pending;
    await waitFor(() => service.state.phase === 'idle');
  });
  it('retains the endpoint across restart without autoloading and reports bounded failures', async () => {
    const p = await service.save(base);
    const first = await service.prepare(p.id!);
    await service.shutdown();
    service = new ManagedGguf(dir);
    await service.list();
    const restored = await service.prepare(p.id!);
    expect(restored.url).toBe(first.url);
    expect(restored.key).toBe(first.key);
    await expect(access(marker)).rejects.toThrow();
    await rm(base.model);
    await expect(service.activate(p.id!)).rejects.toThrow('GGUF:missingFile');
    expect(service.state.phase).toBe('failed');
  });
  it('switches models safely and normal shutdown releases the real child', async () => {
    const a = await service.save(base);
    const b = await service.save({ ...base, name: 'Other' });
    const first = await service.activate(a.id!);
    await service.activate(b.id!);
    await expect(fetch(first.url + '/health')).rejects.toThrow();
    expect(service.state.profileId).toBe(b.id);
    await service.shutdown();
    expect(service.state.phase).toBe('idle');
  });
});

describe('OpenAI protocol fidelity', () => {
  const payload = {
    model: 'local-gguf',
    messages: [
      { role: 'system', content: 'SYNTHETIC_SYSTEM' },
      { role: 'developer', content: 'SYNTHETIC_DEVELOPER' },
      { role: 'user', content: 'synthetic user' },
      {
        role: 'assistant',
        content: null,
        reasoning_content: 'synthetic reasoning',
        tool_calls: [
          {
            id: 'synthetic_id',
            type: 'function',
            function: { name: 'synthetic_tool', arguments: '{"value":1}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'synthetic_id', content: 'synthetic tool result' },
    ],
    tools: [
      {
        type: 'function',
        function: {
          name: 'synthetic_tool',
          parameters: { type: 'object', properties: { value: { type: 'integer' } } },
        },
      },
    ],
    tool_choice: { type: 'function', function: { name: 'synthetic_tool' } },
    parallel_tool_calls: false,
    stream: true,
    stream_options: { include_usage: true },
  };
  it('forwards raw request bytes, roles, tool definitions/choice/results and reasoning unchanged', async () => {
    const p = await service.save(base);
    const endpoint = await service.prepare(p.id!);
    service.protocolAudit(true);
    const body = JSON.stringify({ ...payload, testScenario: 'echo' }, null, 2);
    const response = await fetch(endpoint.url + '/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${endpoint.key}`, 'Content-Type': 'application/json' },
      body,
    });
    expect(await response.text()).toBe(body);
    const audit = service.protocolAudit();
    expect(audit[0]).toMatchObject({
      roles: { system: 1, developer: 1, user: 1, assistant: 1, tool: 1 },
      tools: 1,
      toolChoice: 'function',
      assistantToolCalls: true,
      requestReasoning: true,
      toolResults: 1,
    });
    expect(JSON.stringify(audit)).not.toContain('SYNTHETIC_SYSTEM');
    expect(JSON.stringify(audit)).not.toContain('synthetic_tool');
    expect(JSON.stringify(audit)).not.toContain(endpoint.key);
  });
  it('preserves fragmented UTF-8 SSE reasoning, tool calls, finish reasons, usage and DONE byte-for-byte', async () => {
    const p = await service.save(base);
    const endpoint = await service.prepare(p.id!);
    service.protocolAudit(true);
    const events = [
      { choices: [{ delta: { reasoning_content: 'синтетика' }, finish_reason: null }] },
      {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'synthetic_id',
                  type: 'function',
                  function: { name: 'synthetic_tool', arguments: '{"value":' },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      },
      {
        choices: [
          {
            delta: { tool_calls: [{ index: 0, function: { arguments: '1}' } }] },
            finish_reason: 'tool_calls',
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 2 },
      },
    ];
    const fixtureSse =
      events.map((e) => 'data: ' + JSON.stringify(e) + '\r\n\r\n').join('') +
      'data: [DONE]\r\n\r\n';
    const response = await fetch(endpoint.url + '/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${endpoint.key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...payload, testScenario: 'stream-protocol', fixtureSse }),
    });
    expect(await response.text()).toBe(fixtureSse);
    expect(service.protocolAudit()[0]).toMatchObject({
      responseReasoning: true,
      responseToolCalls: true,
      finishReasons: ['tool_calls'],
      done: true,
    });
    expect(JSON.stringify(service.protocolAudit())).not.toContain('синтетика');
  });
  it('does not append a JSON error object to a partially emitted SSE stream', async () => {
    const p = await service.save(base);
    const endpoint = await service.prepare(p.id!);
    const response = await fetch(endpoint.url + '/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${endpoint.key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...payload, testScenario: 'broken-stream' }),
    });
    await expect(response.text()).rejects.toThrow();
    expect(await service.diagnostics(p.id!)).toMatchObject({
      lastFailure: { kind: 'streamAborted' },
    });
  });
  it('preserves the upstream context error body before streaming starts', async () => {
    const p = await service.save(base);
    const endpoint = await service.prepare(p.id!);
    const response = await fetch(endpoint.url + '/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${endpoint.key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...payload, testScenario: 'upstream-error' }),
    });
    expect(response.status).toBe(400);
    expect(response.headers.get('x-local-ai-gguf-error')).toBe('contextExceeded');
    expect(await response.json()).toMatchObject({
      error: { message: 'prompt exceeds context limit' },
    });
    expect(await service.diagnostics(p.id!)).toMatchObject({
      lastFailure: { kind: 'contextExceeded', httpStatus: 400 },
    });
  });
  it('preserves upstream memory diagnostics without exposing the request payload', async () => {
    const p = await service.save(base);
    const endpoint = await service.prepare(p.id!);
    const response = await fetch(endpoint.url + '/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${endpoint.key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...payload, testScenario: 'upstream-memory-error' }),
    });
    expect(response.status).toBe(500);
    expect(response.headers.get('x-local-ai-gguf-error')).toBe('deviceMemory');
    expect(await response.text()).toContain('cudaMalloc failed: out of memory');
    expect(await service.diagnostics(p.id!)).toMatchObject({
      lastFailure: { kind: 'deviceMemory', httpStatus: 500 },
    });
  });
  it('classifies an upstream disconnect before streaming starts', async () => {
    const p = await service.save(base);
    const endpoint = await service.prepare(p.id!);
    const response = await fetch(endpoint.url + '/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${endpoint.key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...payload, testScenario: 'upstream-close' }),
    });
    expect(response.status).toBe(503);
    expect(await response.text()).toContain('GGUF:serverUnavailable:');
    expect(await service.diagnostics(p.id!)).toMatchObject({
      lastFailure: { kind: 'serverUnavailable' },
    });
  });
});

it('persists a validated external draft profile, switches to normal inference and cleans failed MTP startup', async () => {
  await writeFile(base.model, speculativeFixture());
  const draft = join(dir, 'draft.gguf');
  await writeFile(draft, speculativeFixture());
  const enabled = await service.save({
    ...base,
    draft,
    speculativeMode: 'mtp-external',
    draftTokens: 2,
  });
  const normal = await service.save({ ...base, name: 'normal', speculativeMode: 'off', draft });
  const active = await service.activate(enabled.id!);
  expect(active.args).toContain('--spec-draft-model');
  expect((await service.list()).find((e) => e.profile.id === enabled.id)?.profile.draft).toBe(
    draft
  );
  await service.activate(normal.id!);
  expect(service.state.args).not.toContain('--spec-draft-model');
  await expect(fetch(active.url + '/health')).rejects.toThrow();
  await service.unload();
  await writeFile(
    base.executable,
    '#!/usr/bin/env node\nif(process.argv.includes("--help")){console.log("LLAMA_API_KEY --model --host --port --gpu-layers --ctx-size --alias --api-key --spec-type draft-mtp --spec-draft-n-max --spec-draft-model");}else if(process.argv.includes("--version")){console.log("fixture");}else{process.exit(7);}',
    { mode: 0o700 }
  );
  await expect(service.activate(enabled.id!)).rejects.toThrow('processExit');
  expect(service.state.phase).toBe('failed');
  await service.unload();
  expect(service.state.phase).toBe('idle');
});

it('invalidates a dead endpoint and recovers through the same durable gateway with a fresh owned child', async () => {
  const profile = await service.save(base);
  const gateway = await service.prepare(profile.id!);
  expect((await request(gateway)).ok).toBe(true);
  const first = (service as unknown as { owned: import('node:child_process').ChildProcess }).owned;
  first.kill('SIGTERM');
  await waitFor(() => service.state.phase === 'failed');
  expect((service as unknown as { endpoint?: unknown }).endpoint).toBeUndefined();
  await service.save({ ...profile, context: 16 * 1024 });
  expect((await request(gateway)).ok).toBe(true);
  expect((await (await runtimeContext(gateway)).json()).data[0].meta.n_ctx).toBe(16 * 1024);
  expect(service.state.phase).toBe('ready');
  const second = (service as unknown as { owned: import('node:child_process').ChildProcess }).owned;
  expect(second.pid).not.toBe(first.pid);
});

it('quick embedded MTP edits preserve configuration, stay pending until leased reload and never start unloaded weights', async () => {
  await writeFile(base.model, speculativeFixture());
  const saved = await service.save({
    ...base,
    speculativeMode: 'off',
    draftTokens: 3,
    context: 8192,
    threads: 4,
  });
  expect((await service.capabilities(saved.id!)).embeddedMtp).toBe(true);
  const enabled = await service.setEmbeddedMtp(saved.id!, true);
  expect(enabled).toEqual({ ...saved, speculativeMode: 'mtp-embedded' });
  await expect(access(marker)).rejects.toThrow();
  await service.activate(saved.id!);
  expect(service.state.args).toContain('draft-mtp');
  const starts = await readFile(marker, 'utf8');
  await service.setEmbeddedMtp(saved.id!, false);
  await service.activate(saved.id!, true);
  expect(await readFile(marker, 'utf8')).toBe(starts);
  expect(service.state.args).toContain('draft-mtp');
  await expect(service.reloadProfile(saved.id!, 'invalid')).rejects.toThrow();
  const lease = await service.acquireRuntimeLease({ id: 99, once: () => undefined } as never);
  try {
    await service.reloadProfile(saved.id!, lease);
  } finally {
    await service.releaseAcquiredLease(lease);
  }
  expect(await readFile(marker, 'utf8')).not.toBe(starts);
  expect(service.state.args).not.toContain('draft-mtp');
  expect((await service.list())[0].profile).toEqual({ ...saved, speculativeMode: 'off' });
});
it('does not advertise or accept embedded MTP for a target without a validated head', async () => {
  await writeFile(base.model, speculativeFixture({ head: false }));
  const p = await service.save(base);
  expect((await service.capabilities(p.id!)).embeddedMtp).toBe(false);
  await expect(service.setEmbeddedMtp(p.id!, true)).rejects.toThrow('specBackend');
  await expect(access(marker)).rejects.toThrow();
});

it('never certifies MTP context when inference returned no actual draft activity', async () => {
  await writeFile(base.model, speculativeFixture());
  const profile = await service.save({
    ...base,
    context: 4096,
    speculativeMode: 'mtp-embedded',
    flashAttention: 'on',
  });
  const lease = await service.acquireRuntimeLease({ id: 999, once: () => {} } as never);
  await expect(service.runContextDiscovery(profile.id!, lease)).rejects.toThrow(
    'No actual draft tokens generated'
  );
  expect(service.state.phase).toBe('idle');
});

it.each([false, true])(
  'restores the original loaded=%s state after repeated failed probes and retains separate receipts',
  async (loaded) => {
    await writeFile(base.model, speculativeFixture());
    const profile = await service.save({
      ...base,
      context: 4096,
      speculativeMode: 'mtp-embedded',
      flashAttention: 'on',
    });
    if (loaded) await service.activate(profile.id!);
    const originalArgs = service.state.args;
    for (let i = 0; i < 3; i++) {
      const token = await service.acquireRuntimeLease({ id: 999, once: () => {} } as never);
      await expect(service.runContextDiscovery(profile.id!, token)).rejects.toThrow(
        'No actual draft tokens generated'
      );
      expect(service.state.phase).toBe(loaded ? 'ready' : 'idle');
      if (loaded) {
        const withoutPort = (args: string[] | undefined) =>
          args?.map((arg, index) => (args[index - 1] === '--port' ? 'ephemeral-port' : arg));
        expect(withoutPort(service.state.args)).toEqual(withoutPort(originalArgs));
      }
    }
    const runs = await readdir(join(dir, 'discovery'));
    expect(runs).toHaveLength(3);
    const logs = new Set<string>();
    for (const run of runs) {
      const receipt = JSON.parse(
        await readFile(join(dir, 'discovery', run, 'result.json'), 'utf8')
      );
      expect(receipt.initialState.phase).toBe(loaded ? 'ready' : 'idle');
      expect(receipt.restoration).toBe(loaded ? 'reloaded' : 'left-unloaded');
      expect(receipt.probes[0].stage).toBe('mtp');
      logs.add(receipt.probes[0].logPath);
    }
    expect(logs.size).toBe(3);
  }
);
