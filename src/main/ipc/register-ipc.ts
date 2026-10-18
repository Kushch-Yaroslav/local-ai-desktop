import { liveMultimodal } from '../services/browser-vision';
import type { BrowserVisionMode } from '../../shared/browser-qa';
import { mtpCapability, resolveMtpMode } from '../services/mtp-capability';
import { parseMtpMetrics } from '../services/mtp-diagnostics';
import type { MtpStatus, MtpMode } from '../../shared/types';
import { liveBrowsers } from '../web/live-browser';
import { AutonomySessions } from '../services/autonomy-session';
import type { AutonomyMode, LoopAction } from '../../shared/autonomy';
import { ApprovalBroker } from '../services/approval-broker';
import { resolveLlamaExecutable } from '../services/llama-executable';
import { DiagramValidationBridge } from '../services/diagram-validation';
import { VisionDeviceController, type VisionDevice } from '../services/vision-device-controller';
import { t } from '../../shared/locale';
import { BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { randomUUID } from 'node:crypto';
import type { AnalysisRun, ApprovalDecision, ChatRequest, Conversation, ProjectReference, ProjectSuggestion, SteeringIntent, ThinkingTimelineEvent } from '../../shared/types';
import { findFreshContextDiscoveryOption, type ContextDiscoveryOption, type ContextDiscoveryResult, type ContextDiscoveryProgress, type RuntimeContextEstimate } from '../../shared/context-estimator';
import { activeConversationModel, initialModelContext } from '../../shared/model-selection';
import { defaultLlamaKv, normalContextForModel, resolveLlamaKvSelection } from '../../shared/context-options';
import { Database } from '../services/database';
import { getGpuIdentity, getHardwareStats, getOwnedServerVramBudget } from '../services/hardware';
import { buildContextDiscoveryIdentity, contextDiscoveryKey, mergeSavedDiscoveryOptions, stableRuntimeArguments } from '../services/context-discovery-persistence';
import { DiscoveryConditionTracker, discoveryConditionSample } from '../services/context-discovery-conditions';
import { vramBudgetStillFits, vramProbeGuardBytes } from '../../shared/vram-budget';
import { LlamaCppBackend } from '../backends/llama-cpp-backend';
import { LlamaRuntimeController, type LlamaRuntimeState } from '../services/llama-runtime-controller';
import { RustAgentRuntime, taskPlan, type AgentProject } from '../services/rust-agent-runtime';
import { paths } from '../services/paths';
import { runtimeDraftAvailability, effectiveRuntimeConfiguration, dismissRuntimeSetup, saveImageProcessingDevice, normalizeConfiguration, runtimeSetup, saveRuntimeConfiguration } from '../services/runtime-settings';
import { archiveAgentEvidence, discardAgentEvidence } from '../services/agent-evidence';
import { log } from '../services/logger';
import { getModelProfile } from '../models/model-registry';
import { agentReasoningOptions, llamaContextPresets, llamaRuntimeProfile, reasoningCapability } from '../models/llama-runtime-policy';
import { reasoningPatchError, resolveReasoningSelection, type ReasoningInput } from '../../shared/reasoning-controls';
import { WebBrowserService } from '../web/web-tools';
import { WebChatService } from '../services/web-chat';
import { RemoteImageService } from '../services/remote-image-service';
import { richArtifactFingerprint } from '../../shared/rich-artifacts';
import { ReadonlyProjectTools } from '../tools/project-tools';
import { imageMimeType, AttachmentService } from '../services/attachment-service';
import { AttachmentPipeline } from '../services/attachment-pipeline';
import { readFile } from 'node:fs/promises';
import { saveGenerationDiagnosticsBestEffort } from '../services/generation-diagnostics';
import { projectDirectoryName } from '../../shared/project-references';
import { executionMode } from '../../shared/generation-mode';
import { enabledAgentTools, explicitWorkspaceRoots, restoreHistoricalTaskScope } from '../services/agent-workspace';
import { homedir } from 'node:os';
import { pinLegacyReasoning, touchesRuntime } from '../../shared/conversation-settings';
import { existingProjectDirectory } from '../services/project-picker';
import { collectRuntimeContextEstimate, defaultContextDeviceReserveBytes, defaultContextHostReserveBytes, resolveContextReserve } from '../services/context-estimate';
import { join } from 'node:path';
import { llamaCapabilityLimit } from '../services/gguf-context';
import { ggufArtifactFingerprint } from '../services/gguf-artifacts';
import { discoverContextBoundary, predictContextHeadroom, type DiscoveryProbe } from '../services/context-discovery';

const database = new Database();
const initialLlamaKvType = defaultLlamaKv.llamaKvCacheType;
const initialLlamaKvOffload = defaultLlamaKv.llamaKvOffload;
const llamaCppUrl = process.env.LOCAL_AI_LLAMA_CPP_URL ?? 'http://127.0.0.1:8081';
const llamaCpp = new LlamaCppBackend(llamaCppUrl, 32_768, false, null);
const backend = llamaCpp;
// A live/stale launcher document is not an explicit selection in this Electron process.
let modelSelectedThisProcess = false;
const remoteImages = new RemoteImageService();
const web = new WebBrowserService(undefined, remoteImages);
const attachments = new AttachmentService(database);
const rustAgent = new RustAgentRuntime(process.env.LOCAL_AI_AGENT_ENDPOINT ?? `${llamaCppUrl.replace(/\/$/, '')}/v1/chat/completions`, undefined, web, (args) => {
  if (typeof args.attachment_id !== 'string') throw new Error(t('Выберите вложенную таблицу или CSV по ID.'));
  return attachments.readStructuredRows(args.attachment_id, typeof args.sheet_name === 'string' ? args.sheet_name : undefined, typeof args.start_row === 'number' ? args.start_row : 0, typeof args.max_rows === 'number' ? args.max_rows : 50);
});
const webChat = new WebChatService(backend, web);
const attachmentPipeline = new AttachmentPipeline(database, attachments);
type ActiveGeneration = {
  logicalTaskId?: string;
  id: string;
  abort: AbortController;
  settled: Promise<void>;
  finish: () => void;
  mode?: 'chat' | 'agent';
  followups?: Array<{ message: import('../../shared/types').ChatMessage; applied: boolean }>;
  thinkingTimeline: ThinkingTimelineEvent[];
  richArtifacts: import('../../shared/rich-artifacts').RichArtifact[];
  activityTimelinePositions: Map<string, number>;
  timelinePosition: number;
  lastTimelineKind: ThinkingTimelineEvent['kind'] | null;
};
const conversationUpdates = new Map<string, Promise<unknown>>();
function serializeConversationUpdate<T>(id: string, action: () => Promise<T>): Promise<T> {
  const result = (conversationUpdates.get(id) ?? Promise.resolve()).catch(() => undefined).then(action);
  conversationUpdates.set(id, result);
  void result.finally(() => { if (conversationUpdates.get(id) === result) conversationUpdates.delete(id); }).catch(() => undefined);
  return result;
}
const activeGenerations = new Map<string, ActiveGeneration>();
const approvalBroker = new ApprovalBroker();
const autonomySessions = new AutonomySessions();
const llamaRuntime = new LlamaRuntimeController({
  stateFile: `${paths.dataRoot}/llama-cpp-runtime-state.json`,
  requestFile: `${paths.dataRoot}/llama-cpp-runtime-request.env`,
  launcherPidFile: `${paths.dataRoot}/llama-cpp-mtp-launcher.pid`,
});
const discoveredContextOptions = new Map<string, { option: ContextDiscoveryOption; modelIdentity: string }>();
let contextDiscoveryBusy = false;
let savedDiscoveryAttempted: string | null = null;
let runtimeSelectionBusy = false;
let runtimeActivation: LlamaRuntimeState['activation'];
let runtimeShuttingDown = false;
let deviceChanged = () => {};
export function onImageProcessingDeviceChanged(listener: () => void): void { deviceChanged = listener; }
const visionDevice = new VisionDeviceController({
  busy: () => runtimeShuttingDown || activeGenerations.size > 0 || contextDiscoveryBusy || runtimeSelectionBusy,
  state: () => llamaRuntime.state(),
  save: saveImageProcessingDevice,
  supportsProjector: state => {
    const profile = state.modelId ? llamaRuntimeProfile(state.modelId) : undefined;
    return Boolean(profile?.mmprojPath && (state.speculativeMode !== 'mtp' || profile.visionWithMtp !== false));
  },
  restart: async (state, device) => {
    runtimeSelectionBusy = true;
    try {
      const result = await llamaRuntime.switchTo(state.modelId!, state.contextWindow!, state.kvCacheType, state.kvOffload, device);
      await syncLlamaBackend();
      return result;
    } finally { runtimeSelectionBusy = false; }
  },
  changed: () => deviceChanged(),
});
export async function selectImageProcessingDevice(device: VisionDevice): Promise<void> {
  await visionDevice.select(device);
}
export async function imageProcessingDeviceSelection(): Promise<VisionDevice> {
  const state = await llamaRuntime.state();
  const config = effectiveRuntimeConfiguration();
  if (state.status === 'ready' && state.projectorDevice) return state.projectorDevice;
  if (visionDevice.pending) return visionDevice.pending;
  return config.imageProcessingDevice ?? (config.models.find(model => model.id === state.modelId)?.projectorDevice === 'gpu' ? 'gpu' : 'cpu');
}

let contextDiscoveryProgress: ContextDiscoveryProgress = { busy: false, modelId: null, stage: '', probeCount: 0 };
const discoveryKey = (modelId: string, contextWindow: number, kvCacheType: 'f16' | 'q8_0', kvOffload: boolean) => `${modelId}:${contextWindow}:${kvCacheType}:${kvOffload ? 'gpu' : 'ram'}`;
function currentDiscoveryHeadroomFits(option: ContextDiscoveryOption, current: RuntimeContextEstimate): boolean {
  const host = resolveContextReserve(process.env.LOCAL_AI_CONTEXT_HOST_RESERVE_BYTES, 'LOCAL_AI_CONTEXT_HOST_RESERVE_BYTES', defaultContextHostReserveBytes);
  if (host.bytes === null) throw new Error(host.error ?? 'Некорректный резерв памяти для поиска.');
  return !!current.memoryBaseline && !!current.vramBudget && !!option.vramBudget
    && option.measuredHeadroom.hostBytes + current.memoryBaseline.hostAvailableBytes - option.memoryBaseline.hostAvailableBytes >= host.bytes
    && vramBudgetStillFits(option.vramBudget, current.vramBudget);
}
/** Fresh results must stay near their measured baseline; a saved calibration only needs the live fit check below, since more free RAM is never unsafe. */
const hostBaselineStable = (option: ContextDiscoveryOption, current: RuntimeContextEstimate) =>
  option.restored || Math.abs(current.memoryBaseline!.hostAvailableBytes - option.memoryBaseline.hostAvailableBytes) <= 2 * 1024 ** 3;
async function modelFileIdentity(path: string): Promise<string> {
  return ggufArtifactFingerprint(path, true);
}
async function runtimeConfigurationIdentity(modelId: string): Promise<string> {
  const profile = llamaRuntimeProfile(modelId);
  const state = await llamaRuntime.state();
  if (!profile?.modelPath || state.status !== 'ready' || state.modelId !== modelId || !state.serverPid) throw new Error('Проверенная конфигурация llama.cpp больше не запущена.');
  const args = (await readFile(`/proc/${state.serverPid}/cmdline`, 'utf8')).split('\0').filter(Boolean);
  const stableArgs = stableRuntimeArguments(args);
  return JSON.stringify({ args: stableArgs, model: await modelFileIdentity(profile.modelPath),
    projector: profile.mmprojPath ? await modelFileIdentity(profile.mmprojPath) : null,
    ...(state.speculativeMode !== 'none' && profile.draft ? { draft: await modelFileIdentity(profile.draft.path) } : {}),
    binary: await modelFileIdentity(args[0]), hardLimit: await llamaCapabilityLimit(modelId), speculative: state.speculativeMode ?? profile.speculative });
}
/** Size and mtime survive restarts and remounts; device/inode numbers may not. */
async function persistentFileFingerprint(path: string): Promise<string> {
  return ggufArtifactFingerprint(path);
}
/** The stable configuration a saved Max Context calibration belongs to; requires the model's launcher-managed server to be running. */
async function persistentDiscoveryIdentity(modelId: string): Promise<{ key: string; serialized: string; hardLimit: number }> {
  const profile = llamaRuntimeProfile(modelId);
  const state = await llamaRuntime.state();
  if (!profile?.modelPath || state.status !== 'ready' || state.modelId !== modelId || !state.serverPid) throw new Error('Сохранённый максимальный контекст можно показать только при запущенной модели.');
  const args = (await readFile(`/proc/${state.serverPid}/cmdline`, 'utf8')).split('\0').filter(Boolean);
  const hostReserve = resolveContextReserve(process.env.LOCAL_AI_CONTEXT_HOST_RESERVE_BYTES, 'LOCAL_AI_CONTEXT_HOST_RESERVE_BYTES', defaultContextHostReserveBytes);
  if (hostReserve.bytes === null) throw new Error(hostReserve.error ?? 'Некорректный резерв памяти для поиска.');
  const hardLimit = await llamaCapabilityLimit(modelId);
  const identity = buildContextDiscoveryIdentity({
    modelId, modelFingerprint: await persistentFileFingerprint(profile.modelPath),
    projectorFingerprint: profile.mmprojPath ? await persistentFileFingerprint(profile.mmprojPath) : null,
    ...(state.speculativeMode !== 'none' && profile.draft ? { draftFingerprint: await persistentFileFingerprint(profile.draft.path) } : {}),
    runtimeFingerprint: `${args[0]}:${await persistentFileFingerprint(args[0])}`,
    arguments: args, speculative: state.speculativeMode ?? profile.speculative, hardLimit, gpu: await getGpuIdentity(), hostReserveBytes: hostReserve.bytes,
  });
  return { ...contextDiscoveryKey(identity), hardLimit };
}
/** Saved options never trigger probing; each is still checked against live memory when selected. */
async function loadSavedDiscovery(modelId: string): Promise<{ options: ContextDiscoveryOption[]; hardLimit: number; key: string } | null> {
  try {
    const identity = await persistentDiscoveryIdentity(modelId);
    return { options: database.loadContextDiscoveryOptions(identity.key, modelId, identity.hardLimit), hardLimit: identity.hardLimit, key: identity.key };
  } catch (error) {
    log('context.discovery.saved.unavailable', { modelId, message: error instanceof Error ? error.message : String(error) });
    return null;
  }
}
async function adoptSavedDiscovery(modelId: string, error?: string): Promise<void> {
  const measured = await loadSavedDiscovery(modelId);
  const hardLimit = await llamaCapabilityLimit(modelId);
  const saved = measured?.options.length ? measured : { options: database.loadLatestContextDiscoveryOptions(modelId, hardLimit), hardLimit, key: 'historical' };
  if (!saved.options.length) return;
  savedDiscoveryAttempted = modelId;
  if (!saved.options.length) return;
  const configurationId = await runtimeConfigurationIdentity(modelId);
  discoveredContextOptions.clear();
  for (const option of saved.options) discoveredContextOptions.set(discoveryKey(modelId, option.contextWindow, option.kvCacheType, option.kvOffload), { option, modelIdentity: saved.key === 'historical' ? 'unvalidated-history' : configurationId });
  contextDiscoveryProgress = { busy: false, modelId, stage: 'Сохранённый результат', probeCount: 0, error,
    result: { modelId, probeContextTokens: Math.min(16_384, saved.hardLimit), options: saved.options, unsupported: [], restored: true, hardLimit: saved.hardLimit, configurationId, measurementIdentity: saved.key } };
  log('context.discovery.saved.restored', { modelId, options: saved.options.map((option) => ({ contextWindow: option.contextWindow, kvCacheType: option.kvCacheType, kvOffload: option.kvOffload })) });
}
/** Only the live launcher's state can attest to an explicitly selected runtime. */
async function currentLlamaRuntime(): Promise<LlamaRuntimeState> {
  const state = { ...await llamaRuntime.state(), ...(runtimeActivation ? { activation: runtimeActivation } : {}) };
  if (!modelSelectedThisProcess && state.status === 'ready') return { status: 'idle', modelId: null, contextWindow: null, ...(runtimeActivation ? { activation: runtimeActivation } : {}) };
  if (state.status === 'ready') {
    // The state file records the last transition; a server that died since then must not be reported as running.
    const health = await llamaCpp.getStatus();
    if (!health.available) return { status: 'offline', modelId: null, contextWindow: null, error: `llama-server не отвечает: ${health.message ?? 'health check failed'}` };
  }
  return { ...state, ...(visionDevice.pending ? { pendingProjectorDevice: visionDevice.pending } : {}), ...(visionDevice.error ? { deviceError: visionDevice.error } : {}) };
}
async function syncLlamaBackend(): Promise<LlamaRuntimeState> {
  const state = await currentLlamaRuntime();
  if (state.status === 'ready' && state.modelId && state.contextWindow) {
    const profile = llamaRuntimeProfile(state.modelId);
    const visionEnabled = profile?.vision && (state.speculativeMode !== 'mtp' || profile.visionWithMtp !== false);
    try { llamaCpp.updateRuntimeSelection(state.modelId, state.contextWindow, state.kvCacheType ?? initialLlamaKvType, state.kvOffload ?? initialLlamaKvOffload, visionEnabled); } catch { /* an unsupported combination is reported by the launcher state itself */ }
  } else { llamaCpp.clearRuntimeSelection(); }
  return state;
}
async function estimateModelContext(modelId: string): Promise<RuntimeContextEstimate> {
  const profile = getModelProfile(modelId);
  const llamaProfile = llamaRuntimeProfile(modelId);
  const configuredMaxTokens = profile && llamaProfile ? await llamaCapabilityLimit(modelId) : undefined;
  const contextPresets = profile && llamaProfile ? llamaContextPresets(modelId) : [];
  const hardware = await getHardwareStats();
  let runtime = null;
  let vramBudget: RuntimeContextEstimate['vramBudget'];
  let runtimeArguments: string[] | undefined;
  if (configuredMaxTokens) {
    if (llamaProfile) {
      const current = await llamaRuntime.state();
      if (modelSelectedThisProcess && current.status === 'ready' && current.launcherPid !== undefined && current.modelId === modelId && current.kvCacheType && current.kvOffload !== undefined) {
        await syncLlamaBackend();
        runtime = await llamaCpp.getRuntimeContextEvidence(modelId);
        if (current.serverPid) {
          runtimeArguments = (await readFile(`/proc/${current.serverPid}/cmdline`, 'utf8')).split('\0').filter(Boolean);
          vramBudget = await getOwnedServerVramBudget(current.serverPid);
        }
      }
    }
  }
  const hostReserve = resolveContextReserve(process.env.LOCAL_AI_CONTEXT_HOST_RESERVE_BYTES, 'LOCAL_AI_CONTEXT_HOST_RESERVE_BYTES', defaultContextHostReserveBytes);
  const estimate = await collectRuntimeContextEstimate({
    backend: 'llama-cpp',
    modelId,
    configuredMaxTokens: Math.min(configuredMaxTokens ?? 0, runtime?.modelTrainContextTokens ?? Number.MAX_SAFE_INTEGER),
    contextPresets,
    hardware,
    runtime,
    startupLogPath: process.env.LOCAL_AI_LLAMA_SERVER_LOG ?? join(paths.logs, 'llama-cpp-mtp-server.log'),
    hostReserveBytes: hostReserve.bytes,
    deviceReserveBytes: vramBudget ? vramBudget.freeBytes + vramBudget.llmBytes - vramBudget.availableLlmBytes : defaultContextDeviceReserveBytes,
    reserveErrors: [hostReserve.error].filter((error): error is string => Boolean(error)),
    runtimeArguments,
  });
  if (vramBudget && estimate.allocationEvidence) {
    const loggedDeviceBytes = Object.values(estimate.allocationEvidence.allocations).reduce((sum, allocation) => sum + (allocation.device ?? 0), 0);
    vramBudget = { ...vramBudget, loggedDeviceBytes, unloggedDeviceBytes: vramBudget.llmBytes - loggedDeviceBytes };
  }
  return { ...estimate, vramBudget, memoryHeadroom: estimate.memoryHeadroom && vramBudget
    ? { ...estimate.memoryHeadroom, deviceBytes: vramBudget.freeBytes } : estimate.memoryHeadroom };
}
async function discoverModelContexts(modelId: string): Promise<ContextDiscoveryResult> {
  const profile = llamaRuntimeProfile(modelId);
  if (contextDiscoveryBusy) throw new Error('Поиск максимального контекста уже выполняется.');
  if (runtimeSelectionBusy) throw new Error('Дождитесь завершения переключения runtime.');
  if (!profile) throw new Error('Для поиска максимального контекста нужна установленная модель llama.cpp.');
  contextDiscoveryBusy = true;
  const previousProgress = contextDiscoveryProgress.modelId === modelId ? contextDiscoveryProgress : { busy: false, modelId, stage: '', probeCount: 0 };
  contextDiscoveryProgress = { ...previousProgress, busy: true, error: undefined, stage: 'Подготовка; llama.cpp будет перезапущен несколько раз…', probeCount: 0 };
  let original: LlamaRuntimeState | null = null;
  try {
    if (activeGenerations.size) throw new Error('Остановите генерацию перед измерением Max Context.');
    original = await llamaRuntime.state();
    if (original.status !== 'ready' || original.launcherPid === undefined || !original.serverPid || !original.modelId || original.contextWindow === null || !original.kvCacheType || original.kvOffload === undefined) {
      throw new Error('Для безопасного discovery требуется работающий launcher-managed llama.cpp runtime с подтверждёнными KV-настройками.');
    }
    if (original.modelId !== modelId) throw new Error('Выберите и загрузите модель перед Max Context discovery.');
    const prior = original;
    const offload = original.kvOffload;
    const configurationId = await runtimeConfigurationIdentity(modelId);
    const hardLimit = await llamaCapabilityLimit(modelId);
    const initialEstimate = await estimateModelContext(modelId);
    const baseHeadroom = predictContextHeadroom([initialEstimate], Math.min(16_384, hardLimit));
    if (initialEstimate.status !== 'estimated' || !initialEstimate.memoryBaseline || !baseHeadroom || !initialEstimate.observedContextTokens || !initialEstimate.allocationEvidence) throw new Error('Нет полной allocation evidence для безопасного базового запуска.');
    const precisionExpansion = initialEstimate.activeKvCacheType === 'q8_0'
      ? Object.values(initialEstimate.allocationEvidence.allocations.kv).reduce((sum, value) => sum + (value ?? 0), 0)
        + Object.values(initialEstimate.allocationEvidence.allocations.speculativeKv).reduce((sum, value) => sum + (value ?? 0), 0)
      : 0;
    if (baseHeadroom.deviceBytes - (offload ? precisionExpansion : 0) < vramProbeGuardBytes
      || baseHeadroom.hostBytes - (offload ? 0 : precisionExpansion) < 4.25 * 1024 ** 3) throw new Error('Недостаточно свежей свободной памяти для безопасного базового FP16 probe.');
    const hostReserve = resolveContextReserve(process.env.LOCAL_AI_CONTEXT_HOST_RESERVE_BYTES, 'LOCAL_AI_CONTEXT_HOST_RESERVE_BYTES', defaultContextHostReserveBytes);
    if (hostReserve.bytes === null) throw new Error(hostReserve.error);
    const result = await discoverContextBoundary({
      modelId, hardLimit, kvOffload: offload, hostReserveBytes: hostReserve.bytes, deviceReserveBytes: 0,
      progress: (stage, probeCount) => { contextDiscoveryProgress = { ...contextDiscoveryProgress, busy: true, modelId, stage, probeCount }; },
      probe: async (contextWindow, kvCacheType, phase): Promise<DiscoveryProbe> => {
        const started = Date.now();
        const record: DiscoveryProbe['record'] = { contextWindow, kvCacheType, phase, startup: false, health: false, inference: false, fits: false, headroom: null, memoryBaseline: null, elapsedMs: 0 };
        let estimate: RuntimeContextEstimate | null = null;
        try {
          const switched = await llamaRuntime.switchTo(modelId, contextWindow, kvCacheType, offload);
          if (!switched.ok) {
            if (switched.state.status !== 'ready') throw new Error(`Не удалось вернуть исходную конфигурацию llama.cpp после проверки: ${switched.error}`);
            record.reason = switched.error;
            return { record, estimate };
          }
          record.startup = true;
          const state = await syncLlamaBackend();
          if (state.status !== 'ready' || !state.serverPid) throw new Error('Пробный сервер llama.cpp не запущен или не отвечает.');
          process.kill(state.serverPid, 0);
          record.args = (await readFile(`/proc/${state.serverPid}/cmdline`, 'utf8')).split('\0').filter(Boolean);
          record.health = (await llamaCpp.getStatus()).available;
          if (!record.health) throw new Error('Пробный сервер llama.cpp не прошёл проверку состояния.');
          await verifyContextProbeInference(modelId);
          record.inference = true;
          process.kill(state.serverPid, 0);
          estimate = await estimateModelContext(modelId);
          record.headroom = estimate.memoryHeadroom;
          record.memoryBaseline = estimate.memoryBaseline;
          record.vramBudget = estimate.vramBudget;
          record.hardware = await getHardwareStats();
          if (estimate.status !== 'estimated') record.reason = estimate.unknownReasons.join('; ');
          return { record, estimate };
        } catch (error) {
          record.reason = error instanceof Error ? error.message : String(error);
          if ((await llamaRuntime.state()).status !== 'ready') throw error;
          return { record, estimate };
        } finally {
          record.elapsedMs = Date.now() - started;
          log('context.discovery.probe', record);
        }
      },
      restore: async () => {
        const restore = await llamaRuntime.switchTo(prior.modelId!, prior.contextWindow!, prior.kvCacheType!, prior.kvOffload!);
        if (!restore.ok) throw new Error(`Поиск максимального контекста не смог восстановить прежнюю конфигурацию llama.cpp: ${restore.error}`);
        await syncLlamaBackend();
      },
    });
    // Identity excludes context/cache mode, so choosing an option does not
    // invalidate the sibling mode. Model/draft/projector/backend args do.
    result.configurationId = await runtimeConfigurationIdentity(modelId);
    if (result.configurationId !== configurationId) throw new Error('Конфигурация llama.cpp (модель, режим или draft) изменилась во время поиска.');
    // Only a completed discovery reaches here; its options replace the saved value for their KV mode.
    // A KV mode this run did not establish keeps its last successful saved value.
    let saved: ContextDiscoveryOption[] = [];
    try {
      const identity = await persistentDiscoveryIdentity(modelId);
      result.measurementIdentity = identity.key;
      database.saveContextDiscoveryOptions(identity.key, identity.serialized, result.options);
      result.options = result.options.map(option => ({ ...option, conditions: 'comparable', validation: 'confirmed', conditionWarning: undefined }));
      saved = database.loadContextDiscoveryOptions(identity.key, modelId, identity.hardLimit);
      log('context.discovery.saved', { modelId, options: result.options.map((option) => ({ contextWindow: option.contextWindow, kvCacheType: option.kvCacheType })) });
    } catch (error) {
      result.persistenceError = error instanceof Error ? error.message : String(error);
      log('context.discovery.save.failed', { modelId, message: result.persistenceError });
    }
    result.options = mergeSavedDiscoveryOptions(result.options, saved);
    discoveredContextOptions.clear();
    for (const option of result.options) discoveredContextOptions.set(discoveryKey(modelId, option.contextWindow, option.kvCacheType, option.kvOffload), { option, modelIdentity: result.configurationId });
    savedDiscoveryAttempted = modelId;
    contextDiscoveryProgress = { busy: false, modelId, stage: 'Готово', probeCount: result.probes?.length ?? 0, result, error: result.persistenceError };
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    contextDiscoveryProgress = { ...previousProgress, busy: false, modelId, stage: 'Поиск не завершён', probeCount: contextDiscoveryProgress.probeCount, error: message };
    // A failed or interrupted run leaves the previously saved result untouched and selectable.
    await adoptSavedDiscovery(modelId, message).catch(() => undefined);
    throw error;
  } finally {
    contextDiscoveryBusy = false;
    void visionDevice.flush();
  }
}
async function verifyContextProbeInference(modelId: string): Promise<void> {
  const url = process.env.LOCAL_AI_LLAMA_CPP_URL ?? 'http://127.0.0.1:8081';
  const response = await fetch(`${url.replace(/\/$/, '')}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: modelId, messages: [{ role: 'user', content: 'What is 1 + 1? Reply with exactly 2 and no explanation.' }], max_tokens: 128, temperature: 0, chat_template_kwargs: { enable_thinking: false }, stream: false }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new Error(`Пробный запрос к модели завершился ошибкой HTTP ${response.status}.`);
  const value = await response.json() as { choices?: Array<{ message?: { content?: unknown; reasoning_content?: unknown } }> };
  if (!Array.isArray(value.choices) || !value.choices.length
    || !(typeof value.choices[0]?.message?.content === 'string' && value.choices[0].message.content.trim())) {
    throw new Error('Пробный запрос к модели не вернул завершённый ответ.');
  }
}
async function assessDiscoveredOption(modelId: string, contextWindow: number, kvCacheType: 'f16' | 'q8_0', kvOffload: boolean): Promise<void> {
  if (!discoveredContextOptions.size && !contextDiscoveryBusy) await adoptSavedDiscovery(modelId).catch(() => undefined);
  let cachedOptions = [...discoveredContextOptions.values()];
  let option = findFreshContextDiscoveryOption(cachedOptions.map((item) => item.option), { modelId, contextWindow, kvCacheType, kvOffload });
  if (!option) {
    await adoptSavedDiscovery(modelId);
    cachedOptions = [...discoveredContextOptions.values()];
    option = findFreshContextDiscoveryOption(cachedOptions.map((item) => item.option), { modelId, contextWindow, kvCacheType, kvOffload });
  }
  if (!option) throw new Error('Нет подходящего предыдущего измерения для этой пары контекст/KV. Новый поиск необязателен.');
  const cached = cachedOptions.find((item) => item.option === option);
  if (!cached || await runtimeConfigurationIdentity(modelId) !== cached.modelIdentity) throw new Error('Конфигурация llama.cpp изменилась с момента предыдущего измерения.');
  const current = await estimateModelContext(modelId);
  if (current.status !== 'estimated' || !current.memoryBaseline || current.observedContextTokens === null) throw new Error('Нет полного измерения текущей памяти llama.cpp.');
  if (!hostBaselineStable(option, current) || !currentDiscoveryHeadroomFits(option, current)) {
    const gib = (value?: number) => value === undefined ? '?' : (value / 1024 ** 3).toFixed(2);
    const details = `RAM baseline: сохранено ${gib(option.memoryBaseline.hostAvailableBytes)} GiB, сейчас ${gib(current.memoryBaseline.hostAvailableBytes)} GiB; VRAM модели: требуется ${gib(option.vramBudget?.llmBytes)} GiB, доступно ${gib(current.vramBudget?.availableLlmBytes)} GiB; фон VRAM: сохранено ${gib(option.vramBudget?.nonLlmBytes)} GiB, сейчас ${gib(current.vramBudget?.nonLlmBytes)} GiB.`;
    log('context.activation.memory.changed', { modelId, contextWindow, kvCacheType, kvOffload, hostStable: hostBaselineStable(option, current), option: { memoryBaseline: option.memoryBaseline, measuredHeadroom: option.measuredHeadroom, vramBudget: option.vramBudget }, current: { memoryBaseline: current.memoryBaseline, vramBudget: current.vramBudget } });
    throw new Error(`Доступная память не подтверждает сохранённую конфигурацию ${contextWindow / 1024}K ${kvCacheType}. ${details} Можно загрузить выбранную конфигурацию, повторить поиск или выбрать меньший контекст.`);
  }
}
/** Catalog visibility is independent of permission to activate a profile. */
const discoveryConditions = new DiscoveryConditionTracker();
const discoveryStatusRequests = new Map<string, Promise<ContextDiscoveryProgress>>();
function discoveryStatus(_event?: unknown, requestedModelId?: string): Promise<ContextDiscoveryProgress> {
  if (!requestedModelId) return Promise.resolve(contextDiscoveryProgress);
  const pending = discoveryStatusRequests.get(requestedModelId);
  if (pending) return pending;
  const request = assessDiscoveryStatus(requestedModelId).finally(() => discoveryStatusRequests.delete(requestedModelId));
  discoveryStatusRequests.set(requestedModelId, request);
  return request;
}
async function assessDiscoveryStatus(requestedModelId: string): Promise<ContextDiscoveryProgress> {
  // Inference activity is not invalidation of a measurement. Keep the last
  // assessment while busy; re-evaluate real identity/memory conditions afterward.
  if (contextDiscoveryBusy || runtimeSelectionBusy || activeGenerations.size) return contextDiscoveryProgress;
  const state = await currentLlamaRuntime();
  if (state.status !== 'ready' || state.modelId !== requestedModelId) {
    const hardLimit = await llamaCapabilityLimit(requestedModelId);
    const options = database.loadLatestContextDiscoveryOptions(requestedModelId, hardLimit);
    return { busy: false, modelId: requestedModelId, stage: 'Сохранённый результат', probeCount: 0,
      ...(options.length ? { result: { modelId: requestedModelId, probeContextTokens: Math.min(16384, hardLimit), options, unsupported: [], restored: true, pendingValidation: true, hardLimit } } : {}) };
  }
  if (savedDiscoveryAttempted !== requestedModelId || contextDiscoveryProgress.modelId !== requestedModelId || !contextDiscoveryProgress.result) {
    await adoptSavedDiscovery(requestedModelId, contextDiscoveryProgress.modelId === requestedModelId ? contextDiscoveryProgress.error : undefined);
  }
  const result = contextDiscoveryProgress.result;
  if (!result || result.modelId !== requestedModelId) return { busy: false, modelId: requestedModelId, stage: '', probeCount: 0 };
  const assessmentKey = (option: ContextDiscoveryOption) => JSON.stringify([result.configurationId, result.measurementIdentity,
    option.modelId, option.discoveredAt, option.contextWindow, option.kvCacheType, option.kvOffload]);
  const annotate = (option: ContextDiscoveryOption, conditions: ContextDiscoveryOption['conditions'], sample?: ReturnType<typeof discoveryConditionSample>) => ({ ...option, conditions,
    validation: conditions === 'comparable' ? (option.restored ? 'previous' as const : 'confirmed' as const) : conditions === 'changed' ? 'revalidation' as const : 'previous' as const,
    conditionWarning: conditions !== 'changed' ? undefined : sample === 'identity-changed' ? 'Идентичность модели или конфигурация runtime изменилась после измерения.'
      : sample === 'unsafe' ? 'Текущего запаса GPU/RAM недостаточно для подтверждённого профиля.'
      : 'Доступная память GPU/RAM устойчиво отличается от условий измерения. Рекомендуется повторная проверка.' });
  let sameIdentity = false;
  let identityConfirmed = false;
  try {
    const runtimeIdentity = await runtimeConfigurationIdentity(requestedModelId);
    const measurementIdentity = await persistentDiscoveryIdentity(requestedModelId);
    sameIdentity = result.configurationId === runtimeIdentity && result.measurementIdentity === measurementIdentity.key;
    identityConfirmed = true;
    const estimate = await estimateModelContext(requestedModelId);
    const hostReserve = resolveContextReserve(process.env.LOCAL_AI_CONTEXT_HOST_RESERVE_BYTES, 'LOCAL_AI_CONTEXT_HOST_RESERVE_BYTES', defaultContextHostReserveBytes);
    if (hostReserve.bytes === null) throw new Error(hostReserve.error ?? 'Некорректный резерв памяти для поиска.');
    const options = result.options.map(option => {
      const sample = discoveryConditionSample(option, estimate, sameIdentity, hostReserve.bytes!);
      return annotate(option, discoveryConditions.assess(assessmentKey(option), sample), sample);
    });
    if (contextDiscoveryProgress.result === result && !contextDiscoveryBusy && !runtimeSelectionBusy) {
      contextDiscoveryProgress = { ...contextDiscoveryProgress, currentVramBudget: estimate.vramBudget, result: { ...result, options } };
    }
  } catch (error) {
    if (contextDiscoveryProgress.result === result && !contextDiscoveryBusy && !runtimeSelectionBusy) {
      const options = result.options.map(option => annotate(option, discoveryConditions.assess(assessmentKey(option), sameIdentity ? 'missing' : identityConfirmed ? 'identity-changed' : 'unknown')));
      // Sampling errors are not failed discovery runs. Never fabricate current telemetry.
      contextDiscoveryProgress = { ...contextDiscoveryProgress, currentVramBudget: undefined, result: { ...result, options } };
      log('context.discovery.telemetry.unavailable', { modelId: requestedModelId, message: error instanceof Error ? error.message : String(error) });
    }
  }
  return contextDiscoveryProgress;
}

const waitFor = (promise: Promise<void>, timeoutMs: number): Promise<void> => new Promise((resolve) => {
  const timeout = setTimeout(resolve, timeoutMs);
  timeout.unref();
  void promise.then(() => { clearTimeout(timeout); resolve(); }, () => { clearTimeout(timeout); resolve(); });
});

/** Called by Electron's main lifecycle before process exit, never by a renderer. */
export async function shutdownRuntime(): Promise<void> {
  runtimeShuttingDown = true;
  const active = [...activeGenerations.values()];
  log('runtime.shutdown.started', { backend: 'llama-cpp', activeGenerations: active.length });
  for (const generation of active) generation.abort.abort();
  await Promise.allSettled(active.map((generation) => waitFor(generation.settled, 4_000)));
  log('runtime.shutdown.finished', { backend: 'llama-cpp' });
}

async function cancelGeneration(conversationId: string, generationId?: string, reason: 'user_stop' | 'superseded' = 'superseded'): Promise<void> {
  const active = activeGenerations.get(conversationId);
  if (!active || (generationId && active.id !== generationId)) return;
  log('generation.cancelled', { conversationId, generationId: active.id, reason });
  active.abort.abort(); await active.settled;
}

export function registerIpc(): void {
  const diagramValidation = new DiagramValidationBridge();
  ipcMain.handle('chat:diagram-validation-result', (event, id: unknown, error: unknown) => diagramValidation.reply(event.sender.id, id, error));
  const interruptedRuns = database.recoverInterruptedRuns();
  if (interruptedRuns) log('generation.interrupted-recovered', { runs: interruptedRuns });
  ipcMain.handle('conversations:list', () => database.listConversations());
  ipcMain.handle('conversations:create', async (_event, requestedModelId?: string) => {
    const modelId = requestedModelId ?? (await currentLlamaRuntime()).modelId ?? null;
    if (modelId && !getModelProfile(modelId)) throw new Error('Выбранная модель отсутствует в реестре приложения');
    return database.createConversation(modelId);
  });
  ipcMain.handle('conversations:update', async (_event, id: string, patch: Partial<Pick<Conversation, 'title' | 'modelId' | 'mode' | 'workingDirectory' | 'secondaryWorkingDirectory' | 'contextWindow' | 'llamaKvCacheType' | 'llamaKvOffload' | 'reasoningMode' | 'thinkingEnabled' | 'reasoningEffort' | 'webMode'>>) => serializeConversationUpdate(id, async () => {
    // Reasoning/mode/web/project/title changes never touch llama.cpp, so they must not queue behind
    // (or be refused by) a runtime switch: a refusal made the UI roll the user's choice back.
    if (!touchesRuntime(patch)) {
      const existing = database.getConversation(id);
      if (!existing) throw new Error('Чат не найден');
      const reasoningError = reasoningPatchError(patch, reasoningCapability(llamaRuntimeProfile(existing.modelId ?? '')));
      if (reasoningError) throw new Error(reasoningError);
      const capability = reasoningCapability(llamaRuntimeProfile(existing.modelId ?? ''));
      const pinned = pinLegacyReasoning(existing, capability, patch);
      const active = activeGenerations.get(id);
      if (activeGenerations.size && Object.keys(patch).some(key => key !== 'title')) {
        const next = { ...existing, ...pinned };
        const unchangedThinking = pinned.thinkingEnabled === undefined || pinned.thinkingEnabled === resolveReasoningSelection(capability, existing.reasoningMode, existing).thinking;
        if (!active || !rustAgent.hasRun(active.id) || existing.mode !== 'agent' || !unchangedThinking || Object.keys(pinned).some(key => !['title', 'reasoningMode', 'reasoningEffort', 'thinkingEnabled'].includes(key))) throw new Error('Дождитесь завершения ответа или остановите задачу.');
        const selection = resolveReasoningSelection(capability, next.reasoningMode, next);
        await rustAgent.control(active.id, { reasoning: { mode: next.reasoningMode, options: agentReasoningOptions(existing.modelId ?? '', selection) ?? {}, selection: { mode: 'agent', reasoningMode: next.reasoningMode === 'deep' ? 'deep' : 'fast', reasoningEffort: selection.effort, thinkingEnabled: selection.thinking } } });
      }
      if (patch.webMode === 'off' || patch.workingDirectory !== undefined || patch.secondaryWorkingDirectory !== undefined) await liveBrowsers.closeConversation(_event.sender, id);
      const stored = database.updateConversation(id, pinned);
      if ((patch.workingDirectory !== undefined && patch.workingDirectory !== existing.workingDirectory) || (patch.secondaryWorkingDirectory !== undefined && patch.secondaryWorkingDirectory !== existing.secondaryWorkingDirectory)) { approvalBroker.revoke(id); }
      return database.getConversation(id) ?? stored;
    }
    if (contextDiscoveryBusy) throw new Error('Дождитесь завершения Max Context discovery перед изменением настроек runtime.');
    if (runtimeSelectionBusy) throw new Error('Дождитесь завершения переключения runtime.');
    runtimeSelectionBusy = true;
    try {
    if (activeGenerations.size && Object.keys(patch).some((key) => key !== 'title')) throw new Error('Дождитесь завершения активной генерации перед изменением настроек.');
    const current = database.getConversation(id);
    if (!current) throw new Error('Чат не найден');
    const runtime = await syncLlamaBackend();
    if (!patch.modelId && !activeConversationModel(current, runtime)) throw new Error('Выберите модель перед изменением настроек runtime.');
    const nextModelId = patch.modelId ?? current.modelId;
    const profile = nextModelId ? getModelProfile(nextModelId) : undefined;
    if (nextModelId && !profile) throw new Error('Выбранная модель отсутствует в реестре приложения');
    const capability = profile ? await llamaCapabilityLimit(nextModelId ?? '') : 0;
    const allowed = profile ? llamaContextPresets(nextModelId ?? '', capability) : [];
    const requestedContext = patch.contextWindow ?? current.contextWindow;
    const modelChanged = nextModelId !== current.modelId;
    const firstSelection = patch.modelId !== undefined && !activeConversationModel(current, runtime);
    const runtimeConfig = effectiveRuntimeConfiguration();
    const normalConfiguration = llamaRuntimeProfile(nextModelId ?? '')?.normalContext;
    const initial = initialModelContext(allowed, normalConfiguration);
    const contextWindow = (modelChanged && (firstSelection || normalConfiguration)) && patch.contextWindow === undefined ? initial.contextWindow : modelChanged && patch.contextWindow === undefined && allowed.length ? normalContextForModel(requestedContext, allowed) : requestedContext;
    if (profile) {
      if (!Number.isSafeInteger(contextWindow) || contextWindow % 4_096 !== 0 || contextWindow > Math.min(capability, 262144) || contextWindow <= 0) {
        throw new Error(`Запрошенный контекст ${contextWindow} выходит за пределы возможностей модели и llama.cpp или не кратен допустимому шагу.`);
      }
    }
    if (nextModelId && profile) {
      const isRuntimeRequest = patch.modelId !== undefined || patch.contextWindow !== undefined || patch.llamaKvCacheType !== undefined || patch.llamaKvOffload !== undefined;
      const { llamaKvCacheType: kvCacheType, llamaKvOffload: kvOffload } = resolveLlamaKvSelection(current, patch, modelChanged, initial);
      if (!['f16', 'q8_0'].includes(kvCacheType)) throw new Error('Неподдерживаемый тип KV-cache.');
      if (isRuntimeRequest && runtimeConfig.browserVision === 'on') {
        const visionProfile = llamaRuntimeProfile(nextModelId ?? '');
        if (!visionProfile?.vision || !visionProfile.mmprojPath) {
          throw new Error(t('Browser Vision включён, но у выбранной модели нет совместимого локального projector. Выберите модель с поддержкой изображений и projector.'));
        }
        const modelConfig = runtimeConfig.models.find(model => model.id === nextModelId);
        const requestedMtp = modelConfig?.mtpMode ?? (modelConfig?.speculative === 'none' ? 'off' : 'auto');
        const effectiveMtp = await resolveMtpMode(requestedMtp, modelConfig?.modelPath ?? visionProfile.modelPath ?? '', runtimeConfig.llamaServerPath);
        if (effectiveMtp === 'mtp' && visionProfile.visionWithMtp === false) {
          throw new Error(t('Выбранная модель несовместима с Browser Vision при включённом MTP. Измените настройки модели; MTP автоматически не отключён.'));
        }
      }
      runtimeActivation = { conversationId: id, modelId: nextModelId, contextWindow, kvCacheType, kvOffload, phase: 'validating' };
      log('context.activation.requested', runtimeActivation);
      // Discovery is a recommendation, not authorization to load a configuration.
      // This explicit renderer action is the sole trigger for a runtime switch.
      if (isRuntimeRequest) {
        try { await assessDiscoveredOption(nextModelId, contextWindow, kvCacheType, kvOffload); }
        catch (error) {
          runtimeActivation.warning = `Условия измерения не подтверждены; выбранная конфигурация может потребовать больше памяти или не загрузиться. ${error instanceof Error ? error.message : String(error)}`;
          log('context.activation.warning', { ...runtimeActivation });
        }
      }
      patch = { ...patch, llamaKvCacheType: kvCacheType, llamaKvOffload: kvOffload };
      const runtimeDiffers = runtime.status !== 'ready' || runtime.modelId !== nextModelId || runtime.contextWindow !== contextWindow || runtime.kvCacheType !== kvCacheType || runtime.kvOffload !== kvOffload;
      // Re-selecting the stored model is a retry when the server is not running it.
      if (runtimeDiffers && (patch.modelId !== undefined || patch.contextWindow !== undefined || patch.llamaKvCacheType !== undefined || patch.llamaKvOffload !== undefined)) {
        if (activeGenerations.size > 0) throw new Error('Нельзя переключать llama.cpp во время генерации: остановите её или дождитесь завершения.');
        log('llama.runtime.switch.requested', { conversationId: id, from: runtime, to: { modelId: nextModelId, contextWindow, kvCacheType, kvOffload } });
        const result = await llamaRuntime.switchTo(nextModelId, contextWindow, kvCacheType, kvOffload);
        if (result.ok) modelSelectedThisProcess = true;
        await syncLlamaBackend();
        log('llama.runtime.switch.finished', { conversationId: id, ok: result.ok, state: result.state, error: result.ok ? undefined : result.error });
        if (result.ok && runtimeConfig.browserVision === 'on' && !await liveMultimodal(`${llamaCppUrl}/v1/chat/completions`).catch(() => false)) {
          if (runtime.status === 'ready' && runtime.modelId && runtime.contextWindow) {
            const rollback = await llamaRuntime.switchTo(runtime.modelId, runtime.contextWindow, runtime.kvCacheType ?? 'f16', runtime.kvOffload ?? true, runtime.projectorDevice, runtime.mtpMode);
            await syncLlamaBackend();
            log('browser.vision.load.rollback', { conversationId: id, ok: rollback.ok, restoredModelId: rollback.ok ? runtime.modelId : rollback.state.modelId });
          }
          throw new Error(t('После загрузки llama-server не подтвердил поддержку изображений. Запрошенный выбор чата не применён; Browser Vision остаётся ожидающей проверку.'));
        }
        // A failed switch preserves the requested conversation configuration.
        // The runtime separately reports the active/rolled-back configuration.
        if (!result.ok) throw new Error(`Не удалось переключить llama.cpp на ${profile.displayName} (${Math.round(contextWindow / 1024)}K, ${kvCacheType}, KV ${kvOffload ? 'GPU' : 'RAM'}): ${result.error}${result.state.rolledBack ? ` Продолжает работать ${result.state.modelId}.` : result.state.status === 'offline' ? ' llama.cpp сейчас не запущен.' : ''}`);
      }
      if (modelChanged) {
        discoveredContextOptions.clear();
        savedDiscoveryAttempted = null;
        contextDiscoveryProgress = { busy: false, modelId: nextModelId, stage: '', probeCount: 0 };
      }
    }
    const updated = database.updateConversation(id, { ...patch, contextWindow });
    if ((patch.workingDirectory !== undefined && patch.workingDirectory !== current.workingDirectory) || (patch.secondaryWorkingDirectory !== undefined && patch.secondaryWorkingDirectory !== current.secondaryWorkingDirectory)) { approvalBroker.revoke(id); }
    if (patch.modelId !== undefined && patch.modelId !== current.modelId) database.setContextUsage(id, null, null);
    runtimeActivation = undefined;
    return database.getConversation(id) ?? updated;
    } catch (error) {
      if (runtimeActivation?.conversationId === id && runtimeActivation.phase === 'validating') {
        const actual = await llamaRuntime.state();
        const reason = error instanceof Error ? error.message : String(error);
        const message = `Не загружено: ${runtimeActivation.contextWindow / 1024}K ${runtimeActivation.kvCacheType}, KV ${runtimeActivation.kvOffload ? 'GPU' : 'RAM'}. ${reason} Активно: ${actual.status === 'ready' ? `${(actual.contextWindow ?? 0) / 1024}K ${actual.kvCacheType ?? '?'}, KV ${actual.kvOffload ? 'GPU' : 'RAM'}` : actual.status}.`;
        database.updateConversation(id, { modelId: runtimeActivation.modelId, contextWindow: runtimeActivation.contextWindow, llamaKvCacheType: runtimeActivation.kvCacheType, llamaKvOffload: runtimeActivation.kvOffload });
        runtimeActivation = { ...runtimeActivation, phase: 'failed', error: message };
        log('context.activation.failed', { requested: runtimeActivation, actual, reason });
        throw new Error(message);
      }
      throw error;
    } finally {
      runtimeSelectionBusy = false;
      deviceChanged();
      void visionDevice.flush();
    }
  }));
  ipcMain.handle('conversations:delete', async (_event, id: string) => {
    if (activeGenerations.has(id)) throw new Error('Нельзя удалить чат с активной генерацией.');
    await liveBrowsers.closeConversation(_event.sender, id);
    approvalBroker.revoke(id); await attachments.removeManagedFiles(database.deleteConversation(id));
    await discardAgentEvidence(paths.userData, id, true);
  });
  ipcMain.handle('messages:list', (_event, conversationId: string) => database.listMessages(conversationId));
  ipcMain.handle('agent-plan:legacy', (_event, conversationId: string) => database.getLegacyAgentPlan(conversationId));
  ipcMain.handle('agent-tasks:list', (_event, conversationId: string, includeTaskId?: string) => database.listAgentTasks(conversationId, includeTaskId));
  ipcMain.handle('agent-plan:get', (_event, conversationId: string) => database.getAgentPlan(conversationId));
  ipcMain.handle('messages:edit', async (_event, messageId: string, content: string, fallback?: { conversationId: string; content: string }) => {
    if (activeGenerations.size) throw new Error('Дождитесь завершения активной генерации перед редактированием.');
    const message = database.getMessage(messageId) ?? (fallback ? database.findUserMessage(fallback.conversationId, fallback.content) : null); if (!message) throw new Error('Сообщение не найдено');
    const before = database.listAttachmentsForConversation(message.conversationId);
    await cancelGeneration(message.conversationId); const edited = database.editUserMessageAndTruncate(message.id, content);
    await archiveAgentEvidence(paths.userData, message.conversationId, message.logicalTaskId);
    const kept = new Set(database.listAttachmentsForConversation(message.conversationId).map((attachment) => attachment.id));
    await attachments.removeManagedFiles(before.filter((attachment) => !kept.has(attachment.id)));
    return edited;
  });
  ipcMain.handle('messages:regenerate', async (_event, messageId: string) => {
    if (activeGenerations.size) throw new Error('Дождитесь завершения активной генерации перед повторной генерацией.');
    const message = database.getMessage(messageId); if (!message) throw new Error('Сообщение не найдено');
    const before = database.listAttachmentsForConversation(message.conversationId);
    await cancelGeneration(message.conversationId);
    const retained = database.regenerateUserMessageAndTruncate(message.id);
    await archiveAgentEvidence(paths.userData, message.conversationId, message.logicalTaskId);
    const kept = new Set(database.listAttachmentsForConversation(message.conversationId).map((attachment) => attachment.id));
    await attachments.removeManagedFiles(before.filter((attachment) => !kept.has(attachment.id)));
    return retained;
  });
  ipcMain.handle('projects:search', async (_event, conversationId: string, query: string): Promise<ProjectSuggestion[]> => {
    const conversation = database.getConversation(conversationId);
    if (!conversation?.workingDirectory || typeof query !== 'string') return [];
    const projects = [
      { id: conversation.primaryProjectId, slot: 1 as const, root: conversation.workingDirectory, label: `Project 1 (${projectDirectoryName(conversation.workingDirectory)})` },
      ...(conversation.secondaryWorkingDirectory && conversation.secondaryProjectId ? [{ id: conversation.secondaryProjectId, slot: 2 as const, root: conversation.secondaryWorkingDirectory, label: `Project 2 (${projectDirectoryName(conversation.secondaryWorkingDirectory)})` }] : []),
    ].filter((project): project is { id: string; slot: 1 | 2; root: string; label: string } => Boolean(project.id));
    const groups = await Promise.all(projects.map(async (project) => (await ReadonlyProjectTools.findResources(project.root, query.trim(), 30)).map((resource): ProjectSuggestion => ({ id: randomUUID(), projectId: project.id, projectSlot: project.slot, projectPath: project.root, projectLabel: project.label, relativePath: resource.relativePath, kind: resource.kind }))));
    return groups.flat();
  });
  ipcMain.handle('attachments:import', (_event, input) => attachments.import(input));
  ipcMain.handle('attachments:list', (_event, messageId: string) => database.listAttachments(messageId));
  ipcMain.handle('attachments:dataUrl', async (_event, id: string) => {
    const attachment = database.getAttachment(id); if (!attachment || attachment.kind !== 'image') return null;
    const data = await readFile(attachment.storageRef); return `data:${imageMimeType(attachment.filename)};base64,${data.toString('base64')}`;
  });
  ipcMain.handle('web-images:load', async (_event, url: string) => {
    if (typeof url !== 'string' || url.length > 2_000) throw new Error(t('Некорректный URL изображения.'));
    return remoteImages.load(url);
  });
  ipcMain.handle('web-images:open-source', async (_event, url: string) => {
    if (typeof url !== 'string' || url.length > 2_000) throw new Error(t('Некорректный URL источника.'));
    const safe = await remoteImages.validateSource(url);
    await shell.openExternal(safe);
  });
  ipcMain.handle('analysis:list', (_event, conversationId: string) => database.listAnalysisRuns(conversationId));
  ipcMain.handle('models:list', async () => {
    try { await syncLlamaBackend(); return await backend.getModels(); }
    catch (error) { log('backend.models.failed', { backend: 'llama-cpp', message: error instanceof Error ? error.message : String(error) }); return []; }
  });
  // The toolbar polls only live process health. Model paths and GGUF metadata
  // are checked on initialization and when model settings are opened/saved.
  const mtpStatus = async (modelId: string): Promise<MtpStatus> => {
    const config = effectiveRuntimeConfiguration(); const model = config.models.find(model => model.id === modelId);
    if (!model) throw new Error(t('Неизвестная модель.'));
    const capability = await mtpCapability(model.modelPath, config.llamaServerPath);
    const state = await currentLlamaRuntime();
    const requested = model.mtpMode ?? (model.speculative === 'none' ? 'off' : 'auto');
    const active = state.status === 'ready' && state.modelId === modelId;
    const effective = active && state.speculativeMode === 'mtp' ? 'active' : active && state.mtpFallbackReason ? 'error' : requested === 'off' ? 'disabled' : !capability.supported ? capability.status === 'requires-weights' ? 'requires-weights' : capability.status === 'error' ? 'error' : 'unsupported' : 'reload-required';
    let diagnostics;
    if (active && state.speculativeMode === 'mtp') {
      try { const response = await fetch(`${llamaCppUrl.replace(/\/$/, '')}/metrics`, { signal: AbortSignal.timeout(1500) }); if (response.ok) diagnostics = parseMtpMetrics((await response.text()).slice(0, 128 * 1024)); } catch { /* Unavailable is not a fabricated zero. */ }
    }
    return { modelId, requested, effective, capability, ...(active && state.mtpMode ? { activeMode: state.mtpMode } : {}), ...(diagnostics ? { diagnostics } : {}), ...(state.mtpFallbackReason ? { error: state.mtpFallbackReason } : {}) };
  };
  ipcMain.handle('browser-qa:status', async () => {
    const config = effectiveRuntimeConfiguration();
    const available = await liveMultimodal(`${llamaCppUrl}/v1/chat/completions`).catch(() => false);
    const runtime = await currentLlamaRuntime();
    const mode = config.browserVision ?? 'off';
    const pending = mode === 'on' && !available && runtime.status !== 'ready';
    const reason = available ? t('Загруженная модель принимает изображения. Для анализа страниц также требуется разрешение на браузер.')
      : pending ? t('После загрузки совместимой модели Browser Vision сможет анализировать изображения. Нужен локальный projector.')
        : runtime.status === 'ready' ? t('Загруженная модель не подтвердила поддержку изображений. Проверьте совместимость модели и наличие локального projector.')
          : t('Функциональная проверка браузера доступна и без анализа изображений.');
    return { mode, autonomous: config.autonomousBrowserQa === true, available, pending, reason };
  });
  ipcMain.handle('browser-qa:configure', async (_event, mode: BrowserVisionMode, autonomous: boolean, confirmed: boolean) => {
    if (!['off','auto','on'].includes(mode) || typeof autonomous !== 'boolean' || confirmed !== true) throw new Error(t('Подтвердите применение настроек Browser Vision.'));
    if (activeGenerations.size || contextDiscoveryBusy || runtimeSelectionBusy) throw new Error(t('Дождитесь завершения ответа или остановите задачу. Browser Vision не останавливает генерацию автоматически.'));
    runtimeSelectionBusy = true;
    try {
      const config = effectiveRuntimeConfiguration();
      if (mode === 'on' && mode !== config.browserVision && !await liveMultimodal(`${llamaCppUrl}/v1/chat/completions`).catch(() => false)) {
        const current = await currentLlamaRuntime(); const profile = current.modelId ? llamaRuntimeProfile(current.modelId) : undefined;
        // Browser Vision is a persisted preference and may be selected before
        // any model is loaded. Capability is enforced at the model-load boundary.
        if (current.status === 'ready') {
          if (!profile?.vision || !profile.mmprojPath) throw new Error(t('У загруженной модели нет совместимых локальных весов projector. Browser Vision не изменён.'));
          if (current.speculativeMode === 'mtp' && profile.visionWithMtp === false) throw new Error(t('Эта модель не поддерживает Browser Vision с активным MTP. MTP сохранён, Browser Vision не изменён.'));
          const result = await llamaRuntime.switchTo(current.modelId!, current.contextWindow!, current.kvCacheType ?? 'f16', current.kvOffload ?? true, current.projectorDevice ?? config.imageProcessingDevice ?? 'cpu', current.mtpMode);
          if (!result.ok) throw new Error(result.error);
          if (!await liveMultimodal(`${llamaCppUrl}/v1/chat/completions`)) throw new Error(t('После перезагрузки сервер не подтвердил поддержку изображений. Browser Vision не изменён.'));
        }
      }
      saveRuntimeConfiguration({ ...effectiveRuntimeConfiguration(), browserVision: mode, autonomousBrowserQa: autonomous });
      await syncLlamaBackend();
    } finally { runtimeSelectionBusy = false; void visionDevice.flush(); }
  });
  ipcMain.handle('mtp:status', (_event, modelId: string) => mtpStatus(modelId));
  ipcMain.handle('mtp:apply', async (_event, modelId: string, mode: MtpMode, confirmed: boolean) => {
    if (!['auto', 'on', 'off'].includes(mode) || confirmed !== true) throw new Error(t('Подтвердите применение настроек MTP.'));
    if (activeGenerations.size || contextDiscoveryBusy || runtimeSelectionBusy) throw new Error('Дождитесь завершения ответа или остановите задачу. MTP не прерывает генерацию автоматически.');
    runtimeSelectionBusy = true;
    try {
      const config = effectiveRuntimeConfiguration(); const model = config.models.find(model => model.id === modelId);
      if (!model) throw new Error(t('Неизвестная модель.'));
      await resolveMtpMode(mode, model.modelPath, config.llamaServerPath);
      const current = await llamaRuntime.state();
      if (current.status === 'ready' && current.modelId === modelId) {
        const result = await llamaRuntime.switchTo(modelId, current.contextWindow!, current.kvCacheType ?? 'f16', current.kvOffload ?? true, current.projectorDevice, mode);
        if (!result.ok) throw new Error(result.error);
      }
      saveRuntimeConfiguration({ ...config, models: config.models.map(model => model.id === modelId ? { ...model, mtpMode: mode } : model) });
      // MTP changes the measured runtime identity and allocation envelope. Preserve historical measurements.
      savedDiscoveryAttempted = null; discoveredContextOptions.clear();
      await syncLlamaBackend();
      return await mtpStatus(modelId);
    } finally { runtimeSelectionBusy = false; void visionDevice.flush(); }
  });
  ipcMain.handle('runtime:state', currentLlamaRuntime);
  const getSettings = async () => {
    const llama = await syncLlamaBackend();
    const setup = runtimeSetup();
    return { llamaServerPath: setup.server, llamaRuntimeModelId: llama.modelId ?? undefined, llamaRuntime: llama, modelsPath: setup.config.modelsPath, setup };
  };
  ipcMain.handle('settings:get', getSettings);
  ipcMain.handle('settings:validateDraft', (_event, config: unknown) => runtimeDraftAvailability(config));
  const resolutionJobs = new Map<number, AbortController>();
  ipcMain.handle('settings:cancelResolution', (event) => { resolutionJobs.get(event.sender.id)?.abort(); });
  ipcMain.handle('settings:resolveExecutable', async (event, input: unknown, selected: unknown) => {
    if (typeof input !== 'string' || input.length > 4096 || selected !== undefined && (typeof selected !== 'string' || selected.length > 4096)) throw new Error(t('Некорректный путь к исполняемому файлу'));
    const id = event.sender.id;
    resolutionJobs.get(id)?.abort();
    const controller = new AbortController(); resolutionJobs.set(id, controller);
    const cancel = () => controller.abort(); event.sender.once('destroyed', cancel);
    try { return await resolveLlamaExecutable(input, selected as string | undefined, { signal: controller.signal }); }
    finally { event.sender.removeListener('destroyed', cancel); if (resolutionJobs.get(id) === controller) resolutionJobs.delete(id); }
  });
  ipcMain.handle('settings:save', async (_event, config: unknown) => {
    if (activeGenerations.size || contextDiscoveryBusy || runtimeSelectionBusy) throw new Error('Дождитесь завершения генерации, выбора модели или поиска контекста.');
    runtimeSelectionBusy = true;
    try {
    const next = normalizeConfiguration(config);
    // Native menu owns this preference; an older open setup form must not revert it.
    const existingConfig = effectiveRuntimeConfiguration();
    next.imageProcessingDevice = existingConfig.imageProcessingDevice;
    next.browserVision = existingConfig.browserVision; next.autonomousBrowserQa = existingConfig.autonomousBrowserQa;
    next.models = next.models.map(model => ({ ...model, mtpMode: existingConfig.models.find(current => current.id === model.id)?.mtpMode ?? model.mtpMode }));
    const input = next.llamaServerInput ?? next.llamaServerPath ?? '';
    if (input.trim()) {
      const resolution = await resolveLlamaExecutable(input, next.llamaServerPath ?? undefined);
      if (resolution.status !== 'valid' || !resolution.path) throw new Error(t('Выберите корректный исполняемый файл llama-server.'));
      next.llamaServerPath = resolution.path;
    } else next.llamaServerPath = null;
    const active = await llamaRuntime.state();
    if (active.status === 'ready' && active.modelId) {
      const prior = runtimeSetup().config;
      const before = prior.models.find((model) => model.id === active.modelId);
      const after = next.models.find((model) => model.id === active.modelId);
      const sameActive = before && after && before.modelPath === after.modelPath && before.mmprojPath === after.mmprojPath
        && before.gpuLayers === after.gpuLayers && before.speculative === after.speculative && (before.projectorDevice ?? 'auto') === (after.projectorDevice ?? 'auto');
      if (!sameActive || prior.llamaServerPath !== next.llamaServerPath || prior.gpuLayers !== next.gpuLayers) {
        throw new Error('Сначала выберите другую модель или перезапустите приложение, чтобы изменить настройки активной модели/runtime.');
      }
    }
    saveRuntimeConfiguration(next);
    return await getSettings();
    } finally { runtimeSelectionBusy = false; void visionDevice.flush(); }
  });
  ipcMain.handle('settings:dismissSetup', async () => { dismissRuntimeSetup(); return getSettings(); });
  ipcMain.handle('hardware:get', getHardwareStats);
  ipcMain.handle('context:estimate', async (_event, modelId: string): Promise<RuntimeContextEstimate> => {
    if (typeof modelId !== 'string' || !modelId) throw new Error('Не указана модель для оценки контекста');
    return estimateModelContext(modelId);
  });
  ipcMain.handle('context:discover', async (_event, modelId: string): Promise<ContextDiscoveryResult> => {
    if (typeof modelId !== 'string' || !modelId) throw new Error('Не указана модель для discovery контекста');
    if (!modelSelectedThisProcess) throw new Error('Выберите модель перед поиском максимального контекста.');
    const result = await discoverModelContexts(modelId);
    return (await discoveryStatus(undefined, modelId)).result ?? result;
  });
  ipcMain.handle('context:discovery-status', discoveryStatus);
  ipcMain.handle('dialog:chooseDirectory', async (_event, initialDirectory?: string | null) => {
    const window = BrowserWindow.getFocusedWindow();
    const defaultPath = await existingProjectDirectory(initialDirectory);
    const result = await dialog.showOpenDialog(window!, { properties: ['openDirectory'], ...(defaultPath ? { defaultPath } : {}) });
    return result.canceled ? null : result.filePaths[0] ?? null;
  });
  ipcMain.handle('chat:stop', async (_event, conversationId: string, generationId?: string) => { await cancelGeneration(conversationId, generationId, 'user_stop'); });
  ipcMain.handle('dialog:chooseFile', async () => {
    const result = await dialog.showOpenDialog(BrowserWindow.getFocusedWindow()!, { properties: ['openFile'] });
    return result.canceled ? null : result.filePaths[0] ?? null;
  });
  ipcMain.handle('chat:steer', async (event, conversationId: string, generationId: string, content: string, intent?: SteeringIntent) => {
    const generation = activeGenerations.get(conversationId);
    if (!generation || generation.id !== generationId || generation.abort.signal.aborted || generation.mode !== 'agent') throw new Error('Уточнения доступны только во время активного Agent run.');
    if (typeof content !== 'string' || !content.trim() || content.length > 16_000) throw new Error('Уточнение должно содержать от 1 до 16000 символов.');
    if (intent !== undefined && intent !== 'pause') throw new Error('Неизвестный тип уточнения.');
    await rustAgent.steer(generation.id, content.trim(), intent);
    if (intent === 'pause') approvalBroker.pauseRun(generation.id);
    const message = database.addMessage(conversationId, 'user', content.trim(), undefined, [], { logicalTaskId: generation.logicalTaskId });
    // The model has not seen this message yet and its current turn is still streaming, so nothing is added to the
    // chronological timeline now: the entry is placed when the runtime applies it at a turn boundary.
    (generation.followups ??= []).push({ message, applied: false });
    log('generation.steering.accepted', { conversationId, generationId, messageId: message.id, intent: intent ?? null });
    event.sender.send('chat:stream', { type: 'steering', conversationId, generationId, userMessage: message, status: 'accepted' });
    return message;
  });
  ipcMain.handle('chat:approve', (event, request: { conversationId: string; generationId: string; approvalId: string; decision: ApprovalDecision }) => {
    const generation = activeGenerations.get(request.conversationId);
    if (!generation || generation.id !== request.generationId || generation.abort.signal.aborted) return false;
    return approvalBroker.reply(event.sender.id, request);
  });
  ipcMain.handle('chat:revoke-approvals', (_event, conversationId: string, generationId: string, grantId?: string) => {
    const generation = activeGenerations.get(conversationId);
    if (!generation || generation.id !== generationId) return false;
    approvalBroker.revoke(generationId, grantId); void liveBrowsers.closeConversation(_event.sender, conversationId); return true;
  });
  ipcMain.handle('chat:permissions', (_event, id: string) => autonomySessions.get(id));
  ipcMain.handle('chat:grants', (_event, id: string, runId: string) => activeGenerations.get(id)?.id === runId ? approvalBroker.list(runId) : []);
  ipcMain.handle('chat:set-permissions', async (event, id: string, mode: AutonomyMode, trust: boolean) => {
    const conversation = database.listConversations().find(item => item.id === id);
    if (!conversation) throw new Error('Чат недоступен');
    await liveBrowsers.closeConversation(event.sender, id);
    const permissions = await autonomySessions.set(id, mode, [conversation.workingDirectory, conversation.secondaryWorkingDirectory].filter((root): root is string => Boolean(root)), trust === true, async () => false);
    const generation = activeGenerations.get(id);
    if (generation?.mode === 'agent' && !generation.abort.signal.aborted && rustAgent.hasRun(generation.id)) await rustAgent.control(generation.id, { permissions });
    return permissions;
  });
  ipcMain.handle('chat:loop-control', async (_event, id: string, runId: string, signature: string, action: LoopAction) => {
    const generation = activeGenerations.get(id);
    if (generation?.id !== runId || generation.mode !== 'agent' || !['correct', 'continue', 'pause', 'correct_resume', 'continue_anyway'].includes(action) || typeof signature !== 'string') throw new Error('Управление циклом недоступно');
    await rustAgent.control(runId, { action, signature });
  });
  ipcMain.handle('live-browser:input', (event, sessionId: unknown, input: unknown) => liveBrowsers.input(event.sender, sessionId, input));
  ipcMain.handle('live-browser:close', (event, sessionId: unknown) => liveBrowsers.close(event.sender, sessionId));
  ipcMain.handle('live-browser:watch', (event, conversationId: unknown, visible: unknown) => liveBrowsers.watch(event.sender, conversationId, visible));
  ipcMain.handle('live-browser:layout', (event, sessionId: unknown, bounds: unknown) => liveBrowsers.layout(event.sender, sessionId, bounds));
  ipcMain.handle('chat:send', async (event, request: ChatRequest) => {
    const requestStarted = performance.now();
    log('rich.request.lifecycle', { generationId: request.generationId, stage: 'submitted', monotonicMs: requestStarted });
    if (contextDiscoveryBusy) throw new Error('Дождитесь завершения Max Context discovery перед генерацией.');
    if (runtimeSelectionBusy) throw new Error('Дождитесь завершения переключения runtime перед генерацией.');
    // Claim the process-wide inference slot synchronously, before any await.
    if (activeGenerations.size) throw new Error('Уже выполняется генерация в другом чате. Дождитесь завершения или остановите её.');
    const abort = new AbortController(); let finish!: () => void;
    const generation: ActiveGeneration = { id: request.generationId, abort, settled: new Promise<void>((resolve) => { finish = resolve; }), finish, thinkingTimeline: [], richArtifacts: [], activityTimelinePositions: new Map(), timelinePosition: 0, lastTimelineKind: null };
    activeGenerations.set(request.conversationId, generation);
    const current = () => activeGenerations.get(request.conversationId) === generation && !abort.signal.aborted;
    let run: AnalysisRun | null = null;
    let runFinalized = false;
    let logicalTaskId: string | undefined;
    let output = ''; let thinking = ''; let messageDiagnostics: import('../../shared/types').GenerationDiagnostics | undefined; let completed = false; let failed = false; let cancelled = false; let paused = false; let finishReason: 'stop' | 'length' = 'stop';
    const { thinkingTimeline, activityTimelinePositions } = generation;
    let failure: string | undefined;
    // The timeline is checkpointed at stable boundaries (steering, pause, tool
    // start/finish), never per token, so a Stop, failure or crash keeps every
    // event the live view already committed.
    const checkpoint = () => { if (run) database.saveAnalysisRunTimeline(run.id, thinkingTimeline, generation.richArtifacts); };
    const closeReasoning = () => { if (generation.lastTimelineKind === 'reasoning') { const prior = thinkingTimeline.at(-1); if (prior?.kind === 'reasoning' && !prior.completedAt) prior.completedAt = new Date().toISOString(); } };
    const finishRun = (status: AnalysisRun['status'], assistantMessageId: string | null = null) => {
      if (!run) return null;
      closeReasoning();
      const finished = database.finishAnalysisRun(run.id, status, assistantMessageId, { timeline: thinkingTimeline, richArtifacts: generation.richArtifacts, ...(status === 'completed' ? {} : { partialOutput: output, ...(failure ? { error: failure } : {}) }) });
      runFinalized = true;
      return finished;
    };
    const sendRun = (finished: AnalysisRun | null) => { if (finished) event.sender.send('chat:stream', { type: 'analysis-run', conversationId: request.conversationId, generationId: generation.id, run: finished }); };
    try {
    const user = request.persistUserMessage ? request.messages.at(-1) : null;
    if (request.persistUserMessage && (!user || user.role !== 'user')) throw new Error('Неверное сообщение');
    const conversation = database.getConversation(request.conversationId);
    if (!conversation) throw new Error('Чат не найден');
    const runtime = await syncLlamaBackend();
    const activation = runtime.activation;
    if (activation?.phase === 'failed' && (activation.conversationId === conversation.id || activation.modelId === request.model)) {
      const expected = activation.conversationId === conversation.id ? activation : { modelId: request.model, contextWindow: conversation.contextWindow, kvCacheType: conversation.llamaKvCacheType ?? 'f16', kvOffload: conversation.llamaKvOffload ?? true };
      if (runtime.modelId !== expected.modelId || runtime.contextWindow !== expected.contextWindow || runtime.kvCacheType !== expected.kvCacheType || runtime.kvOffload !== expected.kvOffload) {
        throw new Error(`${activation.error} Загрузите запрошенную конфигурацию или явно выберите активную перед генерацией.`);
      }
    }
    if (activeConversationModel(conversation, runtime) !== request.model) throw new Error('Выберите модель перед отправкой сообщения.');
    const mode = executionMode(conversation.mode, request.mode);
    generation.mode = mode;
    const triggeringUser = user ?? [...request.messages].reverse().find(message => message.role === 'user');
    if (mode === 'agent') {
      logicalTaskId = database.resolveLogicalTask(request.conversationId, request.continueLogicalTaskId, request.persistUserMessage ? undefined : triggeringUser?.id);
      generation.logicalTaskId = logicalTaskId;
      database.prepareTaskAttempt(request.conversationId, logicalTaskId);
    }
    if (conversation.modelId && conversation.modelId !== request.model) throw new Error('Выбранная модель была изменена. Повторите отправку сообщения.');
    const primaryProject = conversation.workingDirectory && conversation.primaryProjectId ? { id: conversation.primaryProjectId, slot: 1 as const, root: conversation.workingDirectory, label: `Project 1 — ${projectDirectoryName(conversation.workingDirectory)}` } : null;
    const selectedProjects: AgentProject[] = primaryProject ? [primaryProject, ...(conversation.secondaryWorkingDirectory && conversation.secondaryProjectId ? [{ id: conversation.secondaryProjectId, slot: 2 as const, root: conversation.secondaryWorkingDirectory, label: `Project 2 — ${projectDirectoryName(conversation.secondaryWorkingDirectory)}` }] : [])] : [];
    const validReferences = (references: ProjectReference[] | undefined): ProjectReference[] => (references ?? []).filter((reference) => selectedProjects.some((project) => project.id === reference.projectId && project.slot === reference.projectSlot && project.root === reference.projectPath) && (reference.kind === 'file' || reference.kind === 'folder') && Boolean(reference.relativePath));
    if (user) { user.projectReferences = validReferences(user.projectReferences); database.addMessage(request.conversationId, 'user', user.content, user.id, user.projectReferences, { logicalTaskId }); }
    if (logicalTaskId && triggeringUser) {
      database.bindMessageTask(triggeringUser.id, request.conversationId, logicalTaskId);
      run = database.createAnalysisRun(request.conversationId, conversation.reasoningMode, { logicalTaskId, generationId: generation.id, triggeringMessageId: triggeringUser.id });
      if (current()) sendRun(run);
    }
    const emitAttachment = (chunk: import('../../shared/types').StreamEvent) => event.sender.send('chat:stream', { ...chunk, conversationId: request.conversationId, generationId: generation.id });
    const attachmentIds = [...(request.attachmentIds ?? [])];
    if (user) {
      for (const input of request.attachments ?? []) {
        if (input.messageId !== user.id) throw new Error('Вложение относится к другому сообщению');
        try { const attachment = await attachments.import(input); attachmentIds.push(attachment.id); }
        catch (error) { emitAttachment({ type: 'attachment', activity: { id: `attachment-${input.id ?? randomUUID()}`, label: input.filename, detail: `✕ ${error instanceof Error ? error.message : String(error)}`, status: 'error' } }); }
      }
    }
    if (!current()) return;
    // Runtime capabilities govern routing for every image turn in the active
    // history, rather than guessing from model names.
    const requestMessages = logicalTaskId ? database.taskHistory(request.conversationId, logicalTaskId, request.messages) : request.messages;
    const requestMessageIds = new Set(requestMessages.map(message => message.id));
    const hasImages = database.listAttachmentsForConversation(request.conversationId).some((attachment) => attachment.kind === 'image' && (!logicalTaskId || requestMessageIds.has(attachment.messageId)));
    const requestUser = user ?? [...request.messages].reverse().find((message) => message.role === 'user');
    const retryAttachmentIds = requestUser ? database.listAttachments(requestUser.id).filter((attachment) => attachment.status === 'pending' || attachment.status === 'cancelled').map((attachment) => attachment.id) : [];
    const nativeImagesRequested = attachmentPipeline.hasNativeImagesForRequest(requestMessages);
    const nativeVision = nativeImagesRequested && await backend.supportsVision(request.model);
    const preprocessIds = [...new Set([...attachmentIds, ...retryAttachmentIds])];
    log('attachment.vision-routing', { generationId: generation.id, modelId: request.model, hasImages, nativeImagesRequested, route: nativeVision ? 'native' : nativeImagesRequested ? 'unsupported' : hasImages ? 'deferred' : 'none' });
    if (preprocessIds.length) await attachmentPipeline.preprocessCurrent(preprocessIds, abort.signal, emitAttachment, nativeVision);
    if (!current()) return;
    await backend.ensureModelAvailable(request.model);
    if (!current()) return;
    const historicalScope = mode === 'agent' && logicalTaskId && (request.continueLogicalTaskId || !request.persistUserMessage) && !selectedProjects.length ? database.getTaskScope(request.conversationId, logicalTaskId) : null;
    if (historicalScope) await restoreHistoricalTaskScope(historicalScope, homedir());
    // Only an explicit continuation can reuse the selected task's persisted scope.
    // No fallback to model-generated file paths or roots of other tasks.
    const agentProjects: AgentProject[] = mode === 'agent' ? selectedProjects.length ? [...selectedProjects] : (historicalScope?.projects ?? []).map((project, index) => ({ ...project, slot: (index + 1) as 1 | 2, label: `Task project — ${projectDirectoryName(project.root)}` })) : [];
    const agentRoot = agentProjects[0]?.root ?? null;
    const taskNamedRoots = mode === 'agent' ? await explicitWorkspaceRoots((logicalTaskId ? database.taskHistory(request.conversationId, logicalTaskId, request.messages) : request.messages).filter((message) => message.role === 'user').map((message) => message.content), homedir()) : [];
    // Persisted roots are a set for evidence identity; recover cwd ordering only
    // from this task's owned user messages, never from another task or the model.
    const workspaceRoots = historicalScope ? [...historicalScope.roots].sort((a,b) => {
      const rank = (root: string) => taskNamedRoots.includes(root) ? taskNamedRoots.indexOf(root) : taskNamedRoots.length;
      return rank(a)-rank(b);
    }) : taskNamedRoots;
    if (!current()) return;
    const enabledTools = enabledAgentTools(mode, { hasProject: Boolean(agentRoot), workspaceRootCount: workspaceRoots.length }, conversation.webMode);
    log('generation.snapshot', { generationId: generation.id, logicalTaskId, chatId: request.conversationId, mode, storedMode: conversation.mode, requestedMode: request.mode, workingDirectory: conversation.workingDirectory, resolvedWorkingDirectory: agentRoot, workspaceRoots, projects: agentProjects.map((project) => ({ id: project.id, slot: project.slot })), webMode: conversation.webMode, modelId: request.model, contextSize: conversation.contextWindow, reasoningMode: conversation.reasoningMode, enabledTools });
    if (logicalTaskId && database.setTaskScope(request.conversationId, logicalTaskId, JSON.stringify({ projects: agentProjects.map(project => ({ id: project.id, root: project.root })), roots: [...workspaceRoots].sort() }))) {
      await archiveAgentEvidence(paths.userData, request.conversationId, logicalTaskId);
    }
    if (run && current()) event.sender.send('chat:stream', { type: 'analysis-run', conversationId: request.conversationId, generationId: generation.id, run });
      const context = await backend.resolveContextWindow(request.model, conversation.contextWindow, abort.signal);
      if (!current()) return;
      event.sender.send('chat:stream', { type: 'context', conversationId: request.conversationId, generationId: generation.id, ...context });
      // Image descriptions are excluded for native-vision requests: the original
      // image payload is attached only to its owning user turn below.
      let history = attachmentPipeline.buildContext(requestMessages, !hasImages);
      if (nativeVision) history = await attachmentPipeline.prepareNativeImages(history, abort.signal);
      const persistedTaskMemory = mode === 'agent' ? taskPlan(database.getAgentPlan(request.conversationId, logicalTaskId) ?? {}).taskMemory : undefined;
      if (persistedTaskMemory && current()) event.sender.send('chat:stream', { type: 'task-memory', memory: structuredClone(persistedTaskMemory), conversationId: request.conversationId, generationId: generation.id });
      const agentSupportsReasoning = mode === 'agent' && llamaCpp.supportsReasoning(request.model);
      const reasoningCapabilityForModel = reasoningCapability(llamaRuntimeProfile(request.model));
      const reasoningSelection = resolveReasoningSelection(reasoningCapabilityForModel, conversation.reasoningMode, conversation);
      const reasoningInput: ReasoningInput = reasoningCapabilityForModel ? { mode: conversation.reasoningMode, selection: reasoningSelection } : conversation.reasoningMode;
      const validateDiagram = (source: string, signal: AbortSignal) => diagramValidation.validate(event.sender, source, signal);
      const stream = mode === 'agent'
        ? rustAgent.stream(request.model, history, agentProjects, abort.signal, context.active, conversation.reasoningMode, conversation.webMode, generation.id, persistedTaskMemory, request.conversationId, agentSupportsReasoning, agentReasoningOptions(request.model, reasoningSelection), workspaceRoots, validateDiagram, approvalBroker.forRun(event.sender, request.conversationId, generation.id), activity => { if (current()) event.sender.send('chat:stream', { type: 'tool', activity, conversationId: request.conversationId, generationId: generation.id }); }, autonomySessions.get(request.conversationId), logicalTaskId, liveBrowsers.observer(event.sender, request.conversationId, generation.id), status => { if (current()) event.sender.send('chat:stream', { type: 'browser-qa', qaStatus: status, conversationId: request.conversationId, generationId: generation.id }); })
        : webChat.stream(request.model, history, abort.signal, context.active, reasoningInput, conversation.webMode === 'auto', (args) => {
          const allowed = new Set(history.flatMap((message) => message.attachments ?? []).map((attachment) => attachment.id));
          if (typeof args.attachment_id !== 'string' || !allowed.has(args.attachment_id)) throw new Error(t('Выберите структурированное вложение из этого диалога.'));
          return attachments.readStructuredRows(args.attachment_id, typeof args.sheet_name === 'string' ? args.sheet_name : undefined, typeof args.start_row === 'number' ? args.start_row : 0, typeof args.max_rows === 'number' ? args.max_rows : 50);
        }, validateDiagram, generation.id);
      for await (let chunk of stream) {
        if (!current()) break;
        if (chunk.type === 'steering') {
          const content = chunk.userMessage.content;
          const followup = generation.followups?.find((entry) => !entry.applied && entry.message.content === content);
          if (followup) {
            followup.applied = true;
            closeReasoning();
            const timelinePosition = ++generation.timelinePosition;
            thinkingTimeline.push({ id: `steering-${followup.message.id}`, kind: 'steering', messageId: followup.message.id, position: timelinePosition, status: 'applied' });
            generation.lastTimelineKind = 'steering';
            checkpoint();
            event.sender.send('chat:stream', { ...chunk, userMessage: followup.message, timelinePosition, conversationId: request.conversationId, generationId: generation.id });
            log('generation.steering.applied', { conversationId: request.conversationId, generationId: generation.id, messageId: followup.message.id, timelinePosition });
          }
          continue;
        }
        if (chunk.type === 'paused') {
          paused = true;
          closeReasoning();
          const timelinePosition = ++generation.timelinePosition;
          thinkingTimeline.push({ id: `paused-${timelinePosition}`, kind: 'paused', position: timelinePosition });
          generation.lastTimelineKind = 'paused';
          checkpoint();
          event.sender.send('chat:stream', { type: 'paused', timelinePosition, conversationId: request.conversationId, generationId: generation.id });
          continue;
        }
        if (chunk.type === 'loop-event') {
          closeReasoning();
          const timelinePosition = ++generation.timelinePosition;
          thinkingTimeline.push({ id: `loop-${timelinePosition}`, kind: 'loop', position: timelinePosition, lifecycle: chunk.lifecycle });
          generation.lastTimelineKind = 'loop';
          checkpoint();
          log('agent.loop.lifecycle', { generationId: generation.id, ...chunk.lifecycle });
          event.sender.send('chat:stream', { ...chunk, timelinePosition, conversationId: request.conversationId, generationId: generation.id });
          continue;
        }
        if (chunk.type === 'token') output += chunk.content;
        if (chunk.type === 'thinking') {
          thinking += chunk.content;
          if (mode === 'agent') {
            if (generation.lastTimelineKind !== 'reasoning') { const position = ++generation.timelinePosition; thinkingTimeline.push({ id: randomUUID(), kind: 'reasoning', content: chunk.content, position, startedAt: new Date().toISOString() }); generation.lastTimelineKind = 'reasoning'; }
            else { const entry = thinkingTimeline.at(-1); if (entry?.kind === 'reasoning') entry.content += chunk.content; }
            chunk = { ...chunk, timelinePosition: generation.timelinePosition };
          }
        }
        if (chunk.type === 'task-memory') {
          const workBudget = database.getAgentPlan(request.conversationId, logicalTaskId)?.workBudget;
          database.saveAgentPlan(request.conversationId, { milestones: [], ...(workBudget ? { workBudget } : {}), taskMemory: structuredClone(chunk.memory) }, logicalTaskId);
          event.sender.send('chat:stream', { ...chunk, conversationId: request.conversationId, generationId: generation.id });
          continue;
        }
        if (chunk.type === 'work-budget') {
          database.saveAgentPlan(request.conversationId, { milestones: [], ...database.getAgentPlan(request.conversationId, logicalTaskId), workBudget: structuredClone(chunk.budget) }, logicalTaskId);
          event.sender.send('chat:stream', { ...chunk, conversationId: request.conversationId, generationId: generation.id });
          continue;
        }
        if (chunk.type === 'context-usage') {
          database.setContextUsage(request.conversationId, request.model, chunk.used);
          event.sender.send('chat:stream', { ...chunk, conversationId: request.conversationId, generationId: generation.id, modelId: request.model });
          continue;
        }
        if (chunk.type === 'diagnostics') {
          const diagnostics = { ...chunk.diagnostics, generationId: generation.id, conversationId: request.conversationId, createdAt: new Date().toISOString() };
          messageDiagnostics = diagnostics;
          saveGenerationDiagnosticsBestEffort((value) => database.saveGenerationDiagnostics(value), diagnostics);
          log('generation.diagnostics', diagnostics);
          event.sender.send('chat:stream', { type: 'diagnostics', conversationId: request.conversationId, generationId: generation.id, diagnostics });
          continue;
        }
        if (chunk.type === 'rich-artifact') {
          if (generation.richArtifacts.length >= 16 || generation.richArtifacts.some((item) => richArtifactFingerprint(item) === richArtifactFingerprint(chunk.artifact))) continue;
          generation.richArtifacts.push(chunk.artifact);
          // Chat only needs a durable run when it accepts an artifact; ordinary Chat stays unchanged.
          run ??= database.createAnalysisRun(request.conversationId, conversation.reasoningMode);
          checkpoint();
          log('rich.request.lifecycle', { generationId: generation.id, stage: 'artifact_sent', artifactId: chunk.artifact.id, elapsedMs: Math.round(performance.now() - requestStarted) });
          event.sender.send('chat:stream', { ...chunk, conversationId: request.conversationId, generationId: generation.id });
          continue;
        }
        if (chunk.type === 'done') { completed = true; finishReason = chunk.finishReason === 'length' ? 'length' : 'stop'; continue; }
        // Terminal events are delivered only after the run's history is final,
        // so the renderer always reconciles against the persisted state.
        if (chunk.type === 'error') { failed = true; failure ??= chunk.details ? `${chunk.message}: ${chunk.details}` : chunk.message; continue; }
        if (chunk.type === 'cancelled') { cancelled = true; continue; }
        if (!run && chunk.type === 'tool' && chunk.activity.metadata?.artifactType === 'image_gallery') run = database.createAnalysisRun(request.conversationId, conversation.reasoningMode);
        if (run && chunk.type === 'tool') {
          closeReasoning();
          const existingPosition = activityTimelinePositions.get(chunk.activity.id);
          const position = existingPosition ?? ++generation.timelinePosition;
          if (existingPosition === undefined) { activityTimelinePositions.set(chunk.activity.id, position); thinkingTimeline.push({ id: randomUUID(), kind: 'activity', activityId: chunk.activity.id, position }); }
          generation.lastTimelineKind = 'activity';
          const activity = { ...chunk.activity, timelinePosition: position };
          const updated = database.addAnalysisAction(run.id, activity);
          if (existingPosition === undefined || activity.state !== 'running') checkpoint();
          const visibleActivity = { ...activity };
          delete visibleActivity.rawOutput;
          event.sender.send('chat:stream', { ...chunk, activity: visibleActivity, runId: run.id, conversationId: request.conversationId, generationId: generation.id });
          // The renderer shows a live action from `toolActivities`; the run snapshot only matters when an action appears or
          // finishes (and the final snapshot follows). Re-sending the whole run for every terminal output line made the
          // payload grow with the run and replaced renderer state on each line.
          if (existingPosition === undefined || activity.state !== 'running') event.sender.send('chat:stream', { type: 'analysis-run', conversationId: request.conversationId, generationId: generation.id, run: updated });
        } else event.sender.send('chat:stream', { ...chunk, conversationId: request.conversationId, generationId: generation.id });
      }
      // Stop: the run is finalized before `chat:stop` resolves; `finally` reports the cancellation.
      if (!current()) { sendRun(finishRun('cancelled')); return; }
      if (cancelled) { sendRun(finishRun('cancelled')); event.sender.send('chat:stream', { type: 'cancelled', conversationId: request.conversationId, generationId: generation.id }); return; }
      if (failed || !completed) {
        failure ??= 'Генерация завершилась без итогового результата.';
        sendRun(finishRun('error'));
        event.sender.send('chat:stream', { type: 'error', conversationId: request.conversationId, generationId: generation.id, message: failure });
        return;
      }
      closeReasoning();
      const inputTokens = messageDiagnostics?.promptEvalCount ?? messageDiagnostics?.inputTokens;
      const generationStats = messageDiagnostics?.evalCount === undefined ? undefined : {
        outputTokens: messageDiagnostics.evalCount,
        ...(messageDiagnostics.tokensPerSecond !== undefined ? { tokensPerSecond: messageDiagnostics.tokensPerSecond } : {}),
        ...(messageDiagnostics.evalDuration !== undefined ? { generationDurationMs: messageDiagnostics.evalDuration / 1_000_000 } : {}),
        ...(messageDiagnostics.timeToFirstTokenMs !== undefined ? { timeToFirstTokenMs: messageDiagnostics.timeToFirstTokenMs } : {}),
        ...(inputTokens !== undefined ? { inputTokens } : {}),
      };
      const response = { ...(thinking.trim() ? { thinking } : {}), ...(thinkingTimeline.length ? { thinkingTimeline } : {}), ...(generationStats ? { generationStats } : {}), ...(generation.richArtifacts.length ? { richArtifacts: generation.richArtifacts } : {}) };
      if (paused && run) {
        sendRun(finishRun('interrupted'));
        event.sender.send('chat:stream', { type: 'done', conversationId: request.conversationId, generationId: generation.id, assistant: null, finishReason });
        return;
      }
      const result = run ? database.completeAnalysisRun(run.id, output, response) : null;
      if (result) runFinalized = true;
      const assistant = result ? result.assistant : output || generation.richArtifacts.length ? database.addMessage(request.conversationId, 'assistant', output, undefined, [], response) : null;
      if (result) sendRun(result.run);
      event.sender.send('chat:stream', { type: 'done', conversationId: request.conversationId, generationId: generation.id, assistant, finishReason });
    } catch (error) {
      log('generation.failed', { generationId: generation.id, conversationId: request.conversationId, model: request.model, message: error instanceof Error ? error.message : String(error) });
      if (run) {
        failure ??= `Не удалось выполнить запрос: ${error instanceof Error ? error.message : String(error)}`;
        const finished = finishRun(abort.signal.aborted ? 'cancelled' : 'error');
        if (activeGenerations.get(request.conversationId) === generation) sendRun(finished);
      }
      if (current()) event.sender.send('chat:stream', { type: 'error', conversationId: request.conversationId, generationId: generation.id, message: 'Не удалось выполнить запрос', details: error instanceof Error ? error.message : String(error) });
    } finally {
      try {
        // Task ownership is persisted before model/attachment preparation. Stop
        // during an awaited startup step must finalize that attempt as well.
        if (run && !runFinalized) {
          const finished = finishRun(abort.signal.aborted ? 'cancelled' : 'error');
          try { sendRun(finished); } catch { /* A closed renderer still keeps its durable snapshot. */ }
        }
      } finally {
        if (activeGenerations.get(request.conversationId) === generation) {
          activeGenerations.delete(request.conversationId);
          if (abort.signal.aborted) {
            try { event.sender.send('chat:stream', { type: 'cancelled', conversationId: request.conversationId, generationId: generation.id }); } catch { /* Application shutdown can close the renderer first. */ }
          }
        }
        approvalBroker.endRun(generation.id);
        generation.finish();
        void visionDevice.flush();
      }
    }
  });
}
