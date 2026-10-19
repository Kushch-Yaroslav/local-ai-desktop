import {ModelLaunchDiff} from './ModelLaunchDiff';
import { ModelProfileEditor } from './ModelProfileEditor';
import { AuthorConfigurations } from './AuthorConfigurations';
import { ReloadDialog } from './ReloadDialog';
import { useLocale } from '../use-locale';
import { t, tr, localizeMessage, getLanguage } from '../../shared/locale';
import { useEffect, useRef, useState } from 'react';
import { Plus, Trash2, FolderOpen, File, CheckCircle2, AlertTriangle, XCircle, Circle, LoaderCircle } from 'lucide-react';
import type { AppSettings, RuntimeConfiguration, RuntimeModelConfiguration, ExecutableResolution, RuntimeDraftAvailability } from '../../shared/types';
import { useAppStore } from '../store/app-store';

type SetupState = NonNullable<AppSettings['setup']>;
export function RuntimeSetup({ setup, onClose }: { setup: SetupState; onClose: () => void }) {
  const language = useLocale();
  const [config, setConfig] = useState<RuntimeConfiguration>(setup.config);
  const [savedConfig, setSavedConfig] = useState(setup.config);
  const configRef = useRef(config);
  configRef.current = config;
  const [editingId, setEditingId] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [languageError, setLanguageError] = useState('');
  const [saving, setSaving] = useState(false);
  const [applyDialog,setApplyDialog]=useState(false),[applying,setApplying]=useState(false),[applyError,setApplyError]=useState('');
  const activeRuntime=useAppStore(s=>s.settings?.llamaRuntime),activeId=useAppStore(s=>s.activeId);
  const ru=language==='ru';
  const conversation=useAppStore(s=>s.conversations.find(c=>c.id===s.activeId));
  const [validation, setValidation] = useState<{ input: string; selected?: string; result: ExecutableResolution } | null>(null);
  const [directorySearch, setDirectorySearch] = useState<{ input: string; result: ExecutableResolution } | null>(null);
  const [selectedCandidate, setSelectedCandidate] = useState<string | undefined>(setup.config.llamaServerInput ? setup.config.llamaServerPath ?? undefined : undefined);
  const [availability, setAvailability] = useState<{ key: string; result: RuntimeDraftAvailability } | null>(null);
  const [availabilityError, setAvailabilityError] = useState('');
  const modelsKey = JSON.stringify({ modelsPath: config.modelsPath, models: config.models.map(({ id, modelPath, mmprojPath,family }) => ({ id, modelPath, mmprojPath,family })) });
  const draftModels = availability?.key === modelsKey ? availability.result : null;

  const inputPath = config.llamaServerInput ?? config.llamaServerPath ?? '';
  const resolution = validation?.input === inputPath && validation.selected === selectedCandidate ? validation.result : null;
  const search = directorySearch?.input === inputPath ? directorySearch.result : null;
  const executableStatus = !inputPath.trim() ? 'not-configured' : resolution?.status ?? 'checking';
  const executableTone = executableStatus === 'valid' ? 'success' : ['missing', 'not-executable', 'unsupported', 'failed'].includes(executableStatus) ? 'danger' : ['multiple', 'incomplete'].includes(executableStatus) ? 'warning' : 'neutral';
  const StatusIcon = executableStatus === 'checking' ? LoaderCircle : executableTone === 'success' ? CheckCircle2 : executableTone === 'danger' ? XCircle : executableTone === 'warning' ? AlertTriangle : Circle;
  const partialSearch = search?.incomplete || resolution?.incomplete;
  const incompleteLabel = search?.candidates.length || resolution?.candidates.length ? t('Найден подходящий llama-server. Поиск остальных файлов не завершён.') : t('Не удалось завершить поиск в этой папке. Укажите более точный путь.');
  const candidates = search?.candidates ?? resolution?.candidates ?? [];
  const showCandidates = candidates.length > 0 && (candidates.length > 1 || partialSearch || search?.selectedMissing || executableStatus === 'multiple');
  const validationLabels = {
    'not-configured': t('Не настроен'), checking: t('Проверка файла или поиск llama-server…'), valid: t('llama-server найден и проверен'),
    multiple: t('Выберите один из найденных исполняемых файлов'), 'not-found': t('В указанной папке не найден llama-server.'), incomplete: incompleteLabel, cancelled: t('Поиск отменён.'),
    missing: t('Файл не существует'), 'not-executable': t('Файл не является исполняемым'), unsupported: t('Некорректный или неподдерживаемый исполняемый файл'), failed: t('Не удалось проверить исполняемый файл'),
  };
  // Language is saved immediately and is not part of the runtime draft.
  const dirty = JSON.stringify({ ...config, language }) !== JSON.stringify({ ...savedConfig, language });
  useEffect(() => {
    let cancelled = false;
    if (!inputPath.trim()) return;
    const watchdog = setTimeout(() => {
      cancelled = true;
      setValidation({ input: inputPath, selected: selectedCandidate, result: { status: 'incomplete', incomplete: true, candidates: [] } });
      void window.localAi.settings.cancelResolution().catch(() => undefined);
    }, 12_000);
    const timer = setTimeout(() => {
      void window.localAi.settings.resolveExecutable(inputPath, selectedCandidate).then((result) => {
        if (cancelled) return;
        clearTimeout(watchdog);
        setValidation({ input: inputPath, selected: selectedCandidate, result });
        // Keep the original search scope/results visible after a choice is
        // revalidated. Verifying one selected file does not complete the search.
        if (result.kind === 'directory' && (selectedCandidate === undefined || result.selectedMissing)) setDirectorySearch({ input: inputPath, result });
        if (result.status === 'valid' && result.path) setConfig((current) =>
          current.llamaServerInput === inputPath ? { ...current, llamaServerPath: result.path! } : current);
      }, () => { clearTimeout(watchdog); if (!cancelled) setValidation({ input: inputPath, selected: selectedCandidate, result: { status: 'failed', candidates: [] } }); });
    }, 300);
    return () => { cancelled = true; clearTimeout(timer); clearTimeout(watchdog); void window.localAi.settings.cancelResolution().catch(() => undefined); };
  }, [inputPath, selectedCandidate]);
  useEffect(() => {
    let cancelled = false;
    setAvailabilityError('');
    const timer = setTimeout(() => {
      void window.localAi.settings.validateDraft(JSON.parse(modelsKey)).then((result) => {
        if (!cancelled) setAvailability({ key: modelsKey, result });
      }, () => { if (!cancelled) setAvailabilityError('Не удалось проверить файлы моделей.'); });
    }, 300);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [modelsKey]);
  const changeExecutableInput = (path: string) => {
    if (path === inputPath) return;
    setSelectedCandidate(undefined); setValidation(null); setDirectorySearch(null);
    setConfig((current) => ({ ...current, llamaServerInput: path, llamaServerPath: null }));
  };

  // A saved-state refresh must never overwrite edits already made in this form.
  useEffect(() => { setSavedConfig(setup.config); }, [setup.config]);
  const draftReady = executableStatus === 'valid' && Boolean(draftModels?.folderExists && draftModels.models.some((model) => model.installed));
  const invalidDraft = executableTone === 'danger' || draftModels?.folderExists === false && config.modelsPath !== savedConfig.modelsPath;
  const readinessState = invalidDraft ? 'invalid' : dirty ? 'unsaved' : draftReady ? 'ready' : 'incomplete';
  const selected = config.models.find((model) => model.id === editingId) ?? null;
  const updateModel = (id: string, patch: Partial<RuntimeModelConfiguration>) => setConfig((current) => ({
    ...current, models: current.models.map((model) => model.id === id ? { ...model, ...patch } : model),
  }));
  const chooseFile = async (apply: (path: string) => void) => {
    try { const path = await window.localAi.dialog.chooseFile(); if (path) apply(path); }
    catch { setMessage(t("Не удалось открыть выбор файла. Проверьте разрешения рабочего стола.")); }
  };
  const addModel = () => { void chooseFile((path) => {
    const filename = path.split(/[\\/]/).at(-1) ?? path;
    const displayName = filename.replace(/\.gguf$/i, '') || t("Новая модель");
    const model: RuntimeModelConfiguration = { id: `custom:${globalThis.crypto.randomUUID()}`, displayName,
      modelPath: path, mmprojPath: '', gpuLayers: null, supportsTools: false, speculative: 'none', builtin: false };
    setConfig((current) => ({ ...current, models: [...current.models, model] }));
    setEditingId(model.id); setMessage('');
  }); };
  const save = async (rethrow=false) => {
    const submitted = config;
    setSaving(true); setMessage('');
    try {
      const result = await window.localAi.settings.save({ ...config, language: getLanguage() });
      useAppStore.setState({ settings: result });
      if (result.setup) {
        setSavedConfig(result.setup.config);
        if (configRef.current === submitted) {
          const saved = result.setup.config;
          setConfig(saved);
          setAvailability({ key: JSON.stringify({ modelsPath: saved.modelsPath, models: saved.models.map(({ id, modelPath, mmprojPath,family }) => ({ id, modelPath, mmprojPath,family })) }),
            result: { folderExists: true, models: result.setup.models.map((model) => ({ id: model.id, installed: model.installed, projectorMissing: model.status === 'invalid-projector',inspection:model.inspection })) } });
          if (saved.llamaServerPath && result.setup.server) setValidation({ input: saved.llamaServerInput ?? saved.llamaServerPath, selected: selectedCandidate, result: { status: 'valid', path: result.setup.server, candidates: [result.setup.server] } });
        }
      }
      void useAppStore.getState().refreshRuntime().catch(() => undefined);
      setMessage(t("Настройки сохранены. Следующий запуск модели использует новые пути."));
      return result;
    } catch (error) {
      setMessage((error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
      if(rethrow)throw error;
    } finally { setSaving(false); }
  };
  const remove = (model: RuntimeModelConfiguration) => {
    if (!window.confirm(tr`Удалить профиль «${model.displayName}»? История чатов сохранится, но для новых ответов нужно будет снова добавить эту модель.`)) return;
    setConfig((current) => ({ ...current, models: current.models.filter((entry) => entry.id !== model.id) }));
    if (editingId === model.id) setEditingId(null);
  };
  return <div className="runtime-setup-backdrop"><section className="runtime-setup" role="dialog" aria-modal="true" aria-labelledby="runtime-setup-title">
    <header><div><h2 id="runtime-setup-title">{t("Модели и runtime")}</h2><p>{t('Проверьте пути и сохраните настройки перед запуском модели.')}</p></div><div className="runtime-setup-header-actions"><label className="runtime-setup-language control">{t('Язык')}<select data-testid="setup-language" aria-label={t('Язык')} value={language} onChange={(event) => { setLanguageError(''); void window.localAi.settings.setLanguage(event.target.value as 'en' | 'ru').catch((error: unknown) => setLanguageError(error instanceof Error ? error.message : String(error))); }}><option value="en">English (EN)</option><option value="ru">Русский (RU)</option></select></label><button onClick={onClose} aria-label={t("Закрыть настройки")}>{t("Закрыть")}</button></div></header>
    {languageError && <p role="alert">{t('Не удалось сохранить язык.')} {localizeMessage(languageError)}</p>}
    <section data-testid="runtime-readiness" className={`runtime-readiness is-${readinessState}`} data-state={readinessState} role="status">
      <strong>{invalidDraft ? t('Настройки требуют исправления') : dirty ? draftReady ? t('Проверено — сохраните для запуска') : t('Есть несохранённые изменения') : draftReady ? t('Сохранено — готово к запуску') : t('Требуется настройка')}</strong>
      <span>{validationLabels[executableStatus]}</span>
      <span>{draftModels ? tr`Доступных GGUF в текущих настройках: ${draftModels.models.filter((model) => model.installed).length}` : localizeMessage(availabilityError) || t('Проверка файлов GGUF…')}</span>
      {dirty && <span className="runtime-unsaved-note">{t('Изменения не сохранены. Запуск использует ранее сохранённые настройки.')}</span>}
    </section>
    {setup.issues.filter((issue) => issue.startsWith('Не удалось прочитать')).map((issue) => <p className="runtime-setup-issue" role="alert" key={issue}>{localizeMessage(issue)}</p>)}
    <label>{t('Путь к llama-server или папке с ним')}<div className="setup-path setup-executable">
      <input aria-label={t('Путь к llama-server или папке с ним')} value={inputPath} onChange={(event) => changeExecutableInput(event.target.value)} />
      <button type="button" aria-label={t('Выбрать исполняемый файл llama-server')} title={t('Выбрать исполняемый файл llama-server')} onClick={() => void chooseFile(changeExecutableInput)}><File size={18} /></button>
      <button type="button" aria-label={t('Выбрать папку с llama-server')} title={t('Выбрать папку с llama-server')} onClick={async () => { try { const path = await window.localAi.dialog.chooseDirectory(); if (path) changeExecutableInput(path); } catch { setMessage(t('Не удалось открыть выбор папки.')); } }}><FolderOpen size={18} /></button>
    </div><small className="runtime-path-helper" data-testid="executable-helper">{t('Укажите исполняемый файл llama-server или папку, в которой его нужно найти.')}</small>
      {!inputPath.trim() && <div className="runtime-path-examples" data-testid="executable-examples"><small>{t('Файл: /DATA/llama/bin/llama-server')}</small><small>{t('Папка: /DATA')}</small></div>}
    </label>
    <div className={`runtime-executable-result is-${executableTone}`} data-testid="executable-result" data-tone={executableTone}>
      <p className="runtime-executable-status" role="status" data-testid="executable-validation" aria-busy={executableStatus === 'checking'}><StatusIcon size={18} aria-hidden="true" className={executableStatus === 'checking' ? 'runtime-check-spinner' : undefined} /><strong>{validationLabels[executableStatus]}</strong></p>
      {executableStatus === 'valid' && <p className="runtime-executable-path" data-testid="resolved-executable"><span>{t('Исполняемый файл:')}</span><code>{resolution?.path}</code></p>}
    </div>
    {showCandidates && <fieldset className="runtime-executable-choice"><legend>{t('Найденные исполняемые файлы')}</legend>
      <ul className="runtime-executable-candidates">{candidates.map((path) => {
        const chosen = executableStatus === 'valid' && resolution?.path === path;
        return <li key={path}><button type="button" aria-label={path} aria-pressed={chosen} className={chosen ? 'is-selected' : undefined} title={path} onClick={() => {
          if (chosen) return;
          setSelectedCandidate(path); setConfig((current) => ({ ...current, llamaServerPath: null }));
        }}><CheckCircle2 size={16} aria-hidden="true" /><code>{path}</code><span>{chosen ? t('Выбрано') : t('Выбрать')}</span></button></li>;
      })}</ul>
    </fieldset>}
    {partialSearch && executableStatus !== 'incomplete' && executableStatus !== 'valid' && <p className="runtime-search-note" role="status" data-testid="incomplete-search-note"><AlertTriangle size={14} aria-hidden="true" />{incompleteLabel}</p>}
    {(search?.reasons ?? resolution?.reasons)?.includes('permissions') && <p className="runtime-search-note" role="status">{t('Часть папок недоступна для чтения. Укажите доступную папку или файл.')}</p>}
    {executableStatus !== 'valid' && (search?.selectedMissing || resolution?.selectedMissing) && <p className="runtime-search-note" role="status">{t('Ранее выбранный файл недоступен. Выберите другой файл или измените путь.')}</p>}
    {executableStatus === 'not-found' && <small className="runtime-path-helper">{t('Укажите папку ближе к сборке llama.cpp или путь к исполняемому файлу.')}</small>}
    <small className="runtime-path-helper">{t('Проверка запускает --help без загрузки модели. Корректный файл не означает, что сервер уже работает.')}</small>
    <label>{t("Папка с моделями (GGUF)")}<div className="setup-path"><input aria-label={t("Каталог моделей")} value={config.modelsPath} onChange={(event) => setConfig({ ...config, modelsPath: event.target.value })} /><button onClick={async () => { try { const path = await window.localAi.dialog.chooseDirectory(config.modelsPath); if (path) setConfig((current) => ({ ...current, modelsPath: path })); } catch { setMessage(t("Не удалось открыть выбор папки.")); } }}>{t("Обзор…")}</button></div><small>{t("Укажите папку, где хранятся ваши GGUF-модели. Относительные пути будут отсчитываться от неё. Модели с абсолютными путями могут находиться в других папках.")}</small></label>
    {draftModels && <small role="status">{draftModels.folderExists ? t('Папка моделей доступна') : t('Папка моделей не найдена — выберите существующую папку')}</small>}
    <label>{t("GPU-слои по умолчанию")}<input aria-label={t("GPU-слои по умолчанию")} type="number" min="0" max="999" value={config.gpuLayers} onChange={(event) => setConfig({ ...config, gpuLayers: Number(event.target.value) })} /><small>{t("999 отправляет доступные слои на GPU; 0 использует CPU. Объём VRAM зависит от модели.")}</small></label>

    <fieldset><legend>{t('Веб-поиск')}</legend>
      <label>{t('Поисковый провайдер')}<select aria-label={t('Поисковый провайдер')} value={config.searchProvider ?? 'auto'} onChange={(event) => setConfig({ ...config, searchProvider: event.target.value as RuntimeConfiguration['searchProvider'] })}><option value="auto">{t('Автоматически (DuckDuckGo)')}</option><option value="duckduckgo">DuckDuckGo</option><option value="bing">Bing</option></select></label>
      <label className="runtime-option"><input type="checkbox" checked={config.allowBingFallback ?? false} onChange={(event) => setConfig({ ...config, allowBingFallback: event.target.checked })} />{t('Разрешить Bing как резервный провайдер')}</label>
      <small>{t('Поиск работает без API-ключа. Google Search API закрыт для новых клиентов; прямой Google-поиск не поддерживается.')}</small>
    </fieldset>
    <div className="runtime-model-heading"><div><h3>{t("Мои модели")}</h3><p>{t("Можно добавить любую совместимую GGUF-модель.")}</p></div><button className="runtime-add-model" onClick={addModel}><Plus size={16} /> {t(" Добавить GGUF")}</button></div>
    <ul className="runtime-model-list">{config.models.map((profile) => {
      const model = draftModels?.models.find((item) => item.id === profile.id);
      const ready = model?.installed && executableStatus === 'valid';
      const status = !model ? localizeMessage(availabilityError) || t('Проверка файла GGUF…') : !model.installed ? t('Выберите файл модели') : model.projectorMissing ? t('Projector не найден; текст доступен') : !ready ? t('Нужен llama-server') : dirty ? t('Файл доступен — сохраните настройки') : t('Готова к запуску');
      return <li key={profile.id} className={ready && !dirty ? 'model-ready' : 'model-needs-setup'}>
        <button className="runtime-model-select" aria-label={tr`Редактировать ${profile.displayName}`} onClick={() => setEditingId(profile.id)}>
          <strong>{profile.displayName}</strong><span>{status}</span>
        </button>
        <button aria-label={tr`Удалить профиль ${profile.displayName}`} title={t("Удалить профиль")} onClick={() => remove(profile)}><Trash2 size={16} /></button>
      </li>;
    })}</ul>
    {!config.models.length && <p>{t("Профилей пока нет. Нажмите «Добавить GGUF», чтобы выбрать модель с компьютера.")}</p>}

    {selected && <fieldset className="runtime-model-editor"><legend>{selected.builtin ? t("Настройки профиля") : t("Новый профиль")}</legend>
      <label>{t("Название в приложении")}<input aria-label={t("Название модели")} maxLength={80} value={selected.displayName} onChange={(event) => updateModel(selected.id, { displayName: event.target.value })} /></label>
      <label>{t("Файл модели GGUF")}<div className="setup-path"><input aria-label={t("Файл модели GGUF")} value={selected.modelPath} onChange={(event) => updateModel(selected.id, { modelPath: event.target.value })} /><button onClick={() => void chooseFile((path) => updateModel(selected.id, { modelPath: path }))}>{t("Выбрать…")}</button></div><small>{t("Выберите первый файл модели. Части split GGUF должны лежать рядом.")}</small></label>
      <label>{t("Projector для изображений — необязательно")}<div className="setup-path"><input aria-label={t("Проектор GGUF")} value={selected.mmprojPath} onChange={(event) => updateModel(selected.id, { mmprojPath: event.target.value })} /><button onClick={() => void chooseFile((path) => updateModel(selected.id, { mmprojPath: path }))}>{t("Выбрать…")}</button></div><small>{t("Нужен, чтобы эта модель понимала изображения. Без него остаётся текстовый чат.")}</small></label>
      <ModelProfileEditor profile={selected} inspection={draftModels?.models.find(m=>m.id===selected.id)?.inspection??setup.models.find(m=>m.id===selected.id)?.inspection} features={setup.backendFeatures} onChange={patch=>updateModel(selected.id,patch)}/>
      <AuthorConfigurations profile={selected} inspection={draftModels?.models.find(m=>m.id===selected.id)?.inspection??setup.models.find(m=>m.id===selected.id)?.inspection} onChange={patch=>updateModel(selected.id,patch)}/>
      <details className="profile-section"><summary>{ru?'Управление моделью':'Model management'}</summary><p>{ru?'Сохранение не останавливает backend. Применение выполняет отдельную безопасную перезагрузку llama-server.':'Saving leaves the backend running. Apply performs a separate safe llama-server restart.'}</p><button disabled={!activeId||saving||applying} onClick={()=>{setApplyError('');setApplyDialog(true);}}>{ru?'Применить и перезагрузить':'Apply and restart'}</button>{activeRuntime?.rolledBack&&activeRuntime.profileConfiguration?.id===selected.id&&<button onClick={()=>updateModel(selected.id,activeRuntime.profileConfiguration!)}>{ru?'Восстановить рабочую конфигурацию в черновике':'Restore working configuration to draft'}</button>}<details><summary>{ru?'Активная конфигурация и диагностика':'Active configuration and diagnostics'}</summary><pre>{JSON.stringify({status:activeRuntime?.status,activeProfile:activeRuntime?.profileConfiguration,arguments:activeRuntime?.launchArguments,observedPlacement:activeRuntime?.placement},null,2)}</pre>{activeRuntime?.diagnosticsHistory?.map((entry,i)=><p key={i}>{entry.at} · {entry.message}</p>)}</details></details>
      <small>{t('MTP Auto/On/Off: используйте переключатель MTP рядом с контекстом. Применение требует отдельного подтверждения перезагрузки.')}</small>
    </fieldset>}
    <small>{t("Настройки: ")}{setup.configPath}<br />{t("Данные приложения: ")}{setup.dataDirectory}{t(". Пути с пробелами и ~/ поддерживаются.")}</small>
    {message && <p role="status" className="runtime-setup-message">{localizeMessage(message)}</p>}
    {applyDialog&&selected&&<ReloadDialog title={ru?'Настройки модели':'Model settings'} busy={applying||saving} error={applyError} onCancel={()=>setApplyDialog(false)} onApply={()=>{void(async()=>{setApplying(true);setApplyError('');try{const saved=await save(true);if(!saved||!activeId)return;const result=await window.localAi.runtime.control({action:'restart',conversationId:activeId,modelId:selected.id});useAppStore.setState({settings:result,conversations:await window.localAi.conversations.list()});await useAppStore.getState().refreshRuntime();setApplyDialog(false);}catch(e){setApplyError(localizeMessage(String(e).replace(/^Error: Error invoking remote method '[^']+': (Error: )?/,'')));await useAppStore.getState().refreshRuntimeStatus().catch(()=>undefined);}finally{setApplying(false);}})();}}><p>{ru?'Активная модель':'Active model'}: {activeRuntime?.profileConfiguration?.displayName??activeRuntime?.modelId??'—'}<br/>{ru?'Целевая модель':'Target model'}: {selected.displayName}</p><p>GPU layers: {activeRuntime?.profileConfiguration?.gpuLayers??'—'} → {selected.advanced?.mode==='automatic'?'auto':selected.gpuLayers??config.gpuLayers}<br/>{ru?'Контекст':'Context'}: {activeRuntime?.contextWindow?`${activeRuntime.contextWindow/1024}K`:'—'} {activeRuntime?.kvCacheType??''} → {(selected.defaults?.contextWindow??(activeRuntime?.modelId===selected.id?activeRuntime?.contextWindow:undefined)??conversation?.contextWindow??32768)/1024}K {selected.defaults?.kvCacheType??(activeRuntime?.modelId===selected.id?activeRuntime?.kvCacheType:undefined)??conversation?.llamaKvCacheType??'f16'}</p><ModelLaunchDiff active={activeRuntime?.profileConfiguration} pending={selected}/><p>{ru?'GGUF и backend проверяются до остановки предыдущей модели.':'GGUF and backend are checked before stopping the previous model.'}</p></ReloadDialog>}
    <footer><button disabled={saving || (Boolean(inputPath.trim()) && executableStatus !== 'valid')} onClick={() => void save()}>{saving ? t("Сохранение…") : t("Сохранить изменения")}</button></footer>
  </section></div>;
}
