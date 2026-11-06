// Opt-in host verification: temporary profiles, owned child only, synthetic content only.
import { it, expect, vi } from 'vitest';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
vi.mock('electron', () => ({ app: {}, ipcMain: {}, BrowserWindow: { getAllWindows: () => [] } }));
import type { GgufProfile, GgufEndpoint } from './ggufTypes';
import { ManagedGguf } from './managedGguf';
const execute = promisify(execFile);
it.skipIf(process.env.LAD_FA_GPU_SMOKE !== '1' || !process.env.LAD_GGUF_TEST_MODEL || !process.env.LAD_RUNTIME_TEST_PATH)(
  'validates FA, Q8 discovery, embedded MTP and a read-only Goose MCP call on host CUDA',
  async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lad-fa-host-'));
    const service = new ManagedGguf(dir);
    const report: Record<string, unknown> = {};
    const model = process.env.LAD_GGUF_TEST_MODEL!;
    const executable = process.env.LAD_RUNTIME_TEST_PATH!;
    const running = await execute('pgrep', ['-x', 'llama-server']).then(
      (r) => r.stdout.trim(),
      () => ''
    );
    expect(running).toBe('');
    const free = Number(
      (
        await execute('nvidia-smi', ['--query-gpu=memory.free', '--format=csv,noheader,nounits'])
      ).stdout.trim()
    );
    expect(free).toBeGreaterThan(22500);
    report.initialFreeMiB = free;
    service.protocolAudit(true);
    const runtime = service as unknown as {
      start: (p: GgufProfile, s: AbortSignal, v?: boolean) => Promise<GgufEndpoint>;
    };
    const start = runtime.start.bind(service);
    runtime.start = (p, s) => start(p, s, true);
    try {
      for (const mode of ['f16', 'q8', 'mtp'] as const) {
        const profile = await service.save({
          name: 'temporary FA verification',
          model,
          executable,
          gpuLayers: 999,
          context: 8192,
          cacheK: mode === 'f16' ? 'f16' : 'q8_0',
          cacheV: mode === 'f16' ? 'f16' : 'q8_0',
          speculativeMode: mode === 'mtp' ? 'mtp-embedded' : 'off',
          draftTokens: 2,
          threads: 8,
          batch: 256,
          ubatch: 128,
        });
        expect(profile.flashAttention).toBe('on');
        await service.activate(profile.id!);
        const endpoint = await service.prepare(profile.id!);
        const response = await fetch(endpoint.url + '/v1/chat/completions', {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + endpoint.key, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'local-gguf',
            messages: [{ role: 'user', content: 'Reply OK.' }],
            max_tokens: 8,
            temperature: 0,
            stream: false,
            chat_template_kwargs: { enable_thinking: false },
          }),
          signal: AbortSignal.timeout(60000),
        });
        const result = await response.json();
        expect(response.ok).toBe(true);
        expect(result.choices?.[0]).toBeTruthy();
        const log = await readFile(join(dir, `gguf-${profile.id}.log`), 'utf8');
        report[mode] = {
          args: service.state.args,
          finishReason: result.choices[0].finish_reason,
          faLogLines: log
            .split('\n')
            .filter((l) => /flash_attn|flash attention|cache.*type/i.test(l))
            .slice(-12),
        };
        expect(service.state.args).toContain('--flash-attn');
        expect(service.state.args).toContain('on');
        if (mode === 'q8') {
          const marker = 'SAFE_MCP_FA_OK';
          const mcp = join(dir, 'safe_mcp.py');
          const methods = join(dir, 'mcp-methods');
          await writeFile(
            mcp,
            `import sys,json\nfor line in sys.stdin:\n try:\n  q=json.loads(line); m=q.get('method'); result={}\n  open(${JSON.stringify(methods)},'a').write(str(m)+'\\n')\n  if m=='initialize': result={'protocolVersion':'2024-11-05','capabilities':{'tools':{}},'serverInfo':{'name':'safe-fa-probe','version':'1'}}\n  elif m=='tools/list': result={'tools':[{'name':'read_marker','description':'Return the fixed test marker. Read only.','inputSchema':{'type':'object','properties':{}},'annotations':{'readOnlyHint':True}}]}\n  elif m=='tools/call': result={'content':[{'type':'text','text':'${marker}'}]}\n  elif m not in ['notifications/initialized','ping']:\n   if 'id' in q: print(json.dumps({'jsonrpc':'2.0','id':q['id'],'error':{'code':-32601,'message':'Method not found'}}),flush=True)\n   continue\n  if 'id' in q: print(json.dumps({'jsonrpc':'2.0','id':q['id'],'result':result}),flush=True)\n except Exception: pass\n`
          );
          const goose = resolve('out/Local AI Desktop-linux-x64/resources/bin/goose');
          const env: Record<string, string | undefined> = {
            ...process.env,
            GOOSE_PATH_ROOT: join(dir, 'goose'),
            GOOSE_PROVIDER: 'openai',
            GOOSE_MODEL: 'local-gguf',
            GOOSE_MODE: 'auto',
            GOOSE_MAX_TOKENS: '512',
            OPENAI_BASE_URL: endpoint.url + '/v1',
            OPENAI_API_KEY: endpoint.key,
          };
          delete env.OPENAI_HOST;
          const cli = await execute(
            goose,
            [
              'run',
              '--no-session',
              '--no-profile',
              '--max-turns',
              '4',
              '--with-extension',
              'safe:/usr/bin/python3 ' + mcp,
              '--text',
              'Call the safe__read_marker tool exactly once and return its exact result.',
              '--quiet',
            ],
            { env, timeout: 90000, maxBuffer: 1024 * 1024 }
          );
          const audit = service.protocolAudit();
          report.mcp = {
            markerMatched: cli.stdout.includes(marker),
            toolCallsObserved: audit.some((a) => a.responseToolCalls),
            toolResultObserved: audit.some((a) => a.toolResults > 0),
            toolCounts: audit.map((a) => a.tools),
            methods: await readFile(methods, 'utf8').catch(() => ''),
            extensionFailed: /failed|invalid|error/i.test(cli.stderr),
          };
          // Keep GPU/discovery checks independent so an MCP harness failure cannot hide their outcome.
        }
        await service.unload();
      }
      if (process.env.LAD_RUNTIME_REGRESSION_ONLY === '1') {
        expect(report.mcp).toMatchObject({ markerMatched: true, toolCallsObserved: true, toolResultObserved: true, extensionFailed: false });
        return;
      }
      const profile = await service.save({
        name: 'temporary FA discovery',
        model,
        executable,
        gpuLayers: 999,
        context: 8192,
        threads: 8,
        batch: 256,
        ubatch: 128,
      });
      const token = await service.acquireRuntimeLease({ id: 9876, once: () => {} } as never);
      const result = await service.runContextDiscovery(profile.id!, token);
      report.discovery = {
        options: result.result.options.map((o) => ({
          kv: o.kvCacheType,
          context: o.contextWindow,
          headroom: o.measuredHeadroom,
        })),
        unsupported: result.result.unsupported,
        probes: result.result.probes?.map((p) => ({
          context: p.contextWindow,
          kv: p.kvCacheType,
          startup: p.startup,
          health: p.health,
          inference: p.inference,
          fits: p.fits,
        })),
      };
      expect(result.result.options.some((o) => o.kvCacheType === 'q8_0')).toBe(true);
      expect(report.mcp).toMatchObject({
        markerMatched: true,
        toolCallsObserved: true,
        toolResultObserved: true,
        extensionFailed: false,
      });
    } finally {
      await service.shutdown();
      await writeFile('/tmp/lad-fa-host-results.json', JSON.stringify(report, null, 2));
      await rm(dir, { recursive: true, force: true });
    }
  },
  240000
);
