// Local AI Desktop: renderer + registered Electron handlers + temporary registry.
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it, expect, vi } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createIntl } from 'react-intl';
import { IntlTestWrapper } from './i18n/test-utils';
import { speculativeFixture } from './test/ggufFixtures';
import { inspectPlacement } from './moe/placement';
import { probeRuntime, preflightLaunchProfile } from './ggufConfig';
import { registerManagedGguf, ManagedGguf } from './managedGguf';
import AdvancedLocalInference from './components/onboarding/AdvancedLocalInference';
import { formatGgufError } from './ggufMessages';
import russianMessages from './i18n/compiled/ru.json';
import type { GgufProfile } from './ggufTypes';

const ipc = vi.hoisted(() => ({ root: '', handlers: new Map<string, (...args: unknown[]) => unknown>() }));
vi.mock('electron', () => ({
  app: { on: vi.fn(), isPackaged: false, getPath: () => join(ipc.root, 'electron'), getAppPath: () => join(ipc.root, 'ui/desktop') },
  ipcMain: { handle: (name: string, fn: (...args: unknown[]) => unknown) => ipc.handlers.set(name, fn) },
  BrowserWindow: { getAllWindows: () => [] },
}));
vi.mock('./components/ModelAndProviderContext', () => ({ useModelAndProvider: () => ({ changeModel: vi.fn() }) }));
vi.mock('./hooks/useManagedGgufState', () => ({ useManagedGgufState: () => ({ phase: 'idle' }) }));
vi.mock('./acp/managedLocalProfiles', () => ({ registerLocalProfile: async (p: GgufProfile) => p, deleteLocalProfile: vi.fn() }));
// Resource fixtures isolate identity from changing host load. No GPU allocation occurs.
vi.mock('./memoryTelemetry', () => ({ sampleMemory: async () => ({ ram: { total: 256 * 1024 ** 3, used: 1024 ** 3 }, gpus: [{ total: 64 * 1024 ** 3, used: 1024 ** 3 }] }) }));

it('runs validate → inspect → explicit React confirmation → IPC save → restart → strict launch preflight', async () => {
  ipc.root = await mkdtemp(join(tmpdir(), 'lad-placement-workflow-'));
  const prepare = vi.spyOn(ManagedGguf.prototype, 'prepare').mockResolvedValue({ url: 'http://127.0.0.1:1', key: 'test' });
  const originalElectron = window.electron;
  try {
    const executable = join(ipc.root, 'runtime/llama/llama-server');
    await mkdir(join(ipc.root, 'runtime/llama'), { recursive: true });
    await mkdir(join(ipc.root, 'electron'), { recursive: true });
    const flags = '--model --host --port --gpu-layers --ctx-size --api-key LLAMA_API_KEY --alias --list-devices --parallel --override-tensor --fit --load-mode --no-host --no-repack --lazy-mode --flash-attn --cache-type-k --cache-type-v q8_0 --cpu-moe --moe-cache-mib --threads --batch-size --ubatch-size';
    await writeFile(executable, `#!/bin/sh\ncase "$1" in\n--help) echo '${flags}';;\n--version) echo 'llama.cpp 5047748';;\n--list-devices) echo 'CUDA0: test device';;\nesac\n`, { mode: 0o700 });
    const model = process.env.LAD_PLACEMENT_METADATA_MODEL ?? join(ipc.root, 'model.gguf');
    if (!process.env.LAD_PLACEMENT_METADATA_MODEL) await writeFile(model, speculativeFixture({ architecture: 'llama', head: false, attentionHeads: 1 }));
    const inspection = await inspectPlacement(model);
    const old = inspection.identity.split(':'); old[0] = old[0] === '66311' ? '66306' : '66311';
    // Use a copy of the user's model profile, never write its actual registry.
    const source = process.env.LAD_PLACEMENT_PROFILE_COPY
      ? JSON.parse(await readFile(process.env.LAD_PLACEMENT_PROFILE_COPY, 'utf8')) as GgufProfile
      : undefined;
    const profile: GgufProfile = { ...source, id: 'isolated-qwen', name: 'Isolated Qwen', model, executable,
      backend: 'external', gpuLayers: 999, context: 4096, gpuBlockIds: Array.from({ length: inspection.layers! }, (_, n) => n),
      moeCacheMode: 'standard', moeCacheMiB: undefined, placementIdentity: old.join(':'), flashAttention: 'on', speculativeMode: 'off' };
    const registry = join(ipc.root, 'electron/gguf-profiles.json');
    await writeFile(registry, JSON.stringify([profile]));
    registerManagedGguf();
    const invoke = async (name: string, ...args: unknown[]) => ipc.handlers.get(name)!({}, ...args);
    window.electron = { ...originalElectron,
      ggufRuntime: async () => executable,
      ggufList: async () => await invoke('gguf-list') as Awaited<ReturnType<typeof window.electron.ggufList>>,
      ggufProbe: async () => probeRuntime(executable),
      ggufValidate: async (p) => await invoke('gguf-validate', p) as Awaited<ReturnType<typeof window.electron.ggufValidate>>,
      ggufPlacement: async (p) => await invoke('gguf-placement', p) as Awaited<ReturnType<typeof window.electron.ggufPlacement>>,
      ggufSave: async (p) => await invoke('gguf-save', p) as GgufProfile,
      ggufDiscoveryCatalog: vi.fn().mockRejectedValue(new Error('not used')),
    };
    expect(await invoke('gguf-validate', profile)).toEqual({ placementConfirmationRequired: true });
    const preview = await window.electron.ggufPlacement(profile);
    expect(preview.inspection.identity).toBe(inspection.identity);
    expect(preview.inspection.layers).toBe(inspection.layers);
    await expect(invoke('gguf-save', profile)).rejects.toThrow('GGUF:placementIdentity:');
    render(<AdvancedLocalInference initialProfileId={profile.id} />, { wrapper: IntlTestWrapper });
    const user = userEvent.setup();
    await waitFor(() => expect(screen.getByLabelText('Profile name')).toHaveValue(profile.name));
    await user.click(screen.getByRole('button', { name: 'Validate paths and runtime' }));
    const confirm = await screen.findByRole('button', { name: 'Confirm this GGUF for the placement' });
    expect(confirm.closest('details')).toHaveAttribute('open');
    await user.click(confirm);
    await user.click(screen.getByRole('button', { name: 'Save profile' }));
    await screen.findByText('Profile saved. Model weights have not been loaded.');
    const persisted = JSON.parse(await readFile(registry, 'utf8'))[0] as GgufProfile;
    expect(persisted.placementIdentity).toBe(inspection.identity);
    const probe = await probeRuntime(executable);
    await expect(preflightLaunchProfile(persisted, probe)).resolves.toMatchObject({ id: profile.id });
    registerManagedGguf(); // new supervisor rereads the temporary persisted registry
    const reopened = (await invoke('gguf-list') as Array<{profile: GgufProfile}>)[0].profile;
    expect(await invoke('gguf-validate', reopened)).toEqual({ placementConfirmationRequired: false });
    await expect(preflightLaunchProfile(reopened, probe)).resolves.toMatchObject({ id: profile.id });
    // Actual changed-file check uses a tiny temporary GGUF, never the real model.
    const changed = join(ipc.root, 'changed.gguf');
    await writeFile(changed, speculativeFixture({ head: false }));
    const before = await inspectPlacement(changed);
    await writeFile(changed, speculativeFixture({ head: false, embedding: 16 }));
    await expect(invoke('gguf-save', { ...persisted, model: changed, gpuBlockIds: [0], placementIdentity: before.identity })).rejects.toThrow('GGUF:placementIdentity:');
  } finally {
    cleanup();
    window.electron = originalElectron;
    prepare.mockRestore();
    await rm(ipc.root, { recursive: true, force: true });
  }
}, 30000);

it('localizes both legacy technical IPC errors and the corrected error without losing its diagnostic code', () => {
  const intl = createIntl({ locale: 'en', messages: {} });
  for (const raw of ['Error invoking remote method gguf-validate: Error: GGUF:placementIdentity', 'GGUF:placementIdentity:']) {
    expect(formatGgufError(intl, raw)).toBe('The GGUF identity for this placement is not confirmed. Review the inspected model and confirm it in Advanced settings.');
    expect(raw).toContain('GGUF:placementIdentity');
    expect(formatGgufError(createIntl({ locale: 'ru', messages: russianMessages }), raw)).toContain('Идентичность GGUF для этого размещения не подтверждена');
  }
});

it('applies an explicit MTP memory preset through React/IPC and preserves it after supervisor restart', async()=>{
 ipc.root=await mkdtemp(join(tmpdir(),'lad-mtp-ui-workflow-'));
 const prepare=vi.spyOn(ManagedGguf.prototype,'prepare').mockResolvedValue({url:'http://127.0.0.1:1',key:'test'});
 const originalElectron=window.electron;
 try{
 const executable=join(ipc.root,'runtime/llama/llama-server');
 await mkdir(join(ipc.root,'runtime/llama'),{recursive:true});
 await writeFile(executable,`#!/bin/sh\ncase "$1" in\n--help) echo 'LLAMA_API_KEY --api-key --model --host --port --gpu-layers --ctx-size --alias --list-devices --threads --batch-size --ubatch-size --parallel --spec-draft-n-ubatch --cache-type-k --cache-type-v --cache-type-k-draft --cache-type-v-draft f16 q8_0 --flash-attn --spec-type none,draft-mtp --spec-draft-n-max --spec-draft-n-min';;\n--version) echo 'llama.cpp 5047748';;\n--list-devices) echo 'CUDA0: test device';;\nesac\n`,{mode:0o700});
 const model=join(ipc.root,'fixture.gguf');await writeFile(model,speculativeFixture({context:32768}));
 await mkdir(join(ipc.root,'electron'),{recursive:true});
 const profile:GgufProfile={id:'mtp-ui',name:'MTP preset test',model,executable,gpuLayers:999,context:32768,speculativeMode:'mtp-embedded',draftTokens:2,draftMinTokens:2,cacheK:'f16',cacheV:'f16',flashAttention:'on'};
 const registry=join(ipc.root,'electron','gguf-profiles.json');await writeFile(registry,JSON.stringify([profile]));
 registerManagedGguf();
 const invoke=async(name:string,...args:unknown[])=>ipc.handlers.get(name)!({},...args);
 window.electron={...originalElectron,ggufRuntime:async()=>executable,ggufList:async()=>await invoke('gguf-list') as Awaited<ReturnType<typeof window.electron.ggufList>>,ggufProbe:async()=>probeRuntime(executable),ggufValidate:async(p)=>await invoke('gguf-validate',p) as Awaited<ReturnType<typeof window.electron.ggufValidate>>,ggufSave:async(p)=>await invoke('gguf-save',p) as GgufProfile,ggufDiscoveryCatalog:vi.fn().mockRejectedValue(new Error('not used')),ggufPlacement:async(p)=>await invoke('gguf-placement',p) as Awaited<ReturnType<typeof window.electron.ggufPlacement>>};
 render(<AdvancedLocalInference initialProfileId={profile.id}/>,{wrapper:IntlTestWrapper});
 const user=userEvent.setup();await waitFor(()=>expect(screen.getByLabelText('Profile name')).toHaveValue(profile.name));
 await user.click(screen.getByRole('button',{name:'Validate paths and runtime'}));
 await user.click(screen.getByRole('button',{name:'Advanced mode'}));
 const preset=await screen.findByRole('button',{name:/Prepare MTP preset/});
 await waitFor(()=>expect(preset).toBeEnabled());
 expect(JSON.parse(await readFile(registry,'utf8'))[0].parallel).toBeUndefined();
 await user.click(preset);
 expect(JSON.parse(await readFile(registry,'utf8'))[0].parallel).toBeUndefined();
 await user.click(screen.getByRole('button',{name:'Save profile'}));
 await screen.findByText('Profile saved. Model weights have not been loaded.');
 const saved=JSON.parse(await readFile(registry,'utf8'))[0];expect(saved).toMatchObject({...profile,parallel:1,batch:512,ubatch:128,draftUbatch:128,draftTokens:1,draftMinTokens:1});
 expect(saved.nCpuMoe).toBeUndefined();
 registerManagedGguf();
 const reopened=(await invoke('gguf-list') as Array<{profile:GgufProfile}>)[0].profile;
 expect(reopened).toEqual(saved);
 await expect(preflightLaunchProfile(reopened,await probeRuntime(executable))).resolves.toMatchObject({parallel:1,speculativeMode:'mtp-embedded',draftUbatch:128});
 }finally{cleanup();window.electron=originalElectron;prepare.mockRestore();await rm(ipc.root,{recursive:true,force:true});}
},30000);
