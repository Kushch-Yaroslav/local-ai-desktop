// Opt-in real Goose ACP → provider → gateway → CUDA integration, isolated synthetic session.
import { it, expect, vi } from 'vitest';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
vi.mock('electron', () => ({ app: {}, ipcMain: {}, BrowserWindow: { getAllWindows: () => [] } }));
import { ManagedGguf } from './managedGguf';
const execute = promisify(execFile);
interface RpcReply {
  sessionId: string;
  providerId: string;
  modes: { currentModeId: string };
  configOptions: Array<{ id: string; options?: unknown }>;
}
it.skipIf(process.env.LAD_GOOSE_VISION_SMOKE !== '1' || !process.env.LAD_GGUF_TEST_MODEL || !process.env.LAD_GGUF_TEST_PROJECTOR || !process.env.LAD_RUNTIME_TEST_PATH)(
  'confirms ACP modes, first-image serialization and real per-request thinking budget without runtime reload',
  async () => {
    expect(
      await execute('pgrep', ['-x', 'llama-server']).then(
        (r) => r.stdout.trim(),
        () => ''
      )
    ).toBe('');
    expect(
      Number(
        (
          await execute('nvidia-smi', ['--query-gpu=memory.free', '--format=csv,noheader,nounits'])
        ).stdout.trim()
      )
    ).toBeGreaterThan(22500);
    const dir = await mkdtemp(join(tmpdir(), 'lad-goose-vision-'));
    const service = new ManagedGguf(dir);
    const report: Record<string, unknown> = {};
    let child: ReturnType<typeof spawn> | undefined;
    const pending = new Map<
      number,
      { resolve: (v: RpcReply) => void; reject: (v: unknown) => void }
    >();
    let next = 1,
      buffer = '',
      text = '';
    try {
      const profile = await service.save({
        name: 'isolated Goose vision',
        model: process.env.LAD_GGUF_TEST_MODEL!,
        projector: process.env.LAD_GGUF_TEST_PROJECTOR!,
        executable: process.env.LAD_RUNTIME_TEST_PATH!,
        gpuLayers: 999,
        context: 8192,
        cacheK: 'q8_0',
        cacheV: 'q8_0',
        flashAttention: 'on',
        speculativeMode: 'mtp-embedded',
        draftTokens: 2,
        threads: 8,
        batch: 256,
        ubatch: 128,
      });
      report.capabilities = await service.capabilities(profile.id!);
      expect(report.capabilities).toMatchObject({thinking:true,nativeEfforts:true,vision:true});
      const gateway = await service.prepare(profile.id!);
      service.protocolAudit(true);
      child = spawn(resolve('../../target/release/goose'), ['acp'], {
        env: {
          ...process.env,
          GOOSE_PATH_ROOT: join(dir, 'goose'),
          GOOSE_PROVIDER: 'openai',
          GOOSE_MODEL: 'local-gguf',
          GOOSE_MODE: 'chat',
          GOOSE_MAX_TOKENS: '512',
          OPENAI_BASE_URL: gateway.url + '/v1',
          OPENAI_API_KEY: gateway.key,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      child.stderr!.resume();
      child.stdout!.on('data', (chunk) => {
        buffer += chunk.toString();
        let end;
        while ((end = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, end);
          buffer = buffer.slice(end + 1);
          let msg;
          try {
            msg = JSON.parse(line);
          } catch {
            continue;
          }
          if (msg.id !== undefined && !msg.method) {
            const p = pending.get(msg.id);
            pending.delete(msg.id);
            if (msg.error) p?.reject(new Error(JSON.stringify(msg.error)));
            else p?.resolve(msg.result);
          } else if (
            msg.method === 'session/update' &&
            msg.params?.update?.sessionUpdate === 'agent_message_chunk'
          ) {
            const c = msg.params.update.content;
            if (c?.type === 'text') text += c.text;
          } else if (msg.method && msg.id !== undefined)
            child!.stdin!.write(
              JSON.stringify({
                jsonrpc: '2.0',
                id: msg.id,
                result: { outcome: { outcome: 'cancelled' } },
              }) + '\n'
            );
        }
      });
      const rpc = (method: string, params: unknown) =>
        new Promise<RpcReply>((resolve, reject) => {
          const id = next++;
          const timeout = setTimeout(() => {
            pending.delete(id);
            reject(new Error('ACP timeout: ' + method));
          }, 60000);
          pending.set(id, {
            resolve: (v) => {
              clearTimeout(timeout);
              resolve(v);
            },
            reject: (e) => {
              clearTimeout(timeout);
              reject(e);
            },
          });
          child!.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
        });
      await rpc('initialize', {
        protocolVersion: 1,
        clientCapabilities: {},
        clientInfo: { name: 'goose-desktop', version: '0' },
      });
      const created = await rpc('_goose/unstable/providers/custom/create', {
        engine: 'openai',
        displayName: 'Isolated CUDA test',
        apiUrl: gateway.url,
        apiKey: gateway.key,
        requiresAuth: true,
        models: ['local-gguf'],
        supportsStreaming: true,
        preservesThinking: true,
        toolshim: false,
        headers: { 'X-Local-AI-Managed-Qwen': 'qwen35-v1', 'X-Local-AI-Vision': '1' },
      });
      await rpc('_goose/unstable/defaults/save', {
        providerId: created.providerId,
        modelId: 'local-gguf',
      });
      const session = await rpc('session/new', {
        cwd: dir,
        mcpServers: [],
        _meta: { client: 'goose-desktop', enabledExtensions: [] },
      });
      const sessionId = session.sessionId;
      await rpc('session/set_config_option', {
        sessionId,
        configId: 'provider',
        value: created.providerId,
      });
      await rpc('session/set_config_option', { sessionId, configId: 'model', value: 'local-gguf' });
      const modes: string[] = [];
      for (const mode of ['approve', 'smart_approve', 'auto', 'chat']) {
        await rpc('session/set_mode', { sessionId, modeId: mode });
        const loaded = await rpc('session/load', { sessionId, cwd: dir, mcpServers: [] });
        expect(loaded.modes.currentModeId).toBe(mode);
        modes.push(mode);
      }
      expect(service.state.phase).toBe('idle');
      const effort = await rpc('session/set_config_option', {
        sessionId,
        configId: 'thinking_effort',
        value: 'off',
      });
      report.effortOptions = effort.configOptions?.find((o) => o.id === 'thinking_effort')?.options;
      await rpc('session/set_config_option', {sessionId,configId:'thinking_budget',value:'512'});
      expect(service.state.phase).toBe('idle');
      // Solid red PNG fixture, generated locally; not a user image.
      const png = (
        await execute('python3', [
          '-c',
          "import struct,zlib,base64; c=lambda t,d:struct.pack('>I',len(d))+t+d+struct.pack('>I',zlib.crc32(t+d)); print(base64.b64encode(b'\\x89PNG\\r\\n\\x1a\\n'+c(b'IHDR',struct.pack('>IIBBBBB',128,128,8,2,0,0,0))+c(b'IDAT',zlib.compress((b'\\0'+b'\\xff\\0\\0'*128)*128))+c(b'IEND',b'')).decode())",
        ])
      ).stdout.trim();
      await rpc('session/prompt', {
        sessionId,
        prompt: [
          {
            type: 'text',
            text: 'What is the dominant colour in the attached image? Answer only RED or BLUE.',
          },
          { type: 'image', mimeType: 'image/png', data: png },
        ],
      });
      expect(text.toUpperCase()).toContain('RED');
      const firstAudit = service.protocolAudit();
      report.firstAudit = firstAudit;
      expect(firstAudit.some((a) => a.images === 1 && a.thinkingEnabled === false && a.reasoningBudget === 512)).toBe(true);
      const endpoint = (service as unknown as { endpoint: { url: string } }).endpoint.url;
      const active = (service as unknown as { endpoint: { url: string; key: string } }).endpoint;
      const budgetProbe = await fetch(active.url + '/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + active.key, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'local-gguf',
          messages: [
            {
              role: 'user',
              content:
                'Think through twenty different ways to multiply 17 by 19 before giving the final number.',
            },
          ],
          stream: false,
          max_tokens: 96,
          temperature: 0,
          chat_template_kwargs: { enable_thinking: true, reasoning_effort: 'xhigh' },
          reasoning_budget_tokens: 8,
          reasoning_budget_message: 'BUDGET_PROBE_STOP',
        }),
      });
      expect(budgetProbe.ok).toBe(true);
      const budgetReply = await budgetProbe.json();
      report.budgetEnforcementMarker = String(
        budgetReply.choices?.[0]?.message?.reasoning_content
      ).includes('BUDGET_PROBE_STOP');
      expect(report.budgetEnforcementMarker).toBe(true);

      await rpc('session/set_config_option', {
        sessionId,
        configId: 'thinking_effort',
        value: 'low',
      });
      await rpc('session/set_config_option', {
        sessionId,
        configId: 'thinking_budget',
        value: '128',
      });
      text = '';
      await rpc('session/prompt', {
        sessionId,
        prompt: [{ type: 'text', text: 'Calculate 17 times 19 carefully and give the result.' }],
      });
      expect(text).toContain('323');
      const audit = service.protocolAudit();
      expect(
        audit.some(
          (a) =>
            a.thinkingEnabled === true &&
            a.reasoningBudget === 128 &&
            a.nativeEffort === 'low' &&
            a.responseReasoning
        )
      ).toBe(true);
      expect((service as unknown as { endpoint: { url: string } }).endpoint.url).toBe(endpoint);
      await rpc('session/set_mode', { sessionId, modeId: 'approve' });
      await rpc('session/set_mode', { sessionId, modeId: 'chat' });
      expect((service as unknown as { endpoint: { url: string } }).endpoint.url).toBe(endpoint);
      const mcp = join(dir, 'read_marker.py'),
        calls = join(dir, 'tool-calls');
      await writeFile(
        mcp,
        `import sys,json\nfor line in sys.stdin:\n try:\n  q=json.loads(line);m=q.get('method');r={}\n  if m=='initialize':r={'protocolVersion':'2024-11-05','capabilities':{'tools':{}},'serverInfo':{'name':'safe','version':'1'}}\n  elif m=='tools/list':r={'tools':[{'name':'read_marker','description':'Return the fixed read-only verification marker.','inputSchema':{'type':'object','properties':{}},'annotations':{'readOnlyHint':True}}]}\n  elif m=='tools/call':\n   open(${JSON.stringify(calls)},'a').write('called\\n');r={'content':[{'type':'text','text':'SAFE_VISION_MTP_OK'}]}\n  elif m not in ['notifications/initialized','ping']:\n   if 'id' in q:print(json.dumps({'jsonrpc':'2.0','id':q['id'],'error':{'code':-32601,'message':'Method not found'}}),flush=True)\n   continue\n  if 'id' in q:print(json.dumps({'jsonrpc':'2.0','id':q['id'],'result':r}),flush=True)\n except Exception:pass\n`
      );
      const toolsSession = await rpc('session/new', {
        cwd: dir,
        mcpServers: [{ name: 'safe', command: '/usr/bin/python3', args: [mcp], env: [] }],
        _meta: { client: 'goose-desktop' },
      });
      const toolsId = toolsSession.sessionId;
      await rpc('session/set_config_option', {
        sessionId: toolsId,
        configId: 'provider',
        value: created.providerId,
      });
      await rpc('session/set_config_option', {
        sessionId: toolsId,
        configId: 'model',
        value: 'local-gguf',
      });
      await rpc('session/set_config_option', {
        sessionId: toolsId,
        configId: 'thinking_effort',
        value: 'off',
      });
      await rpc('session/set_mode', { sessionId: toolsId, modeId: 'auto' });
      text = '';
      await rpc('session/prompt', {
        sessionId: toolsId,
        prompt: [
          {
            type: 'text',
            text: 'Call safe__read_marker exactly once and return its exact result.',
          },
        ],
      });
      expect(text).toContain('SAFE_VISION_MTP_OK');
      expect(await readFile(calls, 'utf8')).toContain('called');
      expect(service.protocolAudit().some((a) => a.responseToolCalls)).toBe(true);
      expect(service.protocolAudit().some((a) => a.toolResults > 0)).toBe(true);
      report.mcpConfirmed = true;
      report.modes = modes;
      report.imageRedConfirmed = true;
      report.audit = audit;
      report.runtimeUnchanged = true;
      report.args = service.state.args;
    } finally {
      if (child) {
        child.stdin?.end();
        await new Promise<void>((r) => {
          if (child!.exitCode !== null) return r();
          const t = setTimeout(() => child!.kill('SIGTERM'), 2000);
          child!.once('exit', () => {
            clearTimeout(t);
            r();
          });
        });
      }
      await service.shutdown();
      await writeFile('/tmp/lad-goose-vision-results.json', JSON.stringify(report, null, 2));
      await rm(dir, { recursive: true, force: true });
    }
  },
  180000
);
