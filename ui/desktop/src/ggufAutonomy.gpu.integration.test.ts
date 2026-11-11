// Local AI Desktop: opt-in short inference, copied profiles, owned runtime, harmless MCP marker only.
import { it, expect, vi } from 'vitest';
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
vi.mock('electron', () => ({ app: {}, ipcMain: {}, BrowserWindow: { getAllWindows: () => [] } }));
import { ManagedGguf } from './managedGguf';
import type { GgufProfile } from './ggufTypes';
const execute = promisify(execFile);
it.skipIf(!process.env.LAD_AUTONOMY_PROFILE_ROOT || !process.env.LAD_AUTONOMY_WORK_DIR)(
  'sends real tools on the first Autonomous request and no tools in Chat Only', async () => {
    const root = process.env.LAD_AUTONOMY_PROFILE_ROOT!;
    const work = process.env.LAD_AUTONOMY_WORK_DIR!;
    await mkdir(work, {recursive:true});
    for (const name of ['gguf-profiles.json','gguf-context-overrides.json','gguf-context-discoveries.json'])
      await copyFile(join(root,name),join(work,name));
    const profiles: GgufProfile[] = JSON.parse(await readFile(join(work,'gguf-profiles.json'),'utf8'));
    const selected = profiles.find(p => p.name === 'Qwen27B-3.8')!;
    expect(selected).toBeTruthy();
    const service = new ManagedGguf(work);
    const profile = await service.save({...selected,executable:resolve('../../runtime/llama/llama-server')});
    const marker = join(work, 'marker.txt');
    await writeFile(marker, 'LAD_AUTONOMY_OK');
    try {
      await service.activate(profile.id!);
      const endpoint=await service.prepare(profile.id!);
      const report: Record<string, unknown>={args:service.state.args};
      const capabilities = await service.capabilities(profile.id!);
      report.capabilities = capabilities;
      report.thinking = [];
      for (const thinking of [false, true]) {
        const response = await fetch(endpoint.url + '/v1/chat/completions', {
          method: 'POST', headers: { Authorization: 'Bearer ' + endpoint.key, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: 'local-gguf', messages: [{role:'user', content:'Reply OK.'}], max_tokens:32, stream:false,
            chat_template_kwargs: { enable_thinking:thinking, ...(capabilities.nativeEfforts ? {reasoning_effort:'low'} : {}) } }),
          signal: AbortSignal.timeout(30000),
        });
        const result = await response.json();
        expect(response.ok).toBe(true);expect(result.choices?.[0]).toBeTruthy();
        (report.thinking as unknown[]).push({enabled:thinking, accepted:response.ok, nativeEffort:capabilities.nativeEfforts ? 'low' : null,
          reasoningReturned:!!result.choices?.[0]?.message?.reasoning_content, contentReturned:!!result.choices?.[0]?.message?.content});
      }

      for (const mode of ['auto','chat']) {
        service.protocolAudit(true);
        const env: Record<string, string | undefined>={...process.env,GOOSE_PATH_ROOT:join(work,'goose-'+mode),GOOSE_PROVIDER:'openai',GOOSE_MODEL:'local-gguf',GOOSE_MODE:mode,GOOSE_MAX_TOKENS:'512',OPENAI_BASE_URL:endpoint.url+'/v1',OPENAI_API_KEY:endpoint.key};
        delete env.OPENAI_HOST;
        const result=await execute(resolve('src/bin/goose'),['run','--no-session','--no-profile','--max-turns','3','--with-builtin','developer','--text',mode==='auto'?`Use a developer tool to read ${marker} exactly once and return its exact content. Do not guess the content.`:'Reply CHAT_OK without using any tools.','--quiet'],{env,timeout:90000,maxBuffer:1024*1024});
        const audit=service.protocolAudit();
        report[mode]={audit,output:result.stdout,stderr:result.stderr};
        await writeFile(join(work,'report.json'),JSON.stringify(report,null,2));
        if(mode==='auto') { expect(audit.find(a => a.gooseInstructions)?.tools).toBeGreaterThan(0);expect(audit.some(a=>a.responseToolCalls)).toBe(true);expect(result.stdout).toContain('LAD_AUTONOMY_OK'); }
        else { expect(audit.every(a=>a.tools===0)).toBe(true);expect(audit.every(a=>!a.responseToolCalls)).toBe(true); }
      }
      await writeFile(join(work,'report.json'),JSON.stringify(report,null,2));
    } finally { await service.unload(); }
  }, 240000
);
