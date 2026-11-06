import { detectManagedReasoning } from './ggufReasoningCapabilities';
import { attachOwnedMemoryScope, watchOwnedMemory } from './moe/memoryGuard';
import { placementPreview } from './moe/placement';
import { validateSpeculation } from './ggufSpeculation';
import { readSpeculativeMetadata } from './ggufSpeculativeMetadata';
import { classifyRuntimeFailure } from './ggufFailure';
import { resolveFlashAttentionDefault, withGpuLayerDefault } from './ggufConfig';
import { ProtocolObservation, type ProtocolSummary } from './ggufProtocolAudit';
// Local AI Desktop: profile registry and owned inference supervisor; Goose remains the agent.
import { app, BrowserWindow, ipcMain, type WebContents } from 'electron';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer as createTcpServer } from 'node:net';
import { createServer, type Server, type ServerResponse, type IncomingMessage } from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs/promises';
import { openSync, closeSync, existsSync, fstatSync } from 'node:fs';
import path from 'node:path';
import { buildArguments, inspectProfile, preflightLaunchProfile, probeRuntime, runtimeError, validateProfile } from './ggufConfig';
import type {
  GgufProfile,
  GgufEndpoint,
  RuntimeState,
  ProfileEntry,
  GgufDiscoveryProgress,
} from './ggufTypes';
import { inspectGguf } from './ggufMetadata';
import { collectRuntimeContextEstimate } from './contextDiscovery/contextEstimate';
import {
  getGpuIdentity,
  getHardwareStats,
  getOwnedServerVramBudget,
} from './contextDiscovery/contextHardware';
import {
  buildContextDiscoveryIdentity,
  contextDiscoveryKey,
  stableRuntimeArguments,
} from './contextDiscovery/contextDiscoveryPersistence';
import {
  loadDiscoveryOptions,
  saveDiscoveryOptions,
} from './contextDiscovery/contextDiscoveryStorage';
import { discoverContextBoundary, type DiscoveryProbe } from './contextDiscovery/contextDiscovery';
import {
  defaultContextHostReserveBytes,
  resolveContextReserve,
} from './contextDiscovery/contextEstimate';
import { vramEstimatorMarginBytes } from './contextDiscovery/vramBudget';
import { LlamaServerReadinessTimeout, waitForLlamaServerReadiness } from './managedGgufStartup';
export type { GgufProfile } from './ggufTypes';
function runtimeFingerprint(profile: GgufProfile) {
  return JSON.stringify({
    id: profile.id,
    backend: profile.backend,
    executable: profile.executable,
    args: buildArguments(profile, 0),
  });
}
interface Gateway {
  port: number;
  key: string;
  server?: Server;
}
interface RuntimeLease {
  token: string;
  ownerId: number;
  released: Promise<void>;
  resolveReleased: () => void;
  controller: AbortController;
  inFlight: boolean;
}
export interface ManagedDiscoveryResult {
  result: import('./contextDiscovery/contextEstimator').ContextDiscoveryResult;
  restoredProcess: 'previous-runtime-reloaded' | 'left-unloaded';
  restoredProfileId?: string;
}
interface RuntimeOverride {
  context: number;
  cacheK?: 'f16' | 'q8_0';
  cacheV?: 'f16' | 'q8_0';
}
const discoveryOptionsFile = 'gguf-context-discoveries.json';
async function fileFingerprint(file: string): Promise<string> {
  const metadata = await fs.stat(file);
  return `${metadata.size}:${metadata.mtimeMs}`;
}

async function currentResidentBytes(pid: number): Promise<number> {
  const status = await fs.readFile(`/proc/${pid}/status`, 'utf8');
  const value = /^VmRSS:\s+(\d+) kB$/m.exec(status)?.[1];
  if (!value) throw new Error('GGUF:discoveryMemoryTelemetry:process RSS is unavailable');
  return Number(value) * 1024;
}

function discoveryProbeError(error: unknown): string {
  const detail = String(error).replace(/Bearer\s+\S+/gi, 'Bearer [redacted]');
  if (detail.includes('GGUF:quantizedCache'))
    return 'Q8 KV V требует Flash Attention. Включите его в профиле и повторите поиск.';
  if (detail.includes('GGUF:unsupportedFlag:'))
    return `Выбранный llama-server не поддерживает параметр ${detail.split('GGUF:unsupportedFlag:')[1]?.split(':')[0] ?? 'этого профиля'}.`;
  if (detail.includes('GGUF:unsupportedValue:'))
    return `Выбранный llama-server не объявляет это значение: ${detail.split('GGUF:unsupportedValue:')[1]?.split(':')[0] ?? ''}.`;
  if (detail.includes('devicesInaccessible'))
    return 'Не удалось получить доступ к устройствам GPU через выбранный llama-server.';
  return detail;
}

export class ManagedGguf {
  state: RuntimeState = { phase: 'idle' };
  private profiles: GgufProfile[] = [];
  private logStarts = new Map<string, number>();
  private auditEnabled = false;
  private auditRecords: ProtocolSummary[] = [];
  protocolAudit(enabled?: boolean) {
    if (enabled !== undefined) {
      this.auditEnabled = enabled;
      this.auditRecords = [];
    }
    return this.auditRecords.map((row) => ({
      ...row,
      roles: { ...row.roles },
      finishReasons: [...row.finishReasons],
    }));
  }
  private gateways = new Map<string, Gateway>();
  private owned?: ChildProcess;
  private effectiveProfile?: GgufProfile;
  private runtimeOverrides = new Map<string, RuntimeOverride>();
  private runtimeRequestCount = 0;
  private runtimeLease?: RuntimeLease;
  private discoveryProgress: GgufDiscoveryProgress = { busy: false, stage: '', probeCount: 0 };
  private discoveryFlight?: Promise<ManagedDiscoveryResult>;
  private currentFingerprint?: string;
  private endpoint?: GgufEndpoint;
  private controller?: AbortController;
  private flight?: Promise<GgufEndpoint>;
  private flightId?: string;
  private requests = new Map<string, number>();
  private writes = Promise.resolve();
  private initialized?: Promise<void>;
  constructor(
    private root: string,
    private changed: (state: RuntimeState) => void = () => {},
    private canonicalRuntime?: string
  ) {}
  private publish(state: RuntimeState) {
    this.state = state;
    this.changed(state);
  }
  private publishDiscovery(state: GgufDiscoveryProgress) {
    this.discoveryProgress = state;
    for (const win of BrowserWindow.getAllWindows())
      win.webContents.send('gguf-discovery-progress', state);
  }
  async acquireRuntimeLease(owner: WebContents): Promise<string> {
    await this.initialize();
    if (
      this.runtimeLease ||
      this.runtimeRequestCount ||
      this.flight ||
      ['validating', 'starting', 'stopping'].includes(this.state.phase)
    )
      throw runtimeError('runtimeBusy');
    let resolveReleased = () => {};
    const released = new Promise<void>((resolve) => {
      resolveReleased = resolve;
    });
    const lease: RuntimeLease = {
      token: randomBytes(24).toString('hex'),
      ownerId: owner.id,
      released,
      resolveReleased,
      controller: new AbortController(),
      inFlight: false,
    };
    this.runtimeLease = lease;
    owner.once('destroyed', () => {
      if (this.runtimeLease?.token !== lease.token) return;
      lease.controller.abort();
      if (!lease.inFlight) this.releaseRuntimeLease(lease.token);
    });
    return lease.token;
  }
  private releaseRuntimeLease(token: string): void {
    const lease = this.runtimeLease;
    if (!lease || lease.token !== token) return;
    if (lease.inFlight) return;
    this.runtimeLease = undefined;
    lease.resolveReleased();
  }
  releaseAcquiredLease(token: string): void {
    this.releaseRuntimeLease(token);
  }
  cancelDiscovery(token: string): void {
    const lease = this.runtimeLease;
    if (lease?.token === token) lease.controller.abort();
  }
  discoveryStatus(): GgufDiscoveryProgress {
    return {
      ...this.discoveryProgress,
      ...(this.discoveryProgress.currentCandidate
        ? { currentCandidate: { ...this.discoveryProgress.currentCandidate } }
        : {}),
    };
  }

  private async enterRuntimeRequest(signal: AbortSignal): Promise<() => void> {
    for (;;) {
      signal.throwIfAborted();
      const lease = this.runtimeLease;
      if (lease) {
        await Promise.race([
          lease.released,
          new Promise<never>((_, reject) => {
            const abort = () =>
              reject(
                new DOMException('Request cancelled while waiting for local runtime', 'AbortError')
              );
            signal.addEventListener('abort', abort, { once: true });
            lease.released
              .finally(() => signal.removeEventListener('abort', abort))
              .catch(() => {});
          }),
        ]);
        continue;
      }
      // No await between observing an unlocked runtime and reserving it: lease
      // acquisition and provider admission are atomic on Electron's main loop.
      this.runtimeRequestCount += 1;
      return () => {
        this.runtimeRequestCount = Math.max(0, this.runtimeRequestCount - 1);
      };
    }
  }
  private async waitAdmission(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', abort);
        resolve();
      }, 40);
      const abort = () => {
        clearTimeout(timer);
        reject(new DOMException('Local runtime request cancelled', 'AbortError'));
      };
      signal?.addEventListener('abort', abort, { once: true });
    });
  }
  private async atomic(file: string, value: unknown) {
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
    const temp = path.join(this.root, `${file}.${randomUUID()}.tmp`);
    await fs.writeFile(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
    await fs.rename(temp, path.join(this.root, file));
  }
  async initialize() {
    this.initialized ??= (async () => {
      try {
        this.profiles = JSON.parse(
          await fs.readFile(path.join(this.root, 'gguf-profiles.json'), 'utf8')
        ).map(withGpuLayerDefault);
      } catch (error) {
        if ((error as { code?: string }).code !== 'ENOENT') throw error;
        try {
          const old = JSON.parse(
            await fs.readFile(path.join(this.root, 'gguf-profile.json'), 'utf8')
          );
          this.profiles = [{ ...old, id: randomUUID(), backend: 'external' }];
          await this.atomic('gguf-profiles.json', this.profiles);
        } catch (legacyError) {
          if ((legacyError as { code?: string }).code !== 'ENOENT') throw legacyError;
        }
      }
      try {
        const overrides = JSON.parse(
          await fs.readFile(path.join(this.root, 'gguf-context-overrides.json'), 'utf8')
        ) as Record<string, RuntimeOverride>;
        for (const [id, value] of Object.entries(overrides)) {
          if (
            Number.isInteger(value.context) &&
            value.context >= 512 &&
            ((value.cacheK === undefined && value.cacheV === undefined) ||
              (['f16', 'q8_0'].includes(value.cacheK ?? '') && value.cacheK === value.cacheV))
          )
            this.runtimeOverrides.set(id, value);
        }
      } catch (error) {
        if ((error as { code?: string }).code !== 'ENOENT') throw error;
      }
      try {
        for (const [id, value] of Object.entries(
          JSON.parse(await fs.readFile(path.join(this.root, 'gguf-endpoints.json'), 'utf8'))
        ))
          this.gateways.set(id, value as Gateway);
      } catch (error) {
        if ((error as { code?: string }).code !== 'ENOENT') throw error;
      }
      for (const profile of this.profiles.filter((p) => p.backend !== 'native')) {
        try {
          await this.prepare(profile.id!);
        } catch {
          /* Report bind failure when this profile is selected. */
        }
      }
    })();
    return this.initialized;
  }
  private assertLease(token: string): RuntimeLease {
    if (!this.runtimeLease || this.runtimeLease.token !== token)
      throw runtimeError('discoveryLeaseLost');
    this.runtimeLease.controller.signal.throwIfAborted();
    return this.runtimeLease;
  }
  async diagnostics(profileId: string) {
    this.profile(profileId);
    const active = this.state.profileId === profileId;
    const log =
      active && this.state.logPath
        ? await fs.open(this.state.logPath, 'r').catch(() => null)
        : null;
    let accepted: number | undefined, proposed: number | undefined;
    if (log)
      try {
        const size = (await log.stat()).size,
          buffer = Buffer.alloc(
            Math.min(Math.max(0, size - (this.logStarts.get(profileId) ?? 0)), 16384)
          );
        await log.read(buffer, 0, buffer.length, Math.max(0, size - buffer.length));
        const matches = [
          ...buffer
            .toString()
            .matchAll(/draft acceptance[^\n]*?\(\s*(\d+) accepted\s*\/\s*(\d+) generated/g),
        ];
        const last = matches.at(-1);
        if (last) {
          accepted = Number(last[1]);
          proposed = Number(last[2]);
        }
      } finally {
        await log.close();
      }
    return { args: active ? this.state.args : undefined, accepted, proposed };
  }
  async setEmbeddedMtp(id: string, enabled: boolean) {
    if (typeof enabled !== 'boolean') throw runtimeError('invalidValue', 'MTP');
    const p = this.profile(id);
    if (!(await this.capabilities(id)).embeddedMtp) throw runtimeError('specBackend');
    const saved = await this.save({ ...p, speculativeMode: enabled ? 'mtp-embedded' : 'off' });
    for (const win of BrowserWindow.getAllWindows()) win.webContents.send('gguf-profiles-changed');
    return saved;
  }
  async setVision(id: string, enabled: boolean) {
    if (typeof enabled !== 'boolean') throw runtimeError('invalidValue','visionEnabled');
    const profile = this.profile(id);
    if (enabled && !(await this.capabilities(id)).visionSupported) throw runtimeError('visionPair');
    const saved = await this.save({...profile,visionEnabled:enabled});
    for (const win of BrowserWindow.getAllWindows()) win.webContents.send('gguf-profiles-changed');
    return saved;
  }
  async reloadProfile(id: string, token: string) {
    const lease = this.assertLease(token);
    if (lease.inFlight || this.runtimeRequestCount) throw runtimeError('runtimeBusy');
    if (this.state.profileId !== id || this.state.phase !== 'ready')
      throw runtimeError('runtimeBusy');
    lease.inFlight = true;
    try {
      return await this.start(this.launchProfile(this.profile(id)), lease.controller.signal);
    } finally {
      lease.inFlight = false;
    }
  }
  async capabilities(profileId: string) {
    const p = this.profile(profileId);
    const meta = await inspectGguf(p.model);
    const runtime = await probeRuntime(p.executable);
    const template = !p.chatTemplate ? await readSpeculativeMetadata(p.model).catch(() => undefined) : undefined;
    const reasoning = detectManagedReasoning(template, runtime, !!p.chatTemplate);
    const embeddedMtp =
      p.backend !== 'native' &&
      (!p.speculativeMode || ['off', 'mtp-embedded'].includes(p.speculativeMode)) &&
      (await validateSpeculation({ ...p, speculativeMode: 'mtp-embedded' }, runtime).then(
        () => true,
        () => false
      ));
    let visionSupported = false;
    let visionError: string | undefined;
    if (p.projector) {
      try {
        const projector = await inspectGguf(p.projector);
        visionSupported = ['qwen35','qwen35moe'].includes(meta.architecture ?? '') && projector.architecture === 'clip' && !!meta.embedding && projector.projectorDimension === meta.embedding && runtime.flags.includes('--mmproj');
        if (!visionSupported) visionError = 'GGUF:visionPair:';
      } catch { visionError = 'GGUF:missingFile:'; }
    }
    return {
      visionSupported, visionError,
      embeddedMtp,
      reasoning,
      // Compatibility aliases for the existing Goose managed-provider adapter.
      thinking: reasoning.thinkingToggleSupported,
      nativeEfforts: reasoning.reasoningEffortSupported,
      vision: visionSupported && (this.state.profileId === profileId && this.state.phase === 'ready' ? this.state.args?.includes('--mmproj') === true : p.visionEnabled !== false),
    };
  }
  private async discoveryCatalog(profileId: string) {
    const profile = await resolveFlashAttentionDefault(this.profile(profileId));
    const metadata = await inspectGguf(profile.model);
    const hardLimit = metadata.context ?? 0;
    if (!hardLimit) throw runtimeError('modelContextUnknown', profile.model);
    const args = buildArguments(profile, 0);
    const [modelFingerprint, projectorFingerprint, draftFingerprint, runtimeProbe, gpu] =
      await Promise.all([
        fileFingerprint(profile.model),
        profile.projector && profile.visionEnabled !== false ? fileFingerprint(profile.projector) : Promise.resolve(null),
        profile.draft && profile.speculativeMode && profile.speculativeMode !== 'off'
          ? fileFingerprint(profile.draft)
          : Promise.resolve(undefined),
        probeRuntime(profile.executable),
        getGpuIdentity(),
      ]);
    const identity = buildContextDiscoveryIdentity({
      modelId: profile.model,
      modelFingerprint,
      projectorFingerprint,
      draftFingerprint,
      runtimeFingerprint: `${profile.executable}:${runtimeProbe.version}:${await fileFingerprint(profile.executable)}`,
      arguments: stableRuntimeArguments(args),
      speculative: JSON.stringify({
        mode: profile.speculativeMode ?? 'off',
        draftTokens: profile.draftTokens,
        draftMinTokens: profile.draftMinTokens,
        draftGpuLayers: profile.draftGpuLayers,
        cpuMoe: profile.cpuMoe,
        nCpuMoe: profile.nCpuMoe,
        gpuBlockIds: profile.gpuBlockIds,
        moeCacheMode: profile.moeCacheMode,
        placementIdentity: profile.placementIdentity,
        tensorOverride: profile.tensorOverride,
        moeCacheMiB: profile.moeCacheMiB,
      }),
      hardLimit,
      gpu,
      hostReserveBytes: this.contextReserves().host,
    });
    const key = contextDiscoveryKey(identity);
    const saved = await loadDiscoveryOptions(path.join(this.root, discoveryOptionsFile), {
      configKey: key.key,
      modelId: profile.model,
      hardLimit,
      kvOffload: profile.kvOffload !== false,
    });
    const effective = this.launchProfile(profile);
    return {
      modelId: profile.model,
      hardLimit,
      identityKey: key.key,
      serializedIdentity: key.serialized,
      selectedContext: effective.context,
      selectedKv:
        (effective.cacheK ?? 'f16') === (effective.cacheV ?? 'f16') && effective.cacheK === 'q8_0'
          ? 'q8_0'
          : (effective.cacheK ?? 'f16') === 'f16' && (effective.cacheV ?? 'f16') === 'f16'
            ? 'f16'
            : 'custom',
      supportedKv: runtimeProbe.cacheTypes.filter(
        (value): value is 'f16' | 'q8_0' =>
          value === 'f16' || (value === 'q8_0' && effective.flashAttention === 'on')
      ),
      q8UnavailableReason: effective.flashAttention !== 'on' ? 'flashAttention' : 'backend',
      options: saved.options.filter((option) =>
        runtimeProbe.cacheTypes.includes(option.kvCacheType)
      ),
      previous: saved.previous.filter((option) =>
        runtimeProbe.cacheTypes.includes(option.kvCacheType)
      ),
    };
  }
  private contextReserves() {
    const host = resolveContextReserve(
      process.env.LOCAL_AI_CONTEXT_HOST_RESERVE_BYTES,
      'LOCAL_AI_CONTEXT_HOST_RESERVE_BYTES',
      defaultContextHostReserveBytes
    );
    const device = resolveContextReserve(
      process.env.LOCAL_AI_CONTEXT_DEVICE_RESERVE_BYTES,
      'LOCAL_AI_CONTEXT_DEVICE_RESERVE_BYTES',
      vramEstimatorMarginBytes
    );
    if (host.bytes === null)
      throw runtimeError('invalidReserve', host.error ?? 'LOCAL_AI_CONTEXT_HOST_RESERVE_BYTES');
    if (device.bytes === null)
      throw runtimeError('invalidReserve', device.error ?? 'LOCAL_AI_CONTEXT_DEVICE_RESERVE_BYTES');
    return { host: host.bytes, device: device.bytes };
  }
  async getDiscoveryCatalog(profileId: string) {
    return this.discoveryCatalog(profileId);
  }
  async runContextDiscovery(profileId: string, token: string): Promise<ManagedDiscoveryResult> {
    const lease = this.assertLease(token);
    if (lease.inFlight) throw runtimeError('discoveryAlreadyRunning');
    lease.inFlight = true;
    const run = this.discoverWithLease(profileId, lease).finally(() => {
      lease.inFlight = false;
      this.publishDiscovery({ busy: false, profileId, stage: '', probeCount: 0 });
      this.releaseRuntimeLease(token);
    });
    this.discoveryFlight = run;
    try {
      return await run;
    } finally {
      if (this.discoveryFlight === run) this.discoveryFlight = undefined;
    }
  }
  private async discoverWithLease(
    profileId: string,
    lease: RuntimeLease
  ): Promise<ManagedDiscoveryResult> {
    const selected = await resolveFlashAttentionDefault(this.profile(profileId));
    if (selected.backend === 'native')
      throw runtimeError('nativeUnsupported', 'context discovery requires managed llama-server');
    if (selected.moeCacheMode === 'automatic') throw runtimeError('placement', 'Choose a fixed Manual cache size before discovery; Auto cache would change probe memory assumptions.');
    const capabilities = await probeRuntime(selected.executable);
    for (const flag of ['--ctx-size', '--cache-type-k', '--cache-type-v', '--verbose']) {
      if (!capabilities.flags.includes(flag)) throw runtimeError('unsupportedFlag', flag);
    }
    const metadata = await inspectGguf(selected.model);
    if (!metadata.context) throw runtimeError('modelContextUnknown', selected.model);
    const original = this.effectiveProfile ? { ...this.effectiveProfile } : undefined;
    const wasLoaded = this.state.phase === 'ready' && !!original && !!this.owned;
    const originalId = original?.id;
    const controller = lease.controller;
    const reserves = this.contextReserves();
    const catalog = await this.discoveryCatalog(profileId);
    const logPath = path.join(this.root, `gguf-${profileId}.log`);
    this.publishDiscovery({
      busy: true,
      profileId,
      stage: 'Подготовка probe runtime',
      probeCount: 0,
    });
    try {
      const result = await discoverContextBoundary({
        modelId: selected.model,
        hardLimit: metadata.context,
        kvOffload: selected.kvOffload !== false,
        kvModes: capabilities.cacheTypes.filter(
          (value): value is 'f16' | 'q8_0' => value === 'f16' || value === 'q8_0'
        ),
        hostReserveBytes: reserves.host,
        deviceReserveBytes: reserves.device,
        signal: controller.signal,
        progress: (stage, probeCount, currentCandidate) =>
          this.publishDiscovery({
            busy: true,
            profileId,
            stage,
            probeCount,
            ...(currentCandidate ? { currentCandidate } : {}),
          }),
        probe: async (context, kv, phase): Promise<DiscoveryProbe> => {
          controller.signal.throwIfAborted();
          const started = Date.now();
          const record: DiscoveryProbe['record'] = {
            kvCacheType: kv,
            contextWindow: context,
            phase,
            startup: false,
            health: false,
            inference: false,
            fits: false,
            headroom: null,
            memoryBaseline: null,
            elapsedMs: 0,
          };
          const temp = {
            ...selected,
            context,
            cacheK: kv,
            cacheV: kv,
            kvOffload: selected.kvOffload !== false,
          };
          try {
            // llama.cpp emits the per-buffer allocation evidence only at verbose
            // levels. This flag is limited to these synthetic discovery probes.
            const endpoint = await this.start(temp, controller.signal, true);
            record.startup = true;
            const health = await fetch(`${endpoint.url}/health`, {
              headers: { Authorization: `Bearer ${endpoint.key}` },
              signal: controller.signal,
            });
            record.health = health.ok;
            if (!health.ok) throw runtimeError('discoveryHealth', String(health.status));
            const response = await fetch(`${endpoint.url}/v1/chat/completions`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${endpoint.key}`,
              },
              body: JSON.stringify({
                model: 'local-gguf',
                messages: [{ role: 'user', content: 'Reply with the single word OK.' }],
                max_tokens: 2,
                stream: false,
              }),
              signal: controller.signal,
            });
            if (!response.ok) throw runtimeError('discoveryInference', String(response.status));
            await response.arrayBuffer();
            record.inference = true;
            const child = this.owned;
            if (!child?.pid) throw runtimeError('discoveryProcessMissing');
            const [hardware, vramBudget, residentBytes, modelFileSizeBytes] = await Promise.all([
              getHardwareStats(),
              getOwnedServerVramBudget(child.pid),
              currentResidentBytes(child.pid),
              fs.stat(selected.model).then((stat) => stat.size),
            ]);
            record.hardware = {
              ramTotalBytes: hardware.ramTotalBytes,
              ramUsedBytes: hardware.ramUsedBytes,
              vramTotalBytes: hardware.vramTotalBytes,
              vramUsedBytes: hardware.vramUsedBytes,
              vramAvailableBytes: hardware.vramAvailableBytes,
            };
            record.vramBudget = vramBudget;
            record.args = endpoint.args;
            const estimate = await collectRuntimeContextEstimate({
              backend: 'llama-cpp',
              modelId: selected.model,
              configuredMaxTokens: context,
              contextPresets: [context],
              hardware,
              runtime: {
                backend: 'llama-cpp',
                modelId: selected.model,
                activeContextTokens: context,
                modelPath: selected.model,
                modelTrainContextTokens: metadata.context,
                modelFileSizeBytes,
                residentBytes,
                deviceResidentBytes: vramBudget.llmBytes,
                kvCacheType: kv,
                kvOffload: selected.kvOffload !== false,
              },
              startupLogPath: logPath,
              hostReserveBytes: defaultContextHostReserveBytes,
              deviceReserveBytes: vramEstimatorMarginBytes,
              runtimeArguments: endpoint.args,
            }, async () => ({ text: (await fs.readFile(logPath)).subarray(this.logStarts.get(profileId) ?? 0).toString('utf8') }));
            if (estimate.unknownReasons.length) record.reason = estimate.unknownReasons.join("; ");
            if (estimate.memoryHeadroom) record.headroom = estimate.memoryHeadroom;
            if (estimate.memoryBaseline) record.memoryBaseline = estimate.memoryBaseline;
            record.elapsedMs = Date.now() - started;
            return { record, estimate: { ...estimate, vramBudget } };
          } catch (error) {
            record.reason = discoveryProbeError(error);
            record.elapsedMs = Date.now() - started;
            return { record, estimate: null };
          }
        },
        restore: async () => {
          // This runs even after cancellation and stays inside the lease.
          await this.stopChild();
          if (wasLoaded && original) {
            const restored = await this.start(original, new AbortController().signal);
            if (!restored) throw runtimeError('discoveryRestoreFailed');
          } else {
            this.publish({ phase: 'idle' });
          }
        },
      });
      const restoredProcess = wasLoaded
        ? ('previous-runtime-reloaded' as const)
        : ('left-unloaded' as const);
      const successful = result.options;
      await saveDiscoveryOptions(
        path.join(this.root, discoveryOptionsFile),
        catalog.identityKey,
        catalog.serializedIdentity,
        successful,
        Date.now(),
        true,
        selected.model
      );
      return {
        result,
        restoredProcess,
        ...(wasLoaded && originalId ? { restoredProfileId: originalId } : {}),
      };
    } finally {
      // discoverContextBoundary guarantees restore; this guard covers setup failures
      // before its try/finally is entered.
      if (this.owned && !wasLoaded) {
        await this.stopChild();
        this.publish({ phase: 'idle' });
      }
    }
  }
  async applyContext(
    profileId: string,
    context: number,
    kv: 'f16' | 'q8_0' | 'custom',
    token: string
  ) {
    const lease = this.assertLease(token);
    if (lease.inFlight) throw runtimeError('runtimeBusy');
    lease.inFlight = true;
    try {
      const profile = this.profile(profileId);
      const metadata = await inspectGguf(profile.model);
      if (
        !Number.isInteger(context) ||
        context < 512 ||
        context > 1_048_576 ||
        (metadata.context && context > metadata.context)
      )
        throw runtimeError('invalidValue', 'context');
      const previous = this.effectiveProfile ? { ...this.effectiveProfile } : undefined;
      const previousOverride = this.runtimeOverrides.get(profileId);
      const loaded = this.state.phase === 'ready' && this.state.profileId === profileId;
      await validateProfile(
        kv === 'custom'
          ? { ...this.launchProfile(profile), context }
          : { ...profile, context, cacheK: kv, cacheV: kv }
      );
      if (!loaded) {
        this.runtimeOverrides.set(
          profileId,
          kv === 'custom' ? { ...previousOverride, context } : { context, cacheK: kv, cacheV: kv }
        );
        try {
          await this.persistRuntimeOverrides();
        } catch (error) {
          if (previousOverride) this.runtimeOverrides.set(profileId, previousOverride);
          else this.runtimeOverrides.delete(profileId);
          throw error;
        }
        this.publish({ ...this.state });
        return { applied: false, loaded: false, context, kv };
      }
      try {
        const candidate =
          kv === 'custom'
            ? { ...(previous?.id === profileId ? previous : profile), context }
            : { ...profile, context, cacheK: kv, cacheV: kv };
        const endpoint = await this.start(candidate, lease.controller.signal);
        this.runtimeOverrides.set(
          profileId,
          kv === 'custom' ? { ...previousOverride, context } : { context, cacheK: kv, cacheV: kv }
        );
        await this.persistRuntimeOverrides();
        return {
          applied: true,
          loaded: true,
          context,
          kv,
          endpoint: { url: endpoint.url, args: endpoint.args },
        };
      } catch (error) {
        if (previousOverride) this.runtimeOverrides.set(profileId, previousOverride);
        else this.runtimeOverrides.delete(profileId);
        await this.persistRuntimeOverrides().catch(() => {});
        const rollback = previous
          ? await this.start(previous, new AbortController().signal).then(
              () => true,
              () => false
            )
          : false;
        throw runtimeError(
          'applyFailed',
          `${String(error)}; rollback=${rollback ? 'verified' : 'failed'}`
        );
      }
    } finally {
      lease.inFlight = false;
      this.releaseRuntimeLease(token);
    }
  }
  async list(): Promise<ProfileEntry[]> {
    await this.initialize();
    return Promise.all(
      this.profiles.map(async (stored) => {
        const profile = this.canonicalRuntime && stored.backend !== 'native' ? { ...stored, executable: this.canonicalRuntime } : stored;
        let inaccessible = profile.model;
        try {
          for (const file of [
            profile.model,
            profile.visionEnabled === false ? undefined : profile.projector,
            profile.speculativeMode === 'mtp-external' || profile.speculativeMode === 'draft-simple'
              ? profile.draft
              : undefined,
            profile.backend !== 'native' ? profile.executable : undefined,
          ].filter(Boolean) as string[]) {
            inaccessible = file;
            await fs.access(file, file === profile.executable ? 1 : 0);
          }
          return { profile, available: true };
        } catch {
          return { profile, available: false, error: 'GGUF:missingFile:' + inaccessible };
        }
      })
    );
  }
  async save(profile: GgufProfile): Promise<GgufProfile> {
    await this.initialize();
    profile = withGpuLayerDefault(profile);
    if (this.canonicalRuntime && profile.backend !== 'native') profile = { ...profile, executable: this.canonicalRuntime };
    if (!profile.id) profile = await resolveFlashAttentionDefault(profile);
    await validateProfile(profile);
    if (
      profile.backend === 'native' &&
      this.profiles.some(
        (p) => p.backend === 'native' && p.model === profile.model && p.id !== profile.id
      )
    )
      throw runtimeError('nativeDuplicatePath');
    const saved = { ...profile, id: profile.id ?? randomUUID() };
    const write = this.writes.then(async () => {
      const next = this.profiles.filter((p) => p.id !== saved.id);
      next.push(saved);
      await this.atomic('gguf-profiles.json', next);
      this.profiles = next;
    });
    this.writes = write.catch(() => {});
    await write;
    return saved;
  }
  async delete(id: string) {
    await this.initialize();
    if (this.state.profileId === id) await this.unload();
    const write = this.writes.then(async () => {
      const next = this.profiles.filter((p) => p.id !== id);
      await this.atomic('gguf-profiles.json', next);
      this.profiles = next;
    });
    this.writes = write.catch(() => {});
    await write;
    const gateway = this.gateways.get(id);
    gateway?.server?.close();
    gateway?.server?.closeAllConnections();
    this.gateways.delete(id);
    this.runtimeOverrides.delete(id);
    await this.persistRuntimeOverrides();
    await this.persistGateways();
  }
  private profile(id: string) {
    const profile = this.profiles.find((p) => p.id === id);
    if (!profile) throw runtimeError('profileMissing', id);
    return this.canonicalRuntime && profile.backend !== 'native' ? { ...profile, executable: this.canonicalRuntime } : profile;
  }
  private async persistGateways() {
    await this.atomic(
      'gguf-endpoints.json',
      Object.fromEntries([...this.gateways].map(([id, g]) => [id, { port: g.port, key: g.key }]))
    );
  }
  private async persistRuntimeOverrides() {
    await this.atomic('gguf-context-overrides.json', Object.fromEntries(this.runtimeOverrides));
  }
  async prepare(id: string): Promise<GgufEndpoint> {
    // initialize calls prepare; do not recursively await initialize here.
    const profile = this.profile(id);
    if (profile.backend === 'native') throw runtimeError('nativeUnsupported', 'gateway');
    let gateway = this.gateways.get(id);
    if (!gateway) {
      gateway = { port: 0, key: randomBytes(32).toString('hex') };
      this.gateways.set(id, gateway);
    }
    if (!gateway.server) {
      const server = createServer((req, res) => {
        void this.route(id, req, res);
      });
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(gateway!.port, '127.0.0.1', () => {
          server.removeListener('error', reject);
          resolve();
        });
      }).catch(() => {
        throw runtimeError('portConflict', String(gateway!.port));
      });
      gateway.server = server;
      gateway.port = (server.address() as { port: number }).port;
      await this.persistGateways();
    }
    return { url: `http://127.0.0.1:${gateway.port}`, key: gateway.key };
  }
  private async route(id: string, req: IncomingMessage, res: ServerResponse) {
    const controller = new AbortController();
    let counted = false;
    let leaveRuntimeRequest: (() => void) | undefined;
    let observation: ProtocolObservation | undefined;
    res.on('close', () => {
      if (!res.writableEnded) controller.abort();
      if (counted) {
        counted = false;
        this.requests.set(id, Math.max(0, (this.requests.get(id) ?? 1) - 1));
      }
      if (!res.writableEnded && this.flightId === id && !(this.requests.get(id) ?? 0))
        this.controller?.abort();
    });
    try {
      const gateway = this.gateways.get(id)!;
      const provided = Buffer.from(req.headers.authorization ?? '');
      const expected = Buffer.from(`Bearer ${gateway.key}`);
      if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
        res.writeHead(401).end();
        return;
      }
      const profile = this.profile(id);
      const effective =
        this.effectiveProfile?.id === id ? this.effectiveProfile : this.launchProfile(profile);
      if (req.method === 'GET' && ['/v1/models', '/models'].includes(req.url ?? '')) {
        const metadata = await inspectGguf(profile.model).catch(() => ({ context: undefined }));
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify({
            object: 'list',
            data: [
              {
                id: 'local-gguf',
                object: 'model',
                owned_by: 'local',
                context_window: effective.context,
                meta: {
                  n_ctx: effective.context,
                  n_ctx_train: metadata.context ?? effective.context,
                },
              },
            ],
          })
        );
        return;
      }
      if (
        req.method !== 'POST' ||
        !['/v1/chat/completions', '/chat/completions'].includes(req.url ?? '')
      ) {
        res.writeHead(404).end();
        return;
      }
      const chunks: Buffer[] = [];
      let length = 0;
      for await (const chunk of req) {
        length += chunk.length;
        if (length > 32 * 1024 * 1024) throw runtimeError('requestTooLarge');
        chunks.push(Buffer.from(chunk));
      }
      if (controller.signal.aborted) return;
      leaveRuntimeRequest = await this.enterRuntimeRequest(controller.signal);
      if (controller.signal.aborted) return;
      if (this.auditEnabled) {
        observation = new ProtocolObservation(Buffer.concat(chunks));
        this.auditRecords.push(observation.summary);
        if (this.auditRecords.length > 32) this.auditRecords.shift();
      }
      const endpoint = await this.activate(id, true, controller.signal);
      if (controller.signal.aborted) return;
      counted = true;
      this.requests.set(id, (this.requests.get(id) ?? 0) + 1);
      const response = await fetch(endpoint.url + '/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${endpoint.key}` },
        body: Buffer.concat(chunks),
        signal: controller.signal,
      });
      res.writeHead(response.status, {
        'Content-Type': response.headers.get('content-type') ?? 'application/json',
        'Cache-Control': 'no-store',
      });
      if (response.body) {
        const reader = response.body.getReader();
        try {
          while (!controller.signal.aborted) {
            const { done, value } = await reader.read();
            if (done) break;
            observation?.chunk(value);
            if (!res.write(value))
              await new Promise<void>((resolve) => {
                res.once('drain', resolve);
                res.once('close', resolve);
              });
          }
        } finally {
          await reader.cancel().catch(() => {});
        }
      }
      res.end();
    } catch {
      if (!res.destroyed) {
        if (res.headersSent) {
          // Once SSE starts, abort the transport instead of corrupting it with a JSON error.
          res.destroy();
        } else {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              error: {
                message: this.state.error?.includes('GGUF:deviceMemory:')
                  ? 'GGUF:deviceMemory:'
                  : 'GGUF:upstreamFailure:',
                type: 'local_runtime_error',
              },
            })
          );
        }
      }
    } finally {
      observation?.finish();
      if (counted) {
        counted = false;
        this.requests.set(id, Math.max(0, (this.requests.get(id) ?? 1) - 1));
      }
      leaveRuntimeRequest?.();
    }
  }
  async activate(
    id: string,
    fromRequest = false,
    requestSignal?: AbortSignal
  ): Promise<GgufEndpoint> {
    await this.initialize();
    if (!fromRequest && this.runtimeLease) throw runtimeError('runtimeBusy');
    // Saved profile edits remain pending for the loaded shared process until explicit reload.
    if (
      fromRequest &&
      this.state.profileId === id &&
      this.state.phase === 'ready' &&
      this.endpoint &&
      this.owned?.exitCode === null &&
      this.owned.signalCode === null
    )
      return this.endpoint;
    const profile = this.profile(id);
    const launchProfile = await resolveFlashAttentionDefault(this.launchProfile(profile));
    const fingerprint = runtimeFingerprint(launchProfile);
    if (
      this.state.phase === 'ready' &&
      this.currentFingerprint === fingerprint &&
      this.endpoint &&
      this.owned?.exitCode === null &&
      this.owned.signalCode === null
    )
      return this.endpoint;
    if (!fromRequest && this.runtimeRequestCount > 0) throw runtimeError('runtimeBusy');
    if (
      this.state.phase === 'ready' &&
      this.currentFingerprint !== fingerprint &&
      (this.requests.get(id) ?? 0) > (fromRequest ? 1 : 0)
    )
      throw runtimeError('runtimeBusy');
    if ([...this.requests].some(([other, count]) => other !== id && count > 0)) {
      if (!fromRequest) throw runtimeError('runtimeBusy');
      await this.waitAdmission(requestSignal);
      return this.activate(id, true, requestSignal);
    }
    if (this.flight) {
      if (this.flightId === id) return this.flight;
      if (!fromRequest) throw runtimeError('runtimeBusy');
      await Promise.race([
        this.flight.catch(() => {}),
        new Promise<never>((_, reject) => {
          const abort = () =>
            reject(new DOMException('Local runtime request cancelled', 'AbortError'));
          requestSignal?.addEventListener('abort', abort, { once: true });
          this.flight
            ?.finally(() => requestSignal?.removeEventListener('abort', abort))
            .catch(() => {});
        }),
      ]);
      return this.activate(id, true, requestSignal);
    }
    this.controller = new AbortController();
    this.flightId = id;
    const signal = this.controller.signal;
    this.flight = this.start(launchProfile, signal).finally(() => {
      this.flight = undefined;
      this.flightId = undefined;
    });
    return this.flight;
  }
  private launchProfile(profile: GgufProfile): GgufProfile {
    const override = this.runtimeOverrides.get(profile.id!);
    return override
      ? {
          ...profile,
          context: override.context,
          ...(override.cacheK ? { cacheK: override.cacheK, cacheV: override.cacheV } : {}),
        }
      : { ...profile };
  }
  private async waitForRuntimeLease(): Promise<void> {
    while (this.runtimeLease) await this.runtimeLease.released;
  }
  private async start(
    profile: GgufProfile,
    signal: AbortSignal,
    verboseDiagnostics = false
  ): Promise<GgufEndpoint> {
    profile = await resolveFlashAttentionDefault(profile);
    const id = profile.id!;
    let logStart = 0;
    try {
      await this.stopChild();
      this.publish({ phase: 'validating', profileId: id });
      const capabilities =
        profile.backend === 'native' ? undefined : await probeRuntime(profile.executable);
      if (!capabilities) await validateProfile(profile);
      const launchConfiguration = capabilities ? await preflightLaunchProfile(profile, capabilities) : profile;
      signal.throwIfAborted();
      if (profile.backend === 'native') throw runtimeError('nativeUnsupported', 'external process');
      const port = await new Promise<number>((resolve, reject) => {
        const server = createTcpServer();
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
          const port = (server.address() as { port: number }).port;
          server.close(() => resolve(port));
        });
      });
      const key = randomBytes(32).toString('hex');
      const args = buildArguments(launchConfiguration, port);
      if (verboseDiagnostics) args.push('--verbose');
      if (
        (profile.speculativeMode ?? 'off') === 'off' &&
        capabilities?.flags.includes('--spec-type')
      )
        args.push('--spec-type', 'none');
      const logPath = path.join(this.root, `gguf-${id}.log`);
      const fd = openSync(logPath, 'a', 0o600);
      logStart = fstatSync(fd).size;
      this.logStarts.set(id, logStart);
      let child: ChildProcess;
      try {
        signal.throwIfAborted();
        const protectedLinux = process.platform === 'linux' && existsSync('/usr/bin/setpriv');
        child = spawn(
          protectedLinux ? '/usr/bin/setpriv' : profile.executable,
          protectedLinux ? ['--pdeathsig', 'KILL', profile.executable, ...args] : args,
          {
            stdio: ['ignore', fd, fd],
            env: {
              ...process.env,
              LLAMA_API_KEY: key,
              ...((profile.speculativeMode ?? 'off') === 'off' ||
              profile.speculativeMode === 'mtp-embedded'
                ? { LLAMA_ARG_MODEL_DRAFT: '' }
                : {}),
            },
          }
        );
      } finally {
        closeSync(fd);
      }
      this.owned = child;
      let failure: Error | undefined;
      const guardedPlacement = profile.gpuBlockIds !== undefined || !!launchConfiguration.moeCacheMiB;
      let stopMemoryWatch: (() => void) | undefined;
      if (guardedPlacement) {
        try { await attachOwnedMemoryScope(child.pid!); } catch (error) { child.kill('SIGTERM'); throw error; }
        stopMemoryWatch = watchOwnedMemory(() => {
          if (this.owned !== child) return;
          failure = runtimeError('placement', 'Memory safety stop: 7 GiB RAM reserve unavailable');
          this.publish({ phase: 'failed', profileId: id, args, logPath, error: failure.message });
          this.endpoint = undefined; this.currentFingerprint = undefined;
          child.kill('SIGTERM');
        });
        child.once('exit', () => stopMemoryWatch?.());
      }
      this.publish({ phase: 'starting', profileId: id, args, logPath });
      child.on('error', (error) => {
        failure = error;
      });
      child.once('exit', (code, exitSignal) => {
        if (this.owned === child) {
          this.owned = undefined;
          this.endpoint = undefined;
          this.currentFingerprint = undefined;
          this.effectiveProfile = undefined;
          if (this.state.phase !== 'stopping' && !signal.aborted)
            this.publish({
              phase: 'failed',
              profileId: id,
              error: failure?.message ?? `GGUF:processExit:${code ?? exitSignal}; ${logPath}`,
              args,
              logPath,
            });
          void classifyRuntimeFailure(logPath, logStart).then((reason) => {
            if (
              reason === 'deviceMemory' &&
              this.state.phase === 'failed' &&
              this.state.logPath === logPath
            )
              this.publish({ ...this.state, error: 'GGUF:deviceMemory:' });
          });
        }
      });
      try {
        await waitForLlamaServerReadiness({
          signal,
          assertRunning: () => {
            if (failure) throw failure;
            if (child.exitCode !== null || child.signalCode !== null)
              throw runtimeError('processExit', logPath);
          },
          probe: async (timeoutMs) => {
            try {
              const response = await fetch(`http://127.0.0.1:${port}/health`, {
                headers: { Authorization: `Bearer ${key}` },
                signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
              });
              return response.ok;
            } catch {
              signal.throwIfAborted();
              return false;
            }
          },
        });
      } catch (error) {
        if (error instanceof LlamaServerReadinessTimeout) throw runtimeError('timeout', logPath);
        throw error;
      }
      signal.throwIfAborted();
      this.endpoint = { url: `http://127.0.0.1:${port}`, key, args, logPath };
      this.currentFingerprint = runtimeFingerprint(profile);
      this.effectiveProfile = { ...profile };
      this.publish({ phase: 'ready', profileId: id, args, logPath });
      return this.endpoint;
    } catch (error) {
      const failedLogPath = this.state.profileId === id ? this.state.logPath : undefined;
      const failedArgs = this.state.profileId === id ? this.state.args : undefined;
      const failureCode = await classifyRuntimeFailure(failedLogPath, logStart);
      await this.stopChild();
      this.publish(
        signal.aborted
          ? { phase: 'idle' }
          : {
              phase: 'failed',
              profileId: id,
              error: failureCode === 'deviceMemory' ? 'GGUF:deviceMemory:' : String(error),
              logPath: failedLogPath,
              args: failedArgs,
            }
      );
      throw error;
    }
  }
  private async stopChild() {
    const child = this.owned;
    this.endpoint = undefined;
    this.currentFingerprint = undefined;
    this.effectiveProfile = undefined;
    if (!child) return;
    this.publish({ ...this.state, phase: 'stopping' });
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
      if (child.exitCode !== null || child.signalCode !== null) {
        clearTimeout(timer);
        resolve();
      } else child.kill('SIGTERM');
    });
    if (this.owned === child) this.owned = undefined;
  }
  async unload(force = false) {
    if (!force && this.runtimeLease) throw runtimeError('runtimeBusy');
    await this.waitForRuntimeLease();
    if (!force && this.runtimeRequestCount > 0) throw runtimeError('runtimeBusy');
    this.controller?.abort();
    await this.flight?.catch(() => {});
    await this.stopChild();
    this.publish({ phase: 'idle' });
  }
  async shutdown() {
    const lease = this.runtimeLease;
    lease?.controller.abort();
    if (lease && !lease.inFlight) this.releaseRuntimeLease(lease.token);
    await this.discoveryFlight?.catch(() => {});
    await this.unload(true);
    for (const gateway of this.gateways.values()) {
      gateway.server?.closeAllConnections();
      gateway.server?.close();
    }
  }
  killOnExit() {
    this.owned?.kill('SIGKILL');
  }
}
let service: ManagedGguf;
export async function stopManagedGguf() {
  await service?.unload();
}
export function registerManagedGguf() {
  const canonical = app.isPackaged ? path.join(process.resourcesPath, 'llama', 'llama-server') : path.resolve(app.getAppPath(), '../../runtime/llama/llama-server');
  service = new ManagedGguf(app.getPath('userData'), (state) => {
    for (const win of BrowserWindow.getAllWindows()) win.webContents.send('gguf-state', state);
  }, canonical);
  ipcMain.handle('gguf-runtime', () => canonical);
  ipcMain.handle('gguf-list', () => service.list());
  const profilesChanged = () => {
    for (const win of BrowserWindow.getAllWindows()) win.webContents.send('gguf-profiles-changed');
  };
  ipcMain.handle('gguf-save', async (_event, profile: GgufProfile) => {
    const saved = await service.save(profile);
    profilesChanged();
    return saved;
  });
  ipcMain.handle('gguf-delete', async (_event, id: string) => {
    await service.delete(id);
    profilesChanged();
  });
  ipcMain.handle('gguf-validate', (_event, profile: GgufProfile) => inspectProfile(profile.backend === 'native' ? profile : { ...profile, executable: canonical }));
  ipcMain.handle('gguf-diagnostics', (_event, id: string) => service.diagnostics(id));
  ipcMain.handle('gguf-set-vision', (_event,id:string,enabled:boolean) => service.setVision(id,enabled));
  ipcMain.handle('gguf-set-mtp', (_event, id: string, enabled: boolean) =>
    service.setEmbeddedMtp(id, enabled)
  );
  ipcMain.handle('gguf-reload-profile', (_event, id: string, token: string) =>
    service.reloadProfile(id, token)
  );
  ipcMain.handle('gguf-capabilities', (_event, id: string) => service.capabilities(id));
  ipcMain.handle('gguf-placement', async (_event, profile: GgufProfile) => placementPreview({ ...profile, executable: canonical }, await probeRuntime(canonical)));
  ipcMain.handle('gguf-probe', (_event, _executable: string) => probeRuntime(canonical));
  ipcMain.handle('gguf-discovery-catalog', (_event, id: string) => service.getDiscoveryCatalog(id));
  ipcMain.handle('gguf-discovery-acquire', (event) => service.acquireRuntimeLease(event.sender));
  ipcMain.handle('gguf-discovery-release', (_event, token: string) =>
    service.releaseAcquiredLease(token)
  );
  ipcMain.handle('gguf-discovery-cancel', (_event, token: string) =>
    service.cancelDiscovery(token)
  );
  ipcMain.handle('gguf-discovery-run', (_event, id: string, token: string) =>
    service.runContextDiscovery(id, token)
  );
  ipcMain.handle('gguf-discovery-status', () => service.discoveryStatus());
  ipcMain.handle(
    'gguf-apply-context',
    (_event, id: string, context: number, kv: 'f16' | 'q8_0' | 'custom', token: string) =>
      service.applyContext(id, context, kv, token)
  );
  ipcMain.handle('gguf-prepare', async (_event, id: string) => {
    await service.initialize();
    return service.prepare(id);
  });
  ipcMain.handle('gguf-start', (_event, id: string) => service.activate(id));
  ipcMain.handle('gguf-state', () => service.state);
  ipcMain.handle('gguf-protocol-audit', (_event, enabled?: boolean) =>
    service.protocolAudit(enabled)
  );
  ipcMain.handle('gguf-stop', () => service.unload());
  void service
    .initialize()
    .catch((error) => console.error('Local profiles initialization failed', String(error)));
  let quitting = false;
  app.on('before-quit', (event) => {
    if (quitting) return;
    event.preventDefault();
    quitting = true;
    void service.shutdown().finally(() => app.quit());
  });
  process.on('exit', () => service.killOnExit());
}
