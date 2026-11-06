// Local AI Desktop: narrowly audited implicit FA default; never override an explicit choice.
import type { GgufProfile, RuntimeProbe } from './ggufTypes';
import type { GgufMetadata } from './ggufMetadata';
export function compatibleFlashAttentionDefault(
  profile: GgufProfile,
  probe: RuntimeProbe,
  metadata: Pick<GgufMetadata, 'architecture'>
): GgufProfile {
  if (
    profile.backend === 'native' ||
    profile.flashAttention !== undefined ||
    profile.gpuLayers <= 0 ||
    profile.tensorOverride ||
    profile.cpuMoe ||
    profile.nCpuMoe !== undefined ||
    profile.moeCacheMiB ||
    profile.draft ||
    (profile.speculativeMode && !['off', 'mtp-embedded'].includes(profile.speculativeMode))
  )
    return profile;
  if (
    !probe.gpuAvailable ||
    !/^\s*CUDA\S*\s*:/m.test(probe.devices) ||
    !probe.flags.includes('--flash-attn') ||
    !['d1d3c33', '5047748'].some(commit => probe.version.includes(commit)) ||
    metadata.architecture !== 'qwen35'
  )
    return profile;
  return { ...profile, flashAttention: 'on' };
}
