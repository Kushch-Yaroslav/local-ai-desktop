import { ReloadDialog } from './ReloadDialog';
import { BrowserQaControls } from './BrowserQaControls';
import { BrowserQaPanel } from './BrowserQaPanel';
import { ControlHelp } from './ControlHelp';
import { useLocale } from '../use-locale';
import { t, tr, localizeMessage } from '../../shared/locale';
import { activeConversationModel } from '../../shared/model-selection';
import { useEffect, useId, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { X, ChevronDown, ChevronUp } from 'lucide-react';
import { useAppStore } from '../store/app-store';
import { ContextSelector } from './ContextSelector';
import { MtpControl } from './MtpControl';
import { Hardware } from './Hardware';
import { MaximumContextPopover } from './MaximumContextPopover';
import { ProjectBadge } from './ProjectBadge';
import type { ContextDiscoveryResult, RuntimeContextEstimate } from '../../shared/context-estimator';
import { buildContextChoices, cacheModeLabel, describeContextChoice, type ContextChoice } from '../../shared/context-options';
import { reasoningControlText, reasoningEffortLabel, reasoningModeLabel, thinkingLabel } from '../../shared/localization';
import { resolveReasoningSelection, type ReasoningEffort } from '../../shared/reasoning-controls';

const panelModeKey = 'local-ai-control-panel-mode';

export function Toolbar() {
  const [expanded, setExpanded] = useState(() => { try { return localStorage.getItem(panelModeKey) === 'expanded'; } catch { return false; } });
  const panelId = useId();
  const [mtpStatus, setMtpStatus] = useState<import('../../shared/types').MtpStatus>();
  const [browserStatus, setBrowserStatus] = useState<Awaited<ReturnType<typeof window.localAi.browserQa.status>>>();
  const qaStatus = useAppStore(state => state.activeId ? state.qaStatuses[state.activeId] : undefined);
  const toggleExpanded = () => { const next = !expanded; setExpanded(next); try { localStorage.setItem(panelModeKey, next ? 'expanded' : 'compact'); } catch { /* Display remains usable when storage is unavailable. */ } };

  const ru = useLocale() === 'ru';
  const inferenceBusy = useAppStore(state => Boolean(state.generationOwnerId));
  const pausePhase = useAppStore(state => state.generationConversationId === state.activeId || state.continuationTaskId && state.pausePhase === 'Paused' ? state.pausePhase : null);
  const [reloadContext, setReloadContext] = useState(false);
  const [modelDraft, setModelDraft] = useState<string>();
  const { conversations, activeId, models, hardware, settings, isGenerating, updateConversation, refreshRuntimeStatus } = useAppStore(useShallow((state) => ({ conversations: state.conversations, activeId: state.activeId, models: state.models, hardware: state.hardware, settings: state.settings, isGenerating: state.isGenerating, updateConversation: state.updateConversation, refreshRuntimeStatus: state.refreshRuntimeStatus })));
  const runtimeNotice = useAppStore(state => state.runtimeNotice);
  const transitions = useAppStore(state => state.modeTransitions);
  useEffect(() => {
    if (!runtimeNotice) return;
    const timer = window.setTimeout(() => { if (useAppStore.getState().runtimeNotice === runtimeNotice) useAppStore.setState({ runtimeNotice: null }); }, 6000);
    return () => window.clearTimeout(timer);
  }, [runtimeNotice]);
  const afterResponse = 'Дождитесь завершения ответа или остановите задачу.';
  const liveHint = 'Можно менять во время работы. Применится на следующем шаге модели.';
  const [estimateResponse, setEstimateResponse] = useState<{ modelId: string; value?: RuntimeContextEstimate; error?: string } | null>(null);
  const [contextLoading, setContextLoading] = useState(false);
  const [contextLoadError, setContextLoadError] = useState<string | null>(null);
  const [contextDraft, setContextDraft] = useState<ContextChoice | null>(null);
  const conversationModelId = conversations.find(c => c.id === activeId)?.modelId;
  useEffect(() => { setContextDraft(null); setModelDraft(undefined); setReloadContext(false); }, [activeId, conversationModelId]);
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
  const selectedModelId = modelDraft ?? chat?.modelId ?? activeModelId;
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
  const projectSelector = (slot: 1 | 2, directory: string | null) => <div className={`directory project-selector project-${slot}`}><button disabled={isGenerating} title={isGenerating ? afterResponse : directory ?? undefined} onClick={() => void chooseDirectory(slot, directory)}><ProjectBadge path={directory} label={directory ? undefined : tr`Проект ${slot}: не выбран`} /></button>{directory && <button className="icon-button" disabled={isGenerating} aria-label={tr`Убрать проект ${slot}`} onClick={() => void updateConversation(chat.id, slot === 1 ? { workingDirectory: null } : { secondaryWorkingDirectory: null })}><X size={14} /></button>}</div>;
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
  const applyContext = async () => {
    if (!selectedModelId) return;
    setContextLoading(true); setContextLoadError(null);
    try { await updateConversation(chat.id, { modelId: selectedModelId, contextWindow: requestedContext.contextWindow, llamaKvCacheType: requestedContext.kvCacheType, llamaKvOffload: requestedContext.kvOffload }); setContextDraft(null); setModelDraft(undefined); setReloadContext(false); }
    catch (error) { setContextLoadError(String(error)); }
    finally { setContextLoading(false); }
  };
  const liveDisabled = isGenerating && chat.mode !== 'agent';
  const pending = transitions[chat.id];
  const notice = ru ? runtimeNotice : runtimeNotice?.includes('Ожидает') ? 'Reasoning configuration pending. Applies on the next model request.' : runtimeNotice?.includes('применены') ? 'New reasoning configuration applied.' : runtimeNotice ? 'Configuration saved for the next run.' : null;
  const summaryModelName = models.find(model => model.id === llama?.modelId)?.name ?? selectedModel?.name ?? (ru ? 'Модель не выбрана' : 'No model selected');
  const summaryContext = llama?.status === 'ready' && llama.contextWindow
    ? `${llama.contextWindow / 1024}K (${llama.kvCacheType ? cacheModeLabel(llama.kvCacheType) : '?'}) · KV ${llama.kvOffload === undefined ? '?' : llama.kvOffload ? 'GPU' : 'RAM'}`
    : (ru ? 'Контекст: —' : 'Context: —');
  const summaryMtp = llama?.status === 'ready' && llama.speculativeMode ? (llama.speculativeMode === 'mtp' ? 'active' : 'disabled') : mtpStatus?.effective ?? '…';
  return (
    <header data-panel-mode={expanded ? 'expanded' : 'compact'} className={`toolbar control-panel ${inferenceBusy ? 'is-working' : ''}`}>
      <div className="control-panel-heading"><strong className="panel-model" title={summaryModelName}>{summaryModelName}</strong><span className="runtime-state" role="status"><i/>{pausePhase ?? (contextBusy ? (ru?'Загрузка модели':'Loading model') : inferenceBusy && !isGenerating ? (ru?'Модель занята в другом чате':'Model busy in another chat') : isGenerating ? (chat.mode==='agent' ? (ru?'Агент работает':'Agent working') : (ru?'Генерация':'Generating')) : llama?.status==='ready' ? (ru?'Готово':'Ready') : (ru?'Модель не загружена':'Model unloaded'))}</span>{(pending || modelDraft || contextDraft || runtimeNotice?.includes('применены')) && <span className="configuration-state" role="status" data-state={pending?'pending':modelDraft||contextDraft?'reload':'applied'}>{pending ? (ru?'◷ Ожидает шага модели':'◷ Pending model step') : modelDraft||contextDraft ? (ru?'⟳ Требуется загрузка':'⟳ Reload required') : (ru?'✓ Применено':'✓ Applied')}</span>}<span className="compact-context" title={ru?'Активный вычислительный контекст':'Active inference context'}>{summaryContext}</span>
        {!expanded && <div className="compact-indicators" aria-label={ru?'Статусы возможностей':'Capability status'}>
          <span title={mtpStatus?.capability.reason}>MTP: {summaryMtp}</span>
          <span title={browserStatus?.reason}>Vision: {browserStatus ? browserStatus.mode === 'off' ? 'Off' : browserStatus.available ? `${browserStatus.mode} · Ready` : `${browserStatus.mode} · Unavailable` : '…'}</span>
          <span title={qaStatus?.report?.reason}>QA: {qaStatus && qaStatus.phase !== 'complete' ? qaStatus.phase : qaStatus?.report?.status ?? (browserStatus ? browserStatus.autonomous ? 'On' : 'Off' : '…')}</span>
        </div>}
        {selectedModelId && (expanded || !runtimeMatchesSelection) && <button className="context-load primary" aria-label={t('Загрузить выбранную конфигурацию')} aria-busy={contextBusy} disabled={Boolean(runtimeMatchesSelection || inferenceBusy || discoveryLoading || contextBusy)} onClick={() => { if (llama?.status === 'ready') setReloadContext(true); else void applyContext(); }}>{contextBusy ? (ru?'Загрузка…':'Loading…') : llama?.status === 'ready' ? (ru?'Перезагрузить':'Reload') : (ru?'Загрузить':'Load')}</button>}
        <button className="panel-mode-toggle" aria-expanded={expanded} aria-controls={panelId} title={expanded ? (ru?'Свернуть панель управления':'Collapse control panel') : (ru?'Развернуть панель управления':'Expand control panel')} onClick={toggleExpanded}>{expanded ? <ChevronUp size={16}/> : <ChevronDown size={16}/>}<span>{expanded ? (ru?'Свернуть':'Collapse') : (ru?'Параметры':'Expand')}</span></button>
      </div>
      {notice && <div className="runtime-notice" role="status">{notice}</div>}
      {!expanded && (contextLoadError || llama?.error || llama?.activation?.error) && <div className="runtime-notice" role="alert">{localizeMessage(contextLoadError ?? llama?.activation?.error ?? llama?.error ?? '')}</div>}
      <div id={panelId} className="panel-expansion" inert={!expanded} aria-hidden={!expanded}><div className="panel-details">
      <div className="monitoring-row" aria-label={t("Мониторинг llama.cpp")}>
        <Hardware value={hardware} />
        <span className="backend-indicator">{runtimeLabel}{llama?.pendingProjectorDevice ? tr` · После генерации: ${llama.pendingProjectorDevice.toUpperCase()}` : ''}</span>{llama?.deviceError && <span role="status" title={llama.deviceError}>{t("Не удалось переключить обработку изображений")}: {llama.deviceError}</span>}
        <button className="context-discover" disabled={discoveryLoading || !activeModelId || inferenceBusy} onClick={() => void discoverMaximum()}>{discoveryLoading ? t("Идёт проверка…") : discoveryForModel?.options.length ? t("Найти максимальный контекст снова") : t("Найти максимальный контекст")}</button>
        {selectedModelId && <div className="context-activation">
          <span className="context-selected">{t('Выбрано')}: {requestedContext.contextWindow / 1024}K ({cacheModeLabel(requestedContext.kvCacheType)})</span>
          <span role="status" className="context-active">{t('Активно')}: {actualLabel}</span>

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
      <BrowserQaPanel/>
      <div className="toolbar-controls">
        <section className="control-group inference-group" aria-label={ru?'Модель и инференс':'Model & Inference'}><div className="control-group-heading"><strong>{ru?'МОДЕЛЬ И ИНФЕРЕНС':'MODEL & INFERENCE'}</strong><span>⟳ {ru?'Перезагрузка':'Reload required'}</span><ControlHelp label={ru?'Модель и контекст':'Model & context'}>{ru?'Модель, контекст и MTP изменяются после ответа. Перезагрузка пересоздаёт KV-cache, сохраняя чат и checkpoint. Выберите конфигурацию, затем примените её кнопкой загрузки.':'Model, context and MTP change after response. Reload recreates KV cache while preserving chat and checkpoints. Select a configuration, then apply it with the load button.'}</ControlHelp></div><div className="control-group-fields">
        <label className="control"><span>{t("Модель")}</span><select disabled={discoveryLoading || inferenceBusy} title={inferenceBusy ? afterResponse : "Для изменения требуется перезагрузка модели или контекста."} value={selectedModelId ?? ''} onChange={(event) => setModelDraft(event.target.value)}><option value="" disabled>{t("Выберите модель")}</option>{models.map((model) => <option value={model.id} key={model.id} disabled={!model.installed}>{model.name}{model.installed ? '' : t(" · не установлена")}</option>)}</select></label>
        <MtpControl modelId={selectedModelId} onStatusChange={setMtpStatus} />
        <ContextSelector options={contextOptions} selected={selectedContextOption} disabled={discoveryLoading || !selectedModelId || inferenceBusy} onChange={setContextDraft} />
        </div></section>
        <section className="control-group reasoning-group" aria-label={ru?'Рассуждения и агент':'Reasoning & Agent'}><div className="control-group-heading"><strong>{ru?'РАССУЖДЕНИЯ И АГЕНТ':'REASONING & AGENT'}</strong><span>↻ {ru?'Глубина и стратегия — Live':'Effort & strategy — Live'}</span><ControlHelp label={ru?'Когда применятся параметры':'When settings apply'}>{ru?'Глубина и стратегия применяются на следующем обращении к модели. Ожидающие параметры помечены часами. Thinking, Web и Чат/Агент доступны после завершения или Stop. История и план не сбрасываются.':'Effort and strategy apply on the next model request. A clock marks pending settings. Thinking, Web and Chat/Agent change after completion or Stop. History and plan are preserved.'}</ControlHelp></div><div className="control-group-fields">
        {reasoningCapability && <label className="control" title={isGenerating ? afterResponse : reasoningControlText.thinkingHint}><span>{reasoningControlText.thinking}</span>{reasoningCapability.thinkingToggle
          ? <select disabled={isGenerating} value={reasoningSelection.thinking === false ? 'off' : 'on'} onChange={(event) => void updateConversation(chat.id, { thinkingEnabled: event.target.value === 'on' }).catch(() => undefined)}><option value="on">{thinkingLabel.on}</option><option value="off">{thinkingLabel.off}</option></select>
          : <select disabled title={reasoningControlText.thinkingUnavailable} value="unavailable"><option value="unavailable">{reasoningControlText.unavailable}</option></select>}</label>}
        {reasoningCapability && <label className="control" title={liveDisabled ? afterResponse : reasoningSelection.thinking === false ? reasoningControlText.effortInactive : liveHint}><span>{reasoningControlText.effort} <small aria-label="Live">{pending?.desired.reasoningEffort !== undefined ? "◷" : "↻"}</small></span>{reasoningCapability.efforts.length
          ? <select disabled={reasoningSelection.thinking === false || liveDisabled} value={reasoningSelection.effort ?? ''} onChange={(event) => void updateConversation(chat.id, { reasoningEffort: event.target.value as ReasoningEffort }).catch(() => undefined)}>{reasoningCapability.efforts.map((effort) => <option value={effort} key={effort}>{reasoningEffortLabel[effort]}</option>)}</select>
          : <select disabled title={reasoningControlText.effortUnavailable} value="unavailable"><option value="unavailable">{reasoningControlText.unavailable}</option></select>}</label>}
        {reasoningCapability && <label className="control" title={liveDisabled ? afterResponse : liveHint}><span>{reasoningControlText.strategy} <small aria-label="Live">{pending?.desired.reasoningMode !== undefined ? "◷" : "↻"}</small></span><select disabled={liveDisabled} value={chat.reasoningMode === 'deep' ? 'deep' : 'fast'} onChange={(event) => void updateConversation(chat.id, { reasoningMode: event.target.value as 'fast' | 'deep' }).catch(() => undefined)}><option value="fast">{reasoningModeLabel.fast}</option><option value="deep">{reasoningModeLabel.deep}</option></select></label>}
        <label className="control" title={afterResponse}><span>{t("Веб")} ◴</span><select disabled={isGenerating} value={chat.webMode} onChange={(event) => void updateConversation(chat.id, { webMode: event.target.value as 'off' | 'auto' })}><option value="off">{t("Нет")}</option><option value="auto">{t("Да")}</option></select></label>
        <label className="control" title={afterResponse}><span>{t("Режим")} ◴</span><select disabled={isGenerating} value={chat.mode} onChange={(event) => void updateConversation(chat.id, { mode: event.target.value as 'chat' | 'agent' })}><option value="chat">{t("Чат")}</option><option value="agent">{t("Агент")}</option></select></label>
        </div></section>
        <section className="control-group browser-group" aria-label="Browser & QA"><div className="control-group-heading"><strong>BROWSER & QA</strong><span>◴ {ru?'После ответа':'After response'}</span></div><div className="control-group-fields"><BrowserQaControls onStatusChange={setBrowserStatus}/></div></section>
        <section className="control-group projects-group" aria-label={ru?'Проекты':'Projects'}><div className="control-group-heading"><strong>{ru?'ПРОЕКТЫ И ССЫЛКИ':'PROJECTS & REFERENCES'}</strong><ControlHelp label={ru?'Контекст проекта':'Project context'}>{ru?'Проекты задают разрешённые рабочие каталоги. Ссылки на файлы и папки добавляются через @ в поле сообщения. Менять проекты можно после завершения ответа или Stop; прежние ссылки сохраняют исходную идентичность.':'Projects define authorized working directories. Add file and folder references with @ in the composer. Change projects after response or Stop; existing references retain their original identity.'}</ControlHelp></div><div className="project-selectors">{projectSelector(1, chat.workingDirectory)}{projectSelector(2, chat.secondaryWorkingDirectory)}</div></section>
      </div>
      </div></div>
      {reloadContext&&<ReloadDialog title={ru?'Модель и контекст':'Model & context'} busy={contextLoading} disabled={isGenerating} error={contextLoadError??undefined} onCancel={()=>setReloadContext(false)} onApply={()=>void applyContext()}><p>{selectedModel?.name} · {requestedLabel}</p><p>{ru?'Изменение не останавливает агентную задачу автоматически. Приостановленную задачу можно продолжить из checkpoint после загрузки.':'This change never stops an agent automatically. A paused task can resume from its checkpoint after loading.'}</p></ReloadDialog>}
    </header>
  );
}
