import { contextChoices } from '../contextDiscovery/contextChoices';
// Modified for Local AI Desktop: portal-based collision-aware session controls.
import * as Popover from '@radix-ui/react-popover';
import { rememberSessionConfiguration, useSessionConfiguration } from '../acp/sessionConfiguration';
import { useEffect, useRef, useState } from 'react';
import { Settings2, X, Search, LoaderCircle } from 'lucide-react';
import { methods } from '@agentclientprotocol/sdk';
import {
  acpChatSessionActions,
  acpChatSessionStore,
  useAcpChatSessionSnapshot,
} from '../acp/chatSessionStore';
import { getAcpClient } from '../acp/acpConnection';
import type { GooseMode } from '../types/session';
import type { ThinkingEffort } from '../types/providers';
import { defineMessages, useIntl } from '../i18n';
import type { GgufDiscoveryProgress, ProfileEntry, RuntimeState } from '../ggufTypes';
import type { ContextDiscoveryOption } from '../contextDiscovery/contextEstimator';
import { acpListProviderModels } from '../acp/providers';
import { hasBusyManagedSession } from '../contextDiscovery/sessionActivity';
import { resolveReasoningControls } from './reasoningControls';

const messages = defineMessages({
  thinkingToggle: { id: 'sessionSettings.thinkingToggle', defaultMessage: 'Thinking' },
  budgetReset: {
    id: 'sessionSettings.budgetReset',
    defaultMessage: 'Selecting thinking or effort clears an old numeric budget.',
  },
  providerDefault: { id: 'sessionSettings.providerDefault', defaultMessage: 'Provider default' },
  sharedRuntime: { id: 'sessionSettings.sharedRuntime', defaultMessage: 'Shared local runtime' },
  settings: { id: 'sessionSettings.title', defaultMessage: 'Session settings' },
  close: { id: 'sessionSettings.close', defaultMessage: 'Close settings' },
  agentMode: { id: 'sessionSettings.agentMode', defaultMessage: 'Agent mode' },
  thinking: { id: 'sessionSettings.thinking', defaultMessage: 'Reasoning effort' },
  reasoningRuntime: { id: 'sessionSettings.reasoningRuntime', defaultMessage: 'The runtime does not advertise request-level template controls.' },
  reasoningTemplate: { id: 'sessionSettings.reasoningTemplate', defaultMessage: 'Reasoning controls in this chat template are not verified.' },
  reasoningMetadata: { id: 'sessionSettings.reasoningMetadata', defaultMessage: 'Reasoning metadata could not be inspected.' },
  reasoningUnknown: {
    id: 'sessionSettings.reasoningUnknown',
    defaultMessage: 'Reasoning controls are not confirmed for this model.',
  },
  autonomous: { id: 'sessionSettings.autonomous', defaultMessage: 'Autonomous' },
  manual: { id: 'sessionSettings.manual', defaultMessage: 'Manual' },
  smart: { id: 'sessionSettings.smart', defaultMessage: 'Smart' },
  chatOnly: { id: 'sessionSettings.chatOnly', defaultMessage: 'Chat only' },
  off: { id: 'sessionSettings.off', defaultMessage: 'Off' },
  low: { id: 'sessionSettings.low', defaultMessage: 'Low' },
  medium: { id: 'sessionSettings.medium', defaultMessage: 'Medium' },
  high: { id: 'sessionSettings.high', defaultMessage: 'High' },
  max: { id: 'sessionSettings.max', defaultMessage: 'Max' },
  unavailable: {
    id: 'sessionSettings.unavailable',
    defaultMessage: 'Could not apply this setting',
  },
  defaultScope: { id: 'sessionSettings.modeScope', defaultMessage: 'Applies to this session' },
  context: { id: 'sessionSettings.context', defaultMessage: 'Context' },
  kvCache: { id: 'sessionSettings.kvCache', defaultMessage: 'KV Cache Precision' },
  thinkingBudget: {
    id: 'sessionSettings.thinkingBudget',
    defaultMessage: '{tokens} thinking tokens',
  },
  budgetHelp: {
    id: 'sessionSettings.budgetHelp',
    defaultMessage: 'Backend thinking budget; final answer tokens are separate.',
  },
  effortHelp: {
    id: 'sessionSettings.effortHelp',
    defaultMessage: 'Template effort setting, not a hard token limit.',
  },
  budget: { id: 'sessionSettings.budget', defaultMessage: 'Thinking budget' },
  xhigh: { id: 'sessionSettings.xhigh', defaultMessage: 'XHigh' },
  thinkingOn: { id: 'sessionSettings.thinkingOn', defaultMessage: 'On' },
  mixedKv: { id: 'sessionSettings.mixedKv', defaultMessage: 'Mixed / advanced' },
  verified: { id: 'sessionSettings.verified', defaultMessage: 'Verified' },
  saved: { id: 'sessionSettings.saved', defaultMessage: 'Saved · not revalidated' },
  stale: {
    id: 'sessionSettings.stale',
    defaultMessage: 'Configuration changed · revalidation required',
  },
  exactContext: {
    id: 'sessionSettings.exactContext',
    defaultMessage: '{tokens} tokens · {status}',
  },
  fp16: { id: 'sessionSettings.fp16', defaultMessage: 'FP16' },
  q8: { id: 'sessionSettings.q8', defaultMessage: 'Q8' },
  discover: { id: 'sessionSettings.discover', defaultMessage: 'Find maximum' },
  cancelDiscovery: { id: 'sessionSettings.cancelDiscovery', defaultMessage: 'Cancel search' },
  applying: { id: 'sessionSettings.applying', defaultMessage: 'Applying…' },
  apply: { id: 'sessionSettings.apply', defaultMessage: 'Apply' },
  busy: { id: 'sessionSettings.busy', defaultMessage: 'Local runtime is busy in another chat.' },
  noRuntime: {
    id: 'sessionSettings.noRuntime',
    defaultMessage: 'Local runtime controls are unavailable for this provider.',
  },
  discoveryFailed: {
    id: 'sessionSettings.discoveryFailed',
    defaultMessage:
      'Context search failed. The previous runtime configuration was restored where possible.',
  },
  candidate: {
    id: 'sessionSettings.candidate',
    defaultMessage: 'Checking {kv} at {context}K · probe {count}',
  },
  noResults: {
    id: 'sessionSettings.noResults',
    defaultMessage: 'No context size passed the memory checks.',
  },
  useResult: { id: 'sessionSettings.useResult', defaultMessage: 'Use {kv} · {context}K' },
  custom: { id: 'sessionSettings.custom', defaultMessage: 'Custom' },
  warning: {
    id: 'sessionSettings.warning',
    defaultMessage: 'A manually entered context size may exceed available memory.',
  },
  searching: { id: 'sessionSettings.searching', defaultMessage: 'Finding a safe context size…' },
  runtimeState: {
    id: 'sessionSettings.runtimeState',
    defaultMessage: 'Effective: {context}K · {kv}',
  },
  unsupportedMode: { id: 'sessionSettings.unsupportedMode', defaultMessage: '{kv}: {reason}' },
  unconfirmed: {
    id: 'sessionSettings.unconfirmed',
    defaultMessage: 'Saved result · conditions need confirmation',
  },
  q8NeedsFlashAttention: {
    id: 'sessionSettings.q8NeedsFlashAttention',
    defaultMessage:
      'Q8 V cache requires Flash Attention. Enable it in this model profile, then retry.',
  },
  discoveryUnsupportedCache: {
    id: 'sessionSettings.discoveryUnsupportedCache',
    defaultMessage: '{kv} cache is not advertised by this llama-server.',
  },
  discoveryEvidenceMissing: {
    id: 'sessionSettings.discoveryEvidenceMissing',
    defaultMessage:
      '{kv} could not be verified because runtime memory or inference evidence was incomplete.',
  },
  discoveryReserve: {
    id: 'sessionSettings.discoveryReserve',
    defaultMessage: 'No candidate preserved the required RAM/VRAM reserve.',
  },
  discoveryQ8NoGain: {
    id: 'sessionSettings.discoveryQ8NoGain',
    defaultMessage: 'Q8 was rejected because it did not verify at least an 8K gain over FP16.',
  },
  discoveryMemoryChanged: {
    id: 'sessionSettings.discoveryMemoryChanged',
    defaultMessage: 'Memory changed during probing; no safe context remained.',
  },
  discoveryUnsupportedFlag: {
    id: 'sessionSettings.discoveryUnsupportedFlag',
    defaultMessage: 'The selected llama-server does not support {flag}.',
  },
});

const modeLabels: Record<GooseMode, keyof typeof messages> = {
  auto: 'autonomous',
  approve: 'manual',
  smart_approve: 'smart',
  chat: 'chatOnly',
};
const effortLabels: Record<ThinkingEffort, keyof typeof messages> = {
  off: 'off',
  low: 'low',
  medium: 'medium',
  high: 'high',
  max: 'max',
};

function localizedDiscoveryReason(
  reason: string,
  kv: 'f16' | 'q8_0',
  intl: ReturnType<typeof useIntl>
): string {
  const label = kv === 'f16' ? 'FP16' : 'Q8';
  if (reason.includes('не объявляет этот тип KV-кэша'))
    return intl.formatMessage(messages.discoveryUnsupportedCache, { kv: label });
  if (reason.includes('Нет подтверждений:'))
    return intl.formatMessage(messages.discoveryEvidenceMissing, { kv: label });
  if (reason.includes('Ни один размер контекста') || reason.includes('требуемый запас'))
    return intl.formatMessage(messages.discoveryReserve);
  if (reason.includes('Q8 не дал подтверждённого выигрыша'))
    return intl.formatMessage(messages.discoveryQ8NoGain);
  if (reason.includes('После изменения доступной памяти'))
    return intl.formatMessage(messages.discoveryMemoryChanged);
  if (reason.includes('Для кэша Q8 V требуется Flash Attention'))
    return intl.formatMessage(messages.q8NeedsFlashAttention);
  if (reason.includes('Выбранный llama-server не поддерживает параметр')) {
    const flag = reason.match(/параметр (.+)\.$/)?.[1] ?? 'a required option';
    return intl.formatMessage(messages.discoveryUnsupportedFlag, { flag });
  }
  return reason;
}

import type { NewChatSettings } from '../acp/newChatSettings';
export type { NewChatSettings } from '../acp/newChatSettings';
export default function SessionSettingsPopover({
  sessionId,
  provider,
  model,
  draft,
  onDraftChange,
}: {
  sessionId: string | null;
  provider?: string | null;
  model?: string | null;
  draft?: NewChatSettings;
  onDraftChange?: (settings: NewChatSettings) => void;
}) {
  const intl = useIntl();
  const panel = useRef<HTMLElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [modePending, setModePending] = useState(false);
  const [effortPending, setEffortPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [modeOverride, setModeOverride] = useState<GooseMode | null>(null);
  const [effortOverride, setEffortOverride] = useState<ThinkingEffort | null>(null);
  const [profiles, setProfiles] = useState<ProfileEntry[]>([]);
  const [runtime, setRuntime] = useState<RuntimeState>({ phase: 'idle' });
  const [catalog, setCatalog] = useState<{
    options: ContextDiscoveryOption[];
    previous: ContextDiscoveryOption[];
    hardLimit: number;
    selectedContext: number;
    selectedKv: 'f16' | 'q8_0' | 'custom';
    supportedKv: Array<'f16' | 'q8_0'>;
    q8UnavailableReason?: string;
  } | null>(null);
  const [progress, setProgress] = useState<GgufDiscoveryProgress>({
    busy: false,
    stage: '',
    probeCount: 0,
  });
  const [selectedContext, setSelectedContext] = useState<number | null>(null);
  const [selectedKv, setSelectedKv] = useState<'f16' | 'q8_0' | 'custom'>('f16');
  const [busyElsewhere, setBusyElsewhere] = useState(false);
  const [operationError, setOperationError] = useState<string | null>(null);
  const [lease, setLease] = useState<string | null>(null);
  const [contextPending, setContextPending] = useState(false);
  const [unsupported, setUnsupported] = useState<
    Array<{ kvCacheType: 'f16' | 'q8_0'; reason: string }>
  >([]);
  const snapshot = useAcpChatSessionSnapshot(sessionId ?? '');
  const session = snapshot?.session;
  const configuration = useSessionConfiguration(sessionId ?? '');
  const providerId = session?.provider_name ?? provider;
  const localProfile = profiles.find(
    (entry) => entry.profile.providerId === providerId && entry.profile.backend !== 'native'
  )?.profile;
  const activeManaged =
    !!localProfile && runtime.phase === 'ready' && runtime.profileId === localProfile.id;
  const activeArgs = activeManaged ? (runtime.args ?? []) : [];
  const readRuntimeArg = (flag: string) => {
    const index = activeArgs.indexOf(flag);
    return index >= 0 ? activeArgs[index + 1] : undefined;
  };
  const effectiveContext = activeManaged
    ? Number(readRuntimeArg('--ctx-size') ?? localProfile?.context)
    : (catalog?.selectedContext ?? localProfile?.context);
  const runtimeKvK = activeManaged ? readRuntimeArg('--cache-type-k') : undefined;
  const runtimeKvV = activeManaged ? readRuntimeArg('--cache-type-v') : undefined;
  const effectiveKvValue = activeManaged
    ? (runtimeKvK ?? 'f16') === (runtimeKvV ?? 'f16')
      ? (runtimeKvK ?? 'f16')
      : 'custom'
    : (catalog?.selectedKv ??
      (localProfile?.cacheK === localProfile?.cacheV ? (localProfile?.cacheK ?? 'f16') : 'custom'));
  const effectiveKv =
    effectiveKvValue === 'f16' || effectiveKvValue === 'q8_0'
      ? catalog && !catalog.supportedKv.includes(effectiveKvValue)
        ? 'custom'
        : effectiveKvValue
      : 'custom';
  const modelName = session?.model_config?.model_name ?? model ?? '';
  const capabilityKey = `${providerId ?? ''}\u0000${modelName}`;
  const [managedCapabilities, setManagedCapabilities] = useState<{
    thinking: boolean;
    nativeEfforts: boolean;
    reasoning?: import('../ggufReasoningCapabilities').ManagedReasoningCapabilities;
    key: string;
  } | null>(null);
  const managedCapabilityKey = JSON.stringify([localProfile?.id, localProfile?.model, localProfile?.executable, localProfile?.chatTemplate]);
  useEffect(() => {
    let alive = true;
    setManagedCapabilities(previous => previous?.key === managedCapabilityKey ? previous : null);
    if (open && localProfile?.id)
      void window.electron
        .ggufCapabilities(localProfile.id)
        .then((c) => {
          if (alive) setManagedCapabilities({ key: managedCapabilityKey, thinking: c.thinking, nativeEfforts: c.nativeEfforts === true, reasoning: c.reasoning });
        })
        .catch(() => {
          if (alive) setManagedCapabilities({ key: managedCapabilityKey, thinking: false, nativeEfforts: false,
            reasoning: { thinkingSupported: false, thinkingToggleSupported: false, reasoningEffortSupported: false,
              supportedEfforts: [], status: 'unknown', diagnostic: 'metadata' } });
        });
    return () => {
      alive = false;
    };
  }, [localProfile?.id, managedCapabilityKey, open]);
  const [listedModelReasoning, setListedModelReasoning] = useState<{
    key: string;
    loaded: boolean;
    value?: boolean;
  }>();
  useEffect(() => {
    setListedModelReasoning({ key: capabilityKey, loaded: false });
    const selectedModel = session?.model_config?.model_name ?? model;
    if (!providerId || !selectedModel) {
      setListedModelReasoning({ key: capabilityKey, loaded: true });
      return;
    }
    let current = true;
    void acpListProviderModels(providerId)
      .then((models) => {
        const reasoning = models.find((entry) => entry.id === selectedModel)?.reasoning;
        if (current)
          setListedModelReasoning({
            key: capabilityKey,
            loaded: true,
            ...(typeof reasoning === 'boolean' ? { value: reasoning } : {}),
          });
      })
      .catch(() => {
        if (current) setListedModelReasoning({ key: capabilityKey, loaded: true });
      });
    return () => {
      current = false;
    };
  }, [capabilityKey, providerId, session?.model_config?.model_name, model]);
  const [effortCapabilityKey, setEffortCapabilityKey] = useState(capabilityKey);
  const observedCapabilityKey = useRef(capabilityKey);
  const observedConfiguration = useRef(configuration);
  useEffect(() => {
    if (observedCapabilityKey.current !== capabilityKey) {
      observedCapabilityKey.current = capabilityKey;
      observedConfiguration.current = configuration;
      setEffortCapabilityKey('');
    } else if (observedConfiguration.current !== configuration) {
      observedConfiguration.current = configuration;
      setEffortCapabilityKey(capabilityKey);
    }
  }, [capabilityKey, configuration]);
  const currentConfiguration = effortCapabilityKey === capabilityKey ? configuration : undefined;
  const modelReasoning =
    listedModelReasoning?.key === capabilityKey && listedModelReasoning.loaded
      ? (listedModelReasoning.value ?? session?.model_config?.reasoning)
      : undefined;
  const reasoningControls = localProfile
    ? managedCapabilities?.key === managedCapabilityKey
      ? resolveReasoningControls({ managed: managedCapabilities })
      : resolveReasoningControls({})
    : resolveReasoningControls({
        reasoning: modelReasoning,
        advertisedEfforts: currentConfiguration?.efforts,
      });
  const efforts = reasoningControls.effortOptions;
  const managedThinking = localProfile !== undefined && managedCapabilities?.thinking === true;
  const managedNativeEffort = managedCapabilities?.nativeEfforts === true;
  const configuredEffort = sessionId
    ? (currentConfiguration?.effort ?? session?.model_config?.request_params?.thinking_effort)
    : draft?.effort;
  const currentEffort =
    effortOverride ??
    (configuredEffort === 'off'
      ? 'off'
      : efforts.includes(configuredEffort as ThinkingEffort)
      ? (configuredEffort as ThinkingEffort)
      : managedThinking ? 'high' : efforts[0] ?? 'off');
  const [rememberedEffort, setRememberedEffort] = useState<ThinkingEffort>('high');
  useEffect(() => {
    setRememberedEffort('high');
  }, [sessionId, providerId, modelName]);
  useEffect(() => {
    if (currentEffort !== 'off') setRememberedEffort(currentEffort);
  }, [currentEffort]);
  const currentMode =
    modeOverride ??
    (sessionId ? (configuration?.mode ?? session?.goose_mode) : draft?.mode) ??
    'auto';

  useEffect(() => {
    setModeOverride(null);
    setEffortOverride(null);
    setError(null);
    setOperationError(null);
    setUnsupported([]);
  }, [sessionId, providerId, modelName]);

  useEffect(() => {
    let alive = true;
    const refresh = async () => {
      const [list, state] = await Promise.all([
        window.electron.ggufList(),
        window.electron.ggufState(),
      ]);
      if (!alive) return;
      setProfiles(list);
      setRuntime(state);
    };
    void refresh();
    const offState = window.electron.ggufOnState((state) => setRuntime(state));
    const offProgress = window.electron.ggufOnDiscoveryProgress((state) => setProgress(state));
    return () => {
      alive = false;
      offState();
      offProgress();
    };
  }, []);

  const catalogProfile = useRef<string | undefined>(undefined);
  useEffect(() => {
    const changedProfile = catalogProfile.current !== localProfile?.id;
    catalogProfile.current = localProfile?.id;
    if (!localProfile?.id) {
      setCatalog(null);
      setSelectedContext(null);
      return;
    }
    setCatalog(null);
    if (changedProfile) setSelectedContext(null);
    let alive = true;
    void window.electron
      .ggufDiscoveryCatalog(localProfile.id)
      .then((value) => {
        if (alive) {
          setCatalog(value);
          setSelectedContext(previous => changedProfile ? value.selectedContext : previous ?? value.selectedContext);
          if (changedProfile) setSelectedKv(
            value.selectedKv !== 'custom' && !value.supportedKv.includes(value.selectedKv)
              ? 'custom'
              : value.selectedKv
          );
        }
      })
      .catch(() => {
        if (alive) setCatalog(null);
      });
    return () => {
      alive = false;
    };
  }, [
    localProfile?.id,
    localProfile?.context,
    localProfile?.cacheK,
    localProfile?.cacheV,
    runtime,
  ]);

  useEffect(
    () => () => {
      if (lease) void window.electron.ggufDiscoveryCancel(lease);
    },
    [lease]
  );

  const applyMode = async (value: GooseMode) => {
    if (!sessionId) {
      onDraftChange?.({ ...draft, mode: value });
      return;
    }
    setModePending(true);
    setError(null);
    try {
      const client = await getAcpClient();
      await client.connection.agent.request(methods.agent.session.setMode, {
        sessionId,
        modeId: value,
      });
      rememberSessionConfiguration(sessionId, { modes: { currentModeId: value } });
      if (session)
        acpChatSessionActions.setSessionMetadata(sessionId, { ...session, goose_mode: value });
      setModeOverride(null);
    } catch {
      setError(intl.formatMessage(messages.unavailable));
    } finally {
      setModePending(false);
    }
  };

  const applyEffort = async (value: ThinkingEffort) => {
    if (!sessionId) {
      onDraftChange?.({ ...draft, effort: value, ...(managedThinking ? { budget: -1 } : {}) });
      return;
    }
    setEffortPending(true);
    setError(null);
    try {
      const client = await getAcpClient();
      if (managedThinking)
        rememberSessionConfiguration(
          sessionId,
          await client.connection.agent.request(methods.agent.session.setConfigOption, {
            sessionId,
            configId: 'thinking_budget',
            value: '-1',
          })
        );
      rememberSessionConfiguration(
        sessionId,
        await client.connection.agent.request(methods.agent.session.setConfigOption, {
          sessionId,
          configId: 'thinking_effort',
          value,
        })
      );
      rememberSessionConfiguration(sessionId, {
        configOptions: [{ id: 'thinking_effort', currentValue: value }],
      });
      if (session)
        acpChatSessionActions.setSessionMetadata(sessionId, {
          ...session,
          model_config: {
            ...(session?.model_config ?? { model_name: modelName, toolshim: false }),
            request_params: {
              ...session?.model_config?.request_params,
              thinking_effort: value,
              ...(managedThinking ? { reasoning_budget_tokens: -1 } : {}),
            },
          },
        });
      setEffortOverride(null);
    } catch {
      setError(intl.formatMessage(messages.unavailable));
    } finally {
      setEffortPending(false);
    }
  };

  const runtimeSessionsBusy = () =>
    hasBusyManagedSession(acpChatSessionStore.getActivitySnapshots(), profiles);

  const startDiscovery = async () => {
    if (!localProfile?.id) return;
    setOperationError(null);
    setBusyElsewhere(false);
    if (runtimeSessionsBusy()) {
      setBusyElsewhere(true);
      return;
    }
    let token: string | null = null;
    try {
      token = await window.electron.ggufDiscoveryAcquire();
      setLease(token);
      // Recheck after the main process atomically leased the shared runtime.
      if (runtimeSessionsBusy()) {
        setBusyElsewhere(true);
        await window.electron.ggufDiscoveryRelease(token);
        setLease(null);
        return;
      }
      const result = await window.electron.ggufDiscoveryRun(localProfile.id, token);
      setCatalog((current) =>
        current
          ? { ...current, options: result.result.options, previous: current.previous }
          : current
      );
      setUnsupported(result.result.unsupported);
      if (result.result.options.length === 0)
        setOperationError(intl.formatMessage(messages.noResults));
    } catch (error) {
      const text = String(error);
      setOperationError(
        text.includes('runtimeBusy')
          ? intl.formatMessage(messages.busy)
          : intl.formatMessage(messages.discoveryFailed)
      );
    } finally {
      if (token) await window.electron.ggufDiscoveryRelease(token).catch(() => {});
      setLease(null);
      if (localProfile?.id)
        void window.electron
          .ggufDiscoveryCatalog(localProfile.id)
          .then(setCatalog)
          .catch(() => {});
      void window.electron.ggufState().then(setRuntime);
    }
  };

  const applyContext = async () => {
    if (!localProfile?.id || !selectedContext) return;
    if (runtimeSessionsBusy()) {
      setBusyElsewhere(true);
      return;
    }
    setBusyElsewhere(false);
    setContextPending(true);
    setOperationError(null);
    let token: string | null = null;
    try {
      token = await window.electron.ggufDiscoveryAcquire();
      setLease(token);
      if (runtimeSessionsBusy()) {
        setBusyElsewhere(true);
        return;
      }
      await window.electron.ggufApplyContext(localProfile.id, selectedContext, selectedKv, token);
      const state = await window.electron.ggufState();
      setRuntime(state);
    } catch (error) {
      const message = String(error);
      setOperationError(
        message.includes('runtimeBusy')
          ? intl.formatMessage(messages.busy)
          : message.includes('quantizedCache')
            ? intl.formatMessage(messages.q8NeedsFlashAttention)
            : intl.formatMessage(messages.unavailable)
      );
    } finally {
      if (token) await window.electron.ggufDiscoveryRelease(token).catch(() => {});
      setLease(null);
      setContextPending(false);
      if (localProfile?.id)
        void window.electron
          .ggufDiscoveryCatalog(localProfile.id)
          .then(setCatalog)
          .catch(() => {});
    }
  };

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          ref={trigger}
          type="button"
          aria-label={intl.formatMessage(messages.settings)}
          aria-haspopup="dialog"
          aria-expanded={open}
          className="inline-flex h-8 w-8 items-center justify-center rounded-full text-text-primary/65 hover:bg-background-secondary hover:text-text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-border-primary"
        >
          <Settings2 className="h-4 w-4" aria-hidden="true" />
        </button>
      </Popover.Trigger>
      {open && (
        <Popover.Portal>
          <Popover.Content
            asChild
            side="top"
            align="end"
            sideOffset={8}
            collisionPadding={12}
            onOpenAutoFocus={(event) => {
              event.preventDefault();
              panel.current?.querySelector<HTMLElement>('#session-agent-mode')?.focus();
            }}
            onCloseAutoFocus={() => trigger.current?.focus()}
          >
            <section
              ref={panel}
              role="dialog"
              aria-label={intl.formatMessage(messages.settings)}
              className="z-50 max-h-[min(var(--radix-popover-content-available-height),36rem)] w-[min(19rem,calc(100vw-1.5rem))] overflow-y-auto rounded-xl border border-border-primary bg-background-primary p-3 text-text-primary shadow-xl motion-reduce:animate-none"
            >
              <header className="mb-3 flex items-center justify-between">
                <h2 className="text-sm font-medium">{intl.formatMessage(messages.settings)}</h2>
                <button
                  type="button"
                  aria-label={intl.formatMessage(messages.close)}
                  onClick={() => {
                    setOpen(false);
                    trigger.current?.focus();
                  }}
                  className="rounded p-1 text-text-secondary hover:bg-background-secondary"
                >
                  <X size={15} aria-hidden="true" />
                </button>
              </header>
              <label
                className="mb-1 block text-xs text-text-secondary"
                htmlFor="session-agent-mode"
              >
                {intl.formatMessage(messages.agentMode)}
              </label>
              <select
                id="session-agent-mode"
                value={currentMode}
                disabled={modePending}
                onChange={(event) => void applyMode(event.target.value as GooseMode)}
                className="mb-1 w-full rounded-lg border border-border-primary bg-background-primary px-2 py-1.5 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-border-primary"
              >
                {(Object.keys(modeLabels) as GooseMode[]).map((mode) => (
                  <option key={mode} value={mode}>
                    {intl.formatMessage(messages[modeLabels[mode]])}
                  </option>
                ))}
              </select>
              <p className="mb-3 text-[11px] text-text-secondary">
                {intl.formatMessage(messages.defaultScope)}
              </p>
              {reasoningControls.status === 'unknown' && (
                <p role="status" title={managedCapabilities?.reasoning?.diagnostic} className="mb-2 text-[11px] text-text-secondary">
                  {intl.formatMessage(managedCapabilities?.reasoning?.diagnostic === 'runtime' ? messages.reasoningRuntime : managedCapabilities?.reasoning?.diagnostic === 'template' ? messages.reasoningTemplate : managedCapabilities?.reasoning?.diagnostic === 'metadata' ? messages.reasoningMetadata : messages.reasoningUnknown)}
                </p>
              )}
              {reasoningControls.thinkingToggle && (
                <div className="mb-2">
                  <label htmlFor="session-thinking-toggle" className="mb-1 block text-xs">
                    {intl.formatMessage(messages.thinkingToggle)}
                  </label>
                  <select
                    id="session-thinking-toggle"
                    title={intl.formatMessage(messages.budgetReset)}
                    disabled={effortPending}
                    value={currentEffort === 'off' ? 'off' : 'on'}
                    onChange={(e) =>
                      void applyEffort(e.target.value === 'off' ? 'off' : rememberedEffort)
                    }
                    className="w-full rounded-lg border border-border-primary bg-background-primary px-2 py-1.5 text-sm"
                  >
                    <option value="off">{intl.formatMessage(messages.off)}</option>
                    <option value="on">{intl.formatMessage(messages.thinkingOn)}</option>
                  </select>
                </div>
              )}
              {reasoningControls.effortOptions.length > 0 &&
                (!reasoningControls.thinkingToggle || currentEffort !== 'off') && (
                <>
                  <label
                    className="mb-1 block text-xs text-text-secondary"
                    htmlFor="session-thinking-effort"
                  >
                    {intl.formatMessage(messages.thinking)}
                  </label>
                  <select
                    id="session-thinking-effort"
                    title={managedThinking ? intl.formatMessage(messages.effortHelp) : undefined}
                    value={currentEffort}
                    disabled={effortPending || efforts.length < 2}
                    onChange={(event) => {
                      if (!event.target.value && !sessionId)
                        onDraftChange?.({ ...draft, effort: undefined });
                      else void applyEffort(event.target.value as ThinkingEffort);
                    }}
                    className="w-full rounded-lg border border-border-primary bg-background-primary px-2 py-1.5 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-border-primary"
                  >
                    {efforts.map((effort) => (
                        <option key={effort} value={effort}>
                          {intl.formatMessage(
                            managedThinking && effort === 'high' && managedNativeEffort
                              ? messages.xhigh
                              : messages[effortLabels[effort]]
                          )}
                        </option>
                      ))}
                  </select>
                </>
              )}
              {localProfile && catalog && (
                <section
                  className="mt-3 border-t border-border-primary pt-3"
                  aria-label={intl.formatMessage(messages.context)}
                >
                  <div className="mb-1 flex items-center justify-between">
                    <h3
                      className="text-xs font-medium"
                      title={intl.formatMessage(messages.sharedRuntime)}
                    >
                      {intl.formatMessage(messages.context)}
                    </h3>
                    {activeManaged && effectiveContext && (
                      <span className="text-[10px] text-text-secondary">
                        {intl.formatMessage(messages.runtimeState, {
                          context: Math.round(effectiveContext / 1024),
                          kv:
                            effectiveKv === 'q8_0'
                              ? 'Q8'
                              : effectiveKv === 'f16'
                                ? 'FP16'
                                : intl.formatMessage(messages.mixedKv),
                        })}
                      </span>
                    )}
                  </div>
                  <div
                    className="grid grid-cols-3 gap-1"
                    role="group"
                    aria-label={intl.formatMessage(messages.context)}
                  >
                    {contextChoices(catalog.hardLimit, catalog.options, catalog.previous, selectedKv).map(
                      (choice) => {
                        const selected =
                          selectedContext === choice.tokens &&
                          (!choice.kv || selectedKv === choice.kv);
                        const disabled = !!choice.kv && !catalog.supportedKv.includes(choice.kv);
                        const status = choice.status
                          ? intl.formatMessage(messages[choice.status])
                          : '';
                        const warning =
                          disabled && choice.kv === 'q8_0'
                            ? intl.formatMessage(
                                catalog.q8UnavailableReason === 'flashAttention'
                                  ? messages.q8NeedsFlashAttention
                                  : messages.discoveryUnsupportedCache,
                                { kv: 'Q8' }
                              )
                            : '';
                        const tooltip = intl.formatMessage(messages.exactContext, {
                          tokens: String(choice.tokens),
                          status: [status, warning].filter(Boolean).join(' · '),
                        });
                        return (
                          <button
                            key={`${choice.tokens}:${choice.kv ?? 'preset'}`}
                            type="button"
                            disabled={disabled}
                            title={tooltip}
                            aria-pressed={selected}
                            onClick={() => {
                              setSelectedContext(choice.tokens);
                              if (choice.kv) setSelectedKv(choice.kv);
                            }}
                            className={`inline-flex items-center justify-center gap-1 rounded-md border px-1 py-1 text-[11px] disabled:opacity-40 ${selected ? 'border-blue-500 bg-background-secondary text-text-primary' : 'border-transparent text-text-secondary hover:bg-background-secondary'}`}
                          >
                            {choice.status && (
                              <span
                                aria-hidden="true"
                                className={`h-1 w-1 shrink-0 rounded-full ${choice.status === 'stale' || disabled ? 'bg-text-tertiary' : 'bg-green-500'}`}
                              />
                            )}
                            {Number((choice.tokens / 1024).toFixed(1))}K
                            {choice.kv ? ` · ${choice.kv === 'f16' ? 'FP16' : 'Q8'}` : ''}
                          </button>
                        );
                      }
                    )}
                  </div>
                  <label
                    className="mt-2 block text-[11px] text-text-secondary"
                    htmlFor="context-custom"
                    title={intl.formatMessage(messages.warning)}
                  >
                    {intl.formatMessage(messages.custom)}
                  </label>
                  <input
                    id="context-custom"
                    type="number"
                    title={intl.formatMessage(messages.warning)}
                    aria-describedby="context-custom-warning"
                    min={512}
                    max={catalog.hardLimit}
                    step={1}
                    value={selectedContext ?? ''}
                    onChange={(event) => {
                      setSelectedContext(event.target.value ? Number(event.target.value) : null);
                    }}
                    className="mt-1 w-full rounded-lg border border-border-primary bg-background-primary px-2 py-1.5 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-border-primary"
                  />
                  <span id="context-custom-warning" className="sr-only">
                    {intl.formatMessage(messages.warning)}
                  </span>
                  <div className="mt-2">
                    <label htmlFor="context-kv" className="block text-[11px] text-text-secondary">
                      {intl.formatMessage(messages.kvCache)}
                    </label>
                    <select
                      id="context-kv"
                      value={selectedKv === 'custom' ? '' : selectedKv}
                      onChange={(event) => {
                        setSelectedKv(event.target.value as typeof selectedKv);
                      }}
                      className="mt-1 w-full rounded-md border border-border-primary bg-background-primary px-2 py-1 text-xs"
                    >
                      {catalog.supportedKv.includes('f16') && (
                        <option value="f16">{intl.formatMessage(messages.fp16)}</option>
                      )}
                      {catalog.supportedKv.includes('q8_0') && (
                        <option value="q8_0">{intl.formatMessage(messages.q8)}</option>
                      )}
                      <option value="" disabled hidden>
                        {intl.formatMessage(messages.mixedKv)}
                      </option>
                    </select>
                  </div>
                  {!catalog.supportedKv.includes('q8_0') && (
                    <p className="mt-1 text-[10px] text-text-secondary">
                      {intl.formatMessage(
                        catalog.q8UnavailableReason === 'flashAttention'
                          ? messages.q8NeedsFlashAttention
                          : messages.discoveryUnsupportedCache,
                        { kv: 'Q8' }
                      )}
                    </p>
                  )}
                  <div className="mt-2 flex gap-1.5">
                    <button
                      type="button"
                      disabled={progress.busy}
                      onClick={() => void startDiscovery()}
                      className="inline-flex flex-1 items-center justify-center gap-1 rounded-lg border border-border-primary px-2 py-1.5 text-xs hover:bg-background-secondary disabled:opacity-50"
                    >
                      {progress.busy ? (
                        <LoaderCircle
                          className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none"
                          aria-hidden="true"
                        />
                      ) : (
                        <Search className="h-3.5 w-3.5" aria-hidden="true" />
                      )}
                      {intl.formatMessage(messages.discover)}
                    </button>
                    {progress.busy && lease && (
                      <button
                        type="button"
                        onClick={() => void window.electron.ggufDiscoveryCancel(lease)}
                        className="rounded-lg border border-border-primary px-2 py-1.5 text-xs hover:bg-background-secondary"
                      >
                        {intl.formatMessage(messages.cancelDiscovery)}
                      </button>
                    )}
                  </div>
                  {progress.busy && (
                    <div className="mt-2" aria-live="polite">
                      <p className="flex items-center gap-1.5 text-[11px] text-text-secondary">
                        <LoaderCircle
                          className="h-3 w-3 animate-spin motion-reduce:animate-none"
                          aria-hidden="true"
                        />
                        {progress.currentCandidate
                          ? intl.formatMessage(messages.candidate, {
                              kv: progress.currentCandidate.kv === 'f16' ? 'FP16' : 'Q8',
                              context: progress.currentCandidate.context / 1024,
                              count: progress.probeCount,
                            })
                          : intl.formatMessage(messages.searching)}
                      </p>
                      <div className="mt-1.5 flex h-2 items-center gap-1" aria-hidden="true">
                        {[16384, 32768, 65536, 131072, 262144]
                          .filter((value) => value <= catalog.hardLimit)
                          .map((value) => {
                            const selected = selectedContext === value;
                            const maximum = catalog.options.some(
                              (option) =>
                                option.kvCacheType === selectedKv && option.contextWindow === value
                            );
                            const candidate = progress.currentCandidate?.context === value;
                            return (
                              <span
                                key={value}
                                className={`h-1.5 flex-1 rounded-full ${maximum ? 'bg-green-500' : selected ? 'bg-blue-500' : 'bg-text-secondary/30'} ${candidate ? 'animate-pulse ring-2 ring-blue-400 motion-reduce:animate-none' : ''}`}
                              />
                            );
                          })}
                      </div>
                    </div>
                  )}
                  {busyElsewhere && (
                    <p role="status" className="mt-2 text-[11px] text-text-secondary">
                      {intl.formatMessage(messages.busy)}
                    </p>
                  )}
                  {unsupported.map((item) => (
                    <p
                      key={item.kvCacheType}
                      role="status"
                      className="mt-2 text-[10px] text-text-secondary"
                    >
                      {intl.formatMessage(messages.unsupportedMode, {
                        kv: item.kvCacheType === 'f16' ? 'FP16' : 'Q8',
                        reason: localizedDiscoveryReason(item.reason, item.kvCacheType, intl),
                      })}
                    </p>
                  ))}
                  {operationError && (
                    <p role="alert" className="mt-2 text-[11px] text-status-error">
                      {operationError}
                    </p>
                  )}
                  {selectedContext !== null &&
                    (selectedContext !== effectiveContext || selectedKv !== effectiveKv) && (
                      <button
                        type="button"
                        disabled={
                          progress.busy ||
                          contextPending ||
                          selectedContext < 512 ||
                          selectedContext > catalog.hardLimit
                        }
                        onClick={() => void applyContext()}
                        className="mt-2 w-full rounded-lg bg-background-secondary px-2 py-1.5 text-xs font-medium hover:bg-background-tertiary disabled:opacity-50"
                      >
                        {contextPending
                          ? intl.formatMessage(messages.applying)
                          : intl.formatMessage(messages.apply)}
                      </button>
                    )}
                </section>
              )}
              {error && (
                <p role="alert" className="mt-2 text-xs text-status-error">
                  {error}
                </p>
              )}
            </section>
          </Popover.Content>
        </Popover.Portal>
      )}
    </Popover.Root>
  );
}
