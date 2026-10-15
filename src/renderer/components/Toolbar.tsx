import { useLocale } from '../use-locale';
import { t, tr, localizeMessage } from '../../shared/locale';
import { activeConversationModel } from '../../shared/model-selection';
import { useEffect, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { X } from 'lucide-react';
import { useAppStore } from '../store/app-store';
import { ContextSelector } from './ContextSelector';
import { Hardware } from './Hardware';
import { MaximumContextPopover } from './MaximumContextPopover';
import { ProjectBadge } from './ProjectBadge';
import type { ContextDiscoveryResult, RuntimeContextEstimate } from '../../shared/context-estimator';
import { buildContextChoices, cacheModeLabel, contextChoiceId, describeContextChoice, type ContextChoice } from '../../shared/context-options';
import { reasoningControlText, reasoningEffortLabel, reasoningModeLabel, thinkingLabel } from '../../shared/localization';
import { resolveReasoningSelection, type ReasoningEffort } from '../../shared/reasoning-controls';

export function Toolbar() {
  useLocale();
  const { conversations, activeId, models, hardware, settings, isGenerating, updateConversation, refreshRuntimeStatus } = useAppStore(useShallow((state) => ({ conversations: state.conversations, activeId: state.activeId, models: state.models, hardware: state.hardware, settings: state.settings, isGenerating: state.isGenerating, updateConversation: state.updateConversation, refreshRuntimeStatus: state.refreshRuntimeStatus })));
  const [estimateResponse, setEstimateResponse] = useState<{ modelId: string; value?: RuntimeContextEstimate; error?: string } | null>(null);
  const [contextLoading, setContextLoading] = useState(false);
  const [contextLoadError, setContextLoadError] = useState<string | null>(null);
  const [contextDraft, setContextDraft] = useState<ContextChoice | null>(null);
  useEffect(() => setContextDraft(null), [activeId, conversations.find(c => c.id === activeId)?.modelId]);
  const [discovery, setDiscovery] = useState<ContextDiscoveryResult | null>(null);
  const [discoveryLoading, setDiscoveryLoading] = useState(false);
  const [discoveryError, setDiscoveryError] = useState<string | null>(null);
  const [currentVramBudget, setCurrentVramBudget] = useState<import('../../shared/vram-budget').VramBudget | undefined>();
  useEffect(() => {
    const timer = window.setInterval(() => void refreshRuntimeStatus(), 4_000);
    return () => window.clearInterval(timer);
  }, [refreshRuntimeStatus]);
  const chat = conversations.find((item) => item.id === activeId);
  const activeModelId = activeConversationModel(chat, settings?.llamaRuntime);
  const selectedModelId = chat?.modelId ?? activeModelId;
  const selectedModel = models.find((model) => model.id === selectedModelId);
  const reasoningCapability = selectedModel?.reasoning;
  const reasoningSelection = resolveReasoningSelection(reasoningCapability, chat?.reasoningMode ?? 'fast', chat ?? {});
  useEffect(() => {
    if (!selectedModelId) { setEstimateResponse(null); return undefined; }
    let current = true;
    setEstimateResponse((prior) => prior?.modelId === selectedModelId ? prior : { modelId: selectedModelId });
    void window.localAi.contextEstimate(selectedModelId)
      .then((value) => { if (current) setEstimateResponse({ modelId: selectedModelId, value }); })
      .catch((error: unknown) => { if (current) setEstimateResponse({ modelId: selectedModelId, error: error instanceof Error ? error.message : String(error) }); });
    return () => { current = false; };
  }, [selectedModelId, settings?.llamaRuntime?.status, settings?.llamaRuntime?.modelId, settings?.llamaRuntime?.contextWindow, settings?.llamaRuntime?.kvCacheType, settings?.llamaRuntime?.kvOffload]);
  useEffect(() => {
    setDiscovery(null);
    setDiscoveryError(null);
    setCurrentVramBudget(undefined);
  }, [selectedModelId]);
  useEffect(() => {
    if (!selectedModelId) { setDiscoveryLoading(false); return undefined; }
    let current = true;
    const poll = async () => {
      try {
        const progress = await window.localAi.contextDiscoveryStatus(selectedModelId);
        if (!current) return;
        setDiscoveryLoading(progress.busy);
        if (progress.modelId === selectedModelId) {
          if (progress.result) setDiscovery(progress.result);
          setDiscoveryError(progress.error ?? null);
          setCurrentVramBudget(progress.currentVramBudget);
        }
      } catch (error) {
        if (current) setDiscoveryError(error instanceof Error ? error.message : String(error));
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 2_000);
    return () => { current = false; window.clearInterval(timer); };
  }, [selectedModelId]);
  if (!chat) return null;
  const chooseDirectory = async (slot: 1 | 2, currentDirectory: string | null) => { const directory = await window.localAi.dialog.chooseDirectory(currentDirectory); if (directory) await updateConversation(chat.id, slot === 1 ? { workingDirectory: directory } : { secondaryWorkingDirectory: directory }); };
  const contextLabel = selectedModelId ? `${chat.contextWindow / 1024}K (${cacheModeLabel(chat.llamaKvCacheType ?? 'f16')}) · KV ${(chat.llamaKvOffload ?? true) ? 'GPU' : 'RAM'}` : '—';
  const contextEstimate = estimateResponse?.modelId === selectedModelId ? estimateResponse.value : undefined;
  const projectSelector = (slot: 1 | 2, directory: string | null) => <div className={`directory project-selector project-${slot}`}><button title={directory ?? undefined} onClick={() => void chooseDirectory(slot, directory)}><ProjectBadge path={directory} label={directory ? undefined : tr`Проект ${slot}: не выбран`} /></button>{directory && <button className="icon-button" aria-label={tr`Убрать проект ${slot}`} onClick={() => void updateConversation(chat.id, slot === 1 ? { workingDirectory: null } : { secondaryWorkingDirectory: null })}><X size={14} /></button>}</div>;
  const llama = settings?.llamaRuntime;
  const requestedContext = contextDraft ?? { contextWindow: chat.contextWindow, kvCacheType: chat.llamaKvCacheType ?? 'f16', kvOffload: chat.llamaKvOffload ?? true };
  const runtimeMatchesSelection = llama?.status === 'ready' && llama.modelId === selectedModelId && llama.contextWindow === requestedContext.contextWindow && llama.kvCacheType === requestedContext.kvCacheType && llama.kvOffload === requestedContext.kvOffload;
  const contextBusy = contextLoading || llama?.status === 'starting' || llama?.status === 'switching' || llama?.activation?.phase === 'validating';
  const runtimeLabel = !llama || llama.status === 'ready' ? `llama.cpp${llama?.speculativeMode === 'mtp' ? ' · MTP' : llama?.speculativeMode === 'eagle3' ? ' · EAGLE3' : ''}`
      : llama.status === 'switching' || llama.status === 'starting' ? t("llama.cpp · запуск модели…")
        : t("llama.cpp · не запущен");
  const discoveryForModel = discovery?.modelId === selectedModelId ? discovery : undefined;
  const actualRuntimeContext = llama?.status === 'ready' && llama.modelId === selectedModelId ? llama.contextWindow : null;
  const actualLabel = actualRuntimeContext ? `${actualRuntimeContext / 1024}K (${llama?.kvCacheType ? cacheModeLabel(llama.kvCacheType) : t('KV-тип не подтверждён')}) · KV ${llama?.kvOffload === undefined ? '?' : llama.kvOffload ? 'GPU' : 'RAM'}` : t('модель не загружена');
  const activation = llama?.activation?.conversationId === chat.id && llama.activation.modelId === selectedModelId ? llama.activation : undefined;
  const requestedLabel = contextDraft ? `${contextDraft.contextWindow / 1024}K (${cacheModeLabel(contextDraft.kvCacheType)}) · KV ${contextDraft.kvOffload ? 'GPU' : 'RAM'}` : activation ? `${activation.contextWindow / 1024}K (${cacheModeLabel(activation.kvCacheType)}) · KV ${activation.kvOffload ? 'GPU' : 'RAM'}` : contextLabel;
  const contextOptions = (() => {
    const cacheType = chat.llamaKvCacheType ?? 'f16';
    const kvOffload = chat.llamaKvOffload ?? true;
    const options = buildContextChoices(selectedModelId ?? '', selectedModel?.supportedContextPresets ?? [], selectedModel?.maxContext ?? 0, discoveryForModel?.options ?? [], selectedModel?.normalContext?.kvCacheType, selectedModel?.supportedKvCacheTypes);
    if (!options.some((option) => option.contextWindow === chat.contextWindow
      && option.kvCacheType === cacheType && option.kvOffload === kvOffload)) {
      options.push({ contextWindow: chat.contextWindow, kvCacheType: cacheType, kvOffload, label: `${chat.contextWindow / 1024}K (${cacheModeLabel(cacheType)}) · ${t('запрошено')}` });
    }
    return options.map(option => describeContextChoice(option, selectedModelId ?? '', discoveryForModel?.options ?? []));
  })();
  const selectedContextOption = contextDraft ? describeContextChoice(contextDraft, selectedModelId ?? '', discoveryForModel?.options ?? []) : contextOptions.find((option) => option.contextWindow === chat.contextWindow
    && option.kvCacheType === (chat.llamaKvCacheType ?? 'f16') && option.kvOffload === (chat.llamaKvOffload ?? true));
  const discoverMaximum = async () => {
    if (!selectedModelId) return;
    setDiscoveryLoading(true);
    setDiscoveryError(null);
    try { setDiscovery(await window.localAi.contextDiscover(selectedModelId)); }
    catch (error) { setDiscoveryError(error instanceof Error ? error.message : String(error)); }
    finally { setDiscoveryLoading(false); }
  };
  return (
    <header className="toolbar">
      <div className="monitoring-row" aria-label={t("Мониторинг llama.cpp")}>
        <Hardware value={hardware} />
        <span className="backend-indicator">{runtimeLabel}{llama?.pendingProjectorDevice ? tr` · После генерации: ${llama.pendingProjectorDevice.toUpperCase()}` : ''}</span>{llama?.deviceError && <span role="status" title={llama.deviceError}>{t("Не удалось переключить обработку изображений")}: {llama.deviceError}</span>}
        <button className="context-discover" disabled={discoveryLoading || !activeModelId || isGenerating} onClick={() => void discoverMaximum()}>{discoveryLoading ? t("Идёт проверка…") : discoveryForModel?.options.length ? t("Найти максимальный контекст снова") : t("Найти максимальный контекст")}</button>
        {selectedModelId && <div className="context-activation">
          <span className="context-selected">{t('Выбрано')}: {requestedContext.contextWindow / 1024}K ({cacheModeLabel(requestedContext.kvCacheType)})</span>
          <span role="status" className="context-active">{t('Активно')}: {actualLabel}</span>
          <button className={`context-load ${!runtimeMatchesSelection ? 'primary' : ''}`} aria-busy={contextBusy} disabled={Boolean(runtimeMatchesSelection || isGenerating || discoveryLoading || contextBusy)} onClick={() => {
            setContextLoading(true); setContextLoadError(null);
            void updateConversation(chat.id, { modelId: selectedModelId, contextWindow: requestedContext.contextWindow, llamaKvCacheType: requestedContext.kvCacheType, llamaKvOffload: requestedContext.kvOffload })
              .then(() => setContextDraft(null))
              .catch((error: unknown) => setContextLoadError(error instanceof Error ? error.message : String(error)))
              .finally(() => setContextLoading(false));
          }}>{contextBusy ? t('Проверка и загрузка выбранной конфигурации') : t('Загрузить выбранную конфигурацию')}</button>
        </div>}
        {contextLoadError && <span role="alert">{localizeMessage(contextLoadError)}</span>}
        {llama?.activation?.phase === 'validating' && <span role="status">{t('Проверка и загрузка выбранной конфигурации')}</span>}
        {(llama?.error || llama?.activation?.error) && <span role="alert">{t('Загрузка не выполнена. Причина — в мониторинге.')}</span>}
        {discoveryLoading && <span role="status">{t('Поиск максимального контекста…')}</span>}
        <MaximumContextPopover options={discoveryForModel?.options ?? []} supportedContext={contextEstimate?.configuredMaxTokens ?? selectedModel?.maxContext ?? null}
          vram={hardware?.available && hardware.vramTotalBytes != null && hardware.vramUsedBytes != null && hardware.vramAvailableBytes != null
            ? {total:hardware.vramTotalBytes,used:hardware.vramUsedBytes,free:hardware.vramAvailableBytes}
            : currentVramBudget ? {total:currentVramBudget.totalBytes,used:currentVramBudget.nonLlmBytes+currentVramBudget.llmBytes,free:currentVramBudget.freeBytes} : undefined} />
        {(llama?.error || llama?.activation?.error) && <details className="context-load-diagnostic"><summary>{t('Ошибка загрузки')}</summary>
          <p className="context-requested">{t('Запрошено')}: {requestedLabel}</p><p>{localizeMessage(llama.activation?.error ?? llama.error ?? '')}</p>
        </details>}
        {discoveryError && <span role="alert">{t('Поиск не завершён: ')}{localizeMessage(discoveryError)}</span>}
      </div>
      <div className="toolbar-controls">
        <label className="control"><span>{t("Модель")}</span><select disabled={discoveryLoading} value={selectedModelId ?? ''} onChange={(event) => void updateConversation(chat.id, { modelId: event.target.value || null }).catch(() => undefined)}><option value="" disabled>{t("Выберите модель")}</option>{models.map((model) => <option value={model.id} key={model.id} disabled={!model.installed}>{model.name}{model.installed ? '' : t(" · не установлена")}</option>)}</select></label>
        <ContextSelector options={contextOptions} selected={selectedContextOption} disabled={discoveryLoading || !selectedModelId} onChange={setContextDraft} />
        {reasoningCapability && <label className="control" title={reasoningControlText.thinkingHint}><span>{reasoningControlText.thinking}</span>{reasoningCapability.thinkingToggle
          ? <select value={reasoningSelection.thinking === false ? 'off' : 'on'} onChange={(event) => void updateConversation(chat.id, { thinkingEnabled: event.target.value === 'on' }).catch(() => undefined)}><option value="on">{thinkingLabel.on}</option><option value="off">{thinkingLabel.off}</option></select>
          : <select disabled title={reasoningControlText.thinkingUnavailable} value="unavailable"><option value="unavailable">{reasoningControlText.unavailable}</option></select>}</label>}
        {reasoningCapability && <label className="control" title={reasoningSelection.thinking === false ? reasoningControlText.effortInactive : reasoningControlText.effortHint}><span>{reasoningControlText.effort}</span>{reasoningCapability.efforts.length
          ? <select disabled={reasoningSelection.thinking === false} value={reasoningSelection.effort ?? ''} onChange={(event) => void updateConversation(chat.id, { reasoningEffort: event.target.value as ReasoningEffort }).catch(() => undefined)}>{reasoningCapability.efforts.map((effort) => <option value={effort} key={effort}>{reasoningEffortLabel[effort]}</option>)}</select>
          : <select disabled title={reasoningControlText.effortUnavailable} value="unavailable"><option value="unavailable">{reasoningControlText.unavailable}</option></select>}</label>}
        {reasoningCapability && <label className="control" title={reasoningControlText.strategyHint}><span>{reasoningControlText.strategy}</span><select value={chat.reasoningMode === 'deep' ? 'deep' : 'fast'} onChange={(event) => void updateConversation(chat.id, { reasoningMode: event.target.value as 'fast' | 'deep' }).catch(() => undefined)}><option value="fast">{reasoningModeLabel.fast}</option><option value="deep">{reasoningModeLabel.deep}</option></select></label>}
        <label className="control"><span>{t("Веб")}</span><select value={chat.webMode} onChange={(event) => void updateConversation(chat.id, { webMode: event.target.value as 'off' | 'auto' })}><option value="off">{t("Нет")}</option><option value="auto">{t("Да")}</option></select></label>
        <label className="control"><span>{t("Режим")}</span><select value={chat.mode} onChange={(event) => void updateConversation(chat.id, { mode: event.target.value as 'chat' | 'agent' })}><option value="chat">{t("Чат")}</option><option value="agent">{t("Агент")}</option></select></label>
        <div className="project-selectors">{projectSelector(1, chat.workingDirectory)}{projectSelector(2, chat.secondaryWorkingDirectory)}</div>
      </div>
    </header>
  );
}
