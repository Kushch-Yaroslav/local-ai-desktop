import { RegionChip } from './VisualDebugPanel';
import type { VisualRegion } from '../../shared/visual-debugging';
import { AgentControls, LoopWarning } from './AgentControls';
import { useLocale } from '../use-locale';
import { t, tr } from '../../shared/locale';
import { conversationRuntimeReady } from '../../shared/model-selection';
import { localizeProjectLabel } from '../../shared/localization';
import { useShallow } from 'zustand/react/shallow';
import { File, Folder, Paperclip, Send, Square, X } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useAppStore } from '../store/app-store';
import { ContextUsage } from './ContextUsage';
import { CurrentAgentStatus } from './AgentStatusPanel';
import { TaskSelector } from './TaskSelector';
import { ControlHelp } from './ControlHelp';
import type { ProjectReference, ProjectSuggestion } from '../../shared/types';
import { removeProjectReferenceQuery } from '../../shared/project-references';

const isImageFile = (file: File): boolean => file.type.startsWith('image/') || /\.(png|jpe?g|webp)$/i.test(file.name);

export function Composer() {
  useLocale();
  const [value, setValue] = useState(''); const [files, setFiles] = useState<File[]>([]); const [projectReferences, setProjectReferences] = useState<ProjectReference[]>([]); const [suggestions, setSuggestions] = useState<ProjectSuggestion[]>([]); const [referenceQuery, setReferenceQuery] = useState<{ start: number; text: string } | null>(null); const [activeSuggestion, setActiveSuggestion] = useState(0); const [attachmentError, setAttachmentError] = useState<string | null>(null); const ref = useRef<HTMLTextAreaElement>(null); const inputRef = useRef<HTMLInputElement>(null);
  const [regionReferences,setRegionReferences]=useState<VisualRegion[]>([]);
  const manualHeight = useRef<number | null>(null); const resizeHandle = useRef(false);
  const { sendMessage, steer, steeringStatus, stop, isGenerating, generationConversationId, conversations, activeId, settings, models } = useAppStore(useShallow((state) => ({ sendMessage: state.sendMessage, steer: state.steer, steeringStatus: state.steeringStatus, stop: state.stop, isGenerating: state.isGenerating, generationConversationId: state.generationConversationId, conversations: state.conversations, activeId: state.activeId, settings: state.settings, models:state.models })));
  const chat = conversations.find((item) => item.id === activeId);
  useEffect(()=>{setRegionReferences([]);const listener=(event:Event)=>{const detail=(event as CustomEvent<{conversationId:string;regions:VisualRegion[]}>).detail;if(detail.conversationId===activeId)setRegionReferences(old=>[...old,...detail.regions.filter(r=>!old.some(o=>o.id===r.id))].slice(0,12));};window.addEventListener('visual-region-draft',listener);return()=>window.removeEventListener('visual-region-draft',listener);},[activeId,chat?.primaryProjectId]);

  useEffect(()=>{const listener=(event:Event)=>{const detail=(event as CustomEvent<{id:string;document:{regions:VisualRegion[]}}>).detail;if(detail.id===activeId)setRegionReferences(old=>old.filter(r=>detail.document.regions.some(live=>live.id===r.id)));};window.addEventListener('visual-document-updated',listener);return()=>window.removeEventListener('visual-document-updated',listener);},[activeId]);

  // A newly drawn manual area belongs to the current draft, even without a
  // separate transfer click. It remains visible/removable and never auto-sends.
  useEffect(()=>{let alive=true;const seen=new Set<string>();const off=window.localAi.liveBrowser?.onEvent(event=>{
    const feedback=event.state.visualFeedback;
    if(event.state.conversationId!==activeId||feedback?.kind!=='saved'||!feedback.regionId||seen.has(feedback.regionId)||useAppStore.getState().isGenerating)return;
    seen.add(feedback.regionId);
    void window.localAi.visualDebug.document(activeId!).then(document=>{const region=document.regions.find(r=>r.id===feedback.regionId);
      if(alive&&region&&region.projectId===chat?.primaryProjectId)setRegionReferences(old=>old.some(r=>r.id===region.id)?old:[...old,region].slice(0,12));
    }).catch(()=>undefined);
  });return()=>{alive=false;off?.();};},[activeId,chat?.primaryProjectId]);

  const runtime=settings?.llamaRuntime;
  const modelReady = conversationRuntimeReady(chat,runtime,models.find(model=>model.id===chat?.modelId));
  const projectEnabled = Boolean(chat?.workingDirectory);
  const resetHeight = () => { const textarea = ref.current; if (!textarea) return; manualHeight.current = null; textarea.style.height = ''; textarea.style.overflowY = 'hidden'; };
  const addFiles = useCallback((incoming: File[]) => {
    let imageCount = files.filter(isImageFile).length; const next = [...files];
    let rejected = false;
    for (const file of incoming) { if (isImageFile(file)) { if (imageCount >= 10) { rejected = true; continue; } imageCount += 1; } next.push(file); }
    setAttachmentError(rejected ? t("Максимум 10 изображений на сообщение") : null);
    setFiles(next);
  }, [files]);
  const [steeringSubmitting, setSteeringSubmitting] = useState(false);
  const pausePhase = useAppStore(state => state.pausePhase);
  const stopReason = useAppStore(state => state.agentPlan?.taskMemory?.stop_reason);
  const pauseOperation = useAppStore(state => state.toolActivities.findLast(activity => activity.state === 'running')?.label);
  const [pauseRequested, setPauseRequested] = useState(false);
  useEffect(() => { if (!isGenerating) setPauseRequested(false); }, [isGenerating]);
  const submit = () => {
    if (isGenerating && chat?.mode === 'agent' && value.trim() && !files.length && !projectReferences.length && !regionReferences.length && !steeringSubmitting) {
      const instruction = value;
      setSteeringSubmitting(true);
      void steer(instruction).then((accepted) => { if (accepted) setValue((draft) => draft === instruction ? '' : draft); }).finally(() => setSteeringSubmitting(false));
      return;
    }
    if (modelReady && !generationConversationId && (value.trim() || files.length || regionReferences.length)) { void sendMessage(value.trim()||t('Разбери выбранные области и уточни требуемое изменение. Используй выделения как контекст, а не как доказательство дефекта.'), files, projectReferences, regionReferences); setRegionReferences([]); setValue(''); setFiles([]); setProjectReferences([]); setSuggestions([]); setReferenceQuery(null); setAttachmentError(null); }
  };
  useEffect(() => {
    if (!projectEnabled || !activeId || !referenceQuery) { setSuggestions([]); return; }
    let cancelled = false;
    const timer = window.setTimeout(() => { void window.localAi.projects.search(activeId, referenceQuery.text).then((results) => { if (!cancelled) { setSuggestions(results); setActiveSuggestion(0); } }).catch(() => { if (!cancelled) setSuggestions([]); }); }, 80);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [activeId, projectEnabled, referenceQuery]);
  useEffect(() => { if (!projectEnabled) { setReferenceQuery(null); setSuggestions([]); } }, [projectEnabled]);
  const updateValue = (next: string, cursor: number) => {
    setValue(next);
    if (!projectEnabled) { setReferenceQuery(null); return; }
    const beforeCursor = next.slice(0, cursor); const match = /(?:^|\s)@([^\s@]*)$/.exec(beforeCursor);
    setReferenceQuery(match ? { start: cursor - match[1].length - 1, text: match[1] } : null);
  };
  const selectSuggestion = (suggestion: ProjectSuggestion) => {
    if (!referenceQuery) return;
    const end = ref.current?.selectionStart ?? referenceQuery.start + referenceQuery.text.length + 1;
    const next = removeProjectReferenceQuery(value, referenceQuery.start, end);
    setValue(next.value); setProjectReferences((items) => [...items, { ...suggestion, id: crypto.randomUUID() }]); setReferenceQuery(null); setSuggestions([]);
    window.requestAnimationFrame(() => { ref.current?.focus(); ref.current?.setSelectionRange(next.cursor, next.cursor); });
  };
  useLayoutEffect(() => {
    const textarea = ref.current; if (!textarea) return;
    if (!value) { resetHeight(); return; }
    if (manualHeight.current !== null) return;
    textarea.style.height = '0px';
    const height = Math.min(textarea.scrollHeight, 184);
    textarea.style.height = `${height}px`;
    textarea.style.overflowY = textarea.scrollHeight > 184 ? 'auto' : 'hidden';
  }, [value]);
  useLayoutEffect(() => { ref.current?.focus(); }, []);
  useEffect(() => {
    const element = ref.current; const onPaste = (event: ClipboardEvent) => { const images = [...(event.clipboardData?.files ?? [])].filter(isImageFile); if (images.length) { event.preventDefault(); addFiles(images); } };
    element?.addEventListener('paste', onPaste); return () => element?.removeEventListener('paste', onPaste);
  }, [addFiles]);
  const startResize = (event: React.PointerEvent<HTMLTextAreaElement>) => {
    const { right, bottom } = event.currentTarget.getBoundingClientRect();
    resizeHandle.current = event.clientX > right - 28 && event.clientY > bottom - 28;
  };
  const finishResize = () => {
    if (!resizeHandle.current || !ref.current) return;
    resizeHandle.current = false;
    window.requestAnimationFrame(() => { if (ref.current) { manualHeight.current = ref.current.offsetHeight; ref.current.style.overflowY = 'auto'; } });
  };
  const readinessMessage=runtime?.status==='starting'||runtime?.status==='switching'?t('Модель загружается. Отправка включится автоматически, когда runtime будет готов.'):runtime?.status==='ready'&&chat?.modelId&&runtime.modelId!==chat.modelId?t('Для этого чата нужна другая конфигурация модели. Выберите её в панели модели и загрузите.'):runtime?.status==='ready'&&runtime.modelId===chat?.modelId?t('Настройки этого чата отличаются от активной модели. Выберите активные параметры или загрузите выбранные.'):runtime?.status==='ready'?t('Выберите модель, совместимую с активным runtime, или загрузите выбранную конфигурацию.'):t('Выберите модель и загрузите её перед отправкой.');
  return <div className="composer-wrap">{chat?.mode === 'agent' && !isGenerating && <><TaskSelector />{pausePhase === 'Paused' && <><span role="status">{t(stopReason === 'loop_detected' || stopReason === 'repeated_tool_failure' ? 'Агент остановлен: обнаружено повторение действий' : 'Остановлено')}</span><button type="button" disabled={!modelReady || Boolean(generationConversationId)} onClick={() => void sendMessage(t('Продолжить задачу'), [], [], [])}>{t('Продолжить задачу')}</button></>}</>}<CurrentAgentStatus /><LoopWarning />{!modelReady&&<p className="model-readiness-hint" role="status">{readinessMessage}</p>}{chat?.mode === 'agent' && <div className="composer-toolbar"><AgentControls />{isGenerating && <span className="task-running-indicator" role="status">{pausePhase ? t('Останавливаю') : t('Уточнение текущей задачи')}{pauseRequested && pauseOperation ? ` · ${pauseOperation}` : ''}</span>}</div>}<div className="composer" onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); addFiles([...event.dataTransfer.files]); }}>
    {regionReferences.length>0&&<div className="attachment-draft visual-composer-references"><small>{t('Области добавлены. Напишите задачу и отправьте сообщение агенту.')}</small>{regionReferences.map(region=><RegionChip key={region.id} region={region} onRemove={()=>setRegionReferences(rs=>rs.filter(r=>r.id!==region.id))}/>)}</div>}
    {(files.length > 0 || projectReferences.length > 0) && <div className="attachment-draft">{projectReferences.map((reference) => <ProjectReferenceChip key={reference.id} reference={reference} onRemove={() => setProjectReferences((items) => items.filter((item) => item.id !== reference.id))} />)}{files.map((file, index) => <DraftAttachment key={`${file.name}-${index}`} file={file} index={isImageFile(file) ? files.slice(0, index + 1).filter(isImageFile).length - 1 : index} onRemove={() => { setFiles((items) => items.filter((_, itemIndex) => itemIndex !== index)); setAttachmentError(null); }} />)}</div>}
    <input ref={inputRef} className="attachment-input" type="file" multiple accept=".png,.jpg,.jpeg,.webp,.txt,.md,.json,.csv,.log,.js,.ts,.jsx,.tsx,.html,.css,.yaml,.yml,.xml,.docx,.xlsx,.xls,.pdf" onChange={(event) => { addFiles([...(event.target.files ?? [])]); event.currentTarget.value = ''; }} />
    {isGenerating && chat?.mode === 'agent' && <button className="steering-button" type="button" disabled={!value.trim() || files.length > 0 || projectReferences.length > 0 || regionReferences.length>0 || steeringSubmitting} onClick={submit} title={steeringStatus === 'applied' ? t("Предыдущее уточнение передано модели") : steeringStatus === 'accepted' ? t("Предыдущее уточнение принято; ожидает границы хода") : t("Отправить уточнение без остановки Agent")}>{t("Уточнить")}</button>}

    <button className="attach-button" type="button" disabled={isGenerating} title={t("Прикрепить файлы")} onClick={() => inputRef.current?.click()}><Paperclip size={18} /></button>
    <textarea ref={ref} value={value} placeholder={t("Напишите сообщение…")} rows={1} onPointerDown={startResize} onPointerUp={finishResize} onChange={(event) => updateValue(event.target.value, event.target.selectionStart)} onKeyDown={(event) => { if (suggestions.length) { if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setActiveSuggestion((index) => (index + (event.key === 'ArrowDown' ? 1 : suggestions.length - 1)) % suggestions.length); return; } if ((event.key === 'Enter' || event.key === 'Tab') && suggestions[activeSuggestion]) { event.preventDefault(); selectSuggestion(suggestions[activeSuggestion]); return; } if (event.key === 'Escape') { event.preventDefault(); setReferenceQuery(null); setSuggestions([]); return; } } if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); submit(); } }} />
    {suggestions.length > 0 && <div className="project-reference-menu" role="listbox" aria-label={t("Файлы проекта")}>{suggestions.map((suggestion, index) => <button type="button" role="option" aria-selected={index === activeSuggestion} className={index === activeSuggestion ? 'active' : ''} key={suggestion.id} onMouseDown={(event) => { event.preventDefault(); selectSuggestion(suggestion); }} onMouseEnter={() => setActiveSuggestion(index)}>{suggestion.kind === 'folder' ? <Folder size={15} /> : <File size={15} />}<span>{suggestion.relativePath}</span><small className={`project-badge project-${suggestion.projectSlot}`}>{localizeProjectLabel(suggestion.projectLabel)}</small></button>)}</div>}
    <ContextUsage />{isGenerating ? <><button className="send-button stop" aria-label={t('Остановить')} disabled={pauseRequested || Boolean(pausePhase && pausePhase !== 'Paused')} onClick={() => { setPauseRequested(true); void stop().finally(() => setPauseRequested(false)); }} title={t("Остановить")}><Square size={16} fill="currentColor" /></button><ControlHelp label={t('Остановить')}>{t('Останавливает работу и сохраняет контрольную точку. Продолжить задачу можно следующим сообщением.')}</ControlHelp></> : <><button className="send-button" aria-label={pausePhase === 'Paused' ? t('Возобновить задачу') : t('Отправить')} disabled={!modelReady || Boolean(generationConversationId) || (!value.trim() && files.length === 0 && regionReferences.length===0)} onClick={submit} title={generationConversationId ? t("Генерация выполняется в другом чате") : t("Отправить")}><Send size={18} /></button><ControlHelp label={pausePhase === 'Paused' ? t('Возобновить задачу') : t('Отправить')}>{pausePhase === 'Paused' ? t('Следующее сообщение продолжит выбранную задачу из сохранённой контрольной точки, включая результаты уже завершённых инструментов.') : t('Нажмите Enter, чтобы отправить. Shift+Enter добавляет новую строку; файлы можно вставить или перетащить.')}</ControlHelp></>}
  </div>{attachmentError && <p className="attachment-error" role="status">{attachmentError}</p>}<p>{t("Enter — отправить · Shift+Enter — новая строка · вставьте или перетащите файлы")}</p></div>;
}

function ProjectReferenceChip({ reference, onRemove }: { reference: ProjectReference; onRemove: () => void }) {
  useLocale();
  return <div className={`project-reference-chip project-${reference.projectSlot}`}>{reference.kind === 'folder' ? <Folder size={13} /> : <File size={13} />}<span>{reference.relativePath}</span><small>{localizeProjectLabel(reference.projectLabel)}</small><button type="button" title={t("Удалить ссылку на проект")} onClick={onRemove}><X size={12} /></button></div>;
}

function DraftAttachment({ file, index, onRemove }: { file: File; index: number; onRemove: () => void }) {
  useLocale();
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => { if (!isImageFile(file)) return; const next = URL.createObjectURL(file); setUrl(next); return () => URL.revokeObjectURL(next); }, [file]);
  return <div className={`attachment-draft-item ${url ? 'image' : ''}`}>{url ? <img src={url} alt={tr`Изображение ${index + 1}`} /> : <span className="attachment-file-icon">{file.name.split('.').at(-1)?.toUpperCase() ?? 'FILE'}</span>}<span className="attachment-number">{url ? index + 1 : file.name}</span><button type="button" title={t("Удалить вложение")} onClick={onRemove}><X size={13} /></button></div>;
}
