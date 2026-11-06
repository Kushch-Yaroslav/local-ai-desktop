import { managedProviderHeaders } from '../ggufProviderCapabilities';
// Local AI Desktop: register lightweight endpoints with the existing Goose provider store.
import type { GgufProfile } from '../ggufTypes';
import {
  acpCreateCustomProviderFromRequest,
  acpUpdateCustomProviderFromRequest,
  acpDeleteCustomProvider,
} from './providers';
import { getModelSettings, updateModelSettings } from './local-inference';
let synchronizing: Promise<void> | undefined;
export async function registerLocalProfile(profile: GgufProfile): Promise<GgufProfile> {
  if (profile.backend === 'native') {
    const settings = await getModelSettings(profile.model);
    await updateModelSettings(profile.model, {
      ...settings,
      contextSize: profile.context,
      nGpuLayers: profile.gpuLayers,
      nThreads: profile.threads ?? null,
      nBatch: profile.batch ?? null,
      flashAttention:
        profile.flashAttention === 'auto' || !profile.flashAttention
          ? null
          : profile.flashAttention === 'on',
    });
    return { ...profile, providerId: 'local' };
  }
  const endpoint = await window.electron.ggufPrepare(profile.id!);
  const capabilities = await window.electron.ggufCapabilities(profile.id!);
  const request = {
    display_name: `${profile.name} · ${profile.id!.slice(0, 8)}`,
    engine: 'openai_compatible',
    api_url: endpoint.url,
    api_key: endpoint.key,
    requires_auth: true,
    models: ['local-gguf'],
    supports_streaming: true,
    preserves_thinking: true,
    headers: managedProviderHeaders(capabilities),
    toolshim: false,
  };
  if (profile.providerId && profile.providerId !== 'local') {
    await acpUpdateCustomProviderFromRequest(profile.providerId, request);
    return profile;
  }
  const created = await acpCreateCustomProviderFromRequest(request);
  const saved = { ...profile, providerId: created.provider_name };
  return window.electron.ggufSave(saved);
}
export function synchronizeLocalProfiles() {
  synchronizing ??= (async () => {
    const entries = await window.electron.ggufList();
    for (const { profile, available } of entries) {
      if (!available) continue;
      try {
        await registerLocalProfile(profile);
      } catch (error) {
        console.warn('Local profile registration failed', profile.id, String(error));
      }
    }
  })().finally(() => {
    synchronizing = undefined;
  });
  return synchronizing;
}
export async function deleteLocalProfile(profile: GgufProfile) {
  // Delete configuration only. Never unlink model, projector or draft files.
  if (profile.providerId && profile.providerId !== 'local')
    await acpDeleteCustomProvider(profile.providerId);
  await window.electron.ggufDelete(profile.id!);
}
