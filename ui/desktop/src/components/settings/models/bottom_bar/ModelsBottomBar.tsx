import MtpQuickControl from './MtpQuickControl';
import VisionQuickControl from './VisionQuickControl';
import { isLocalModel, useModelCategory, rememberModelCategory } from './modelCategories';
// Modified for Local AI Desktop: unified Goose provider/model selection and owned GGUF actions.
import { Bot, Check, LoaderCircle, Play, Square, Settings2, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useModelAndProvider } from '../../../ModelAndProviderContext';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '../../../ui/dropdown-menu';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../../../ui/dialog';
import { ModelSettingsPanel } from '../../localInference/ModelSettingsPanel';
import { acpListProviderDetails } from '../../../../acp/providers';
import { fetchModelsForProviders, fetchModelReasoning, type default as Model } from '../modelInterface';
import { getModelDisplayName, getPredefinedModelsFromEnv } from '../predefinedModelsUtils';
import { defineMessages, useIntl } from '../../../../i18n';
import { ggufMessages, formatGgufError } from '../../../../ggufMessages';
import { useManagedGgufState } from '../../../../hooks/useManagedGgufState';
import { hasBusyManagedSession } from '../../../../contextDiscovery/sessionActivity';
import { acpChatSessionStore } from '../../../../acp/chatSessionStore';
import { registerLocalProfile } from '../../../../acp/managedLocalProfiles';
import type { ProfileEntry } from '../../../../ggufTypes';
import type { Message } from '../../../../types/message';
import type { View, ViewOptions } from '../../../../utils/navigationUtils';
import { trackModelChanged } from '../../../../utils/analytics';

const messages = defineMessages({
  // Keep upstream translation catalog entries while removing their UI sections.
  changeModel: { id: 'modelsBottomBar.changeModel', defaultMessage: 'Change Model' },
  currentModel: { id: 'modelsBottomBar.currentModel', defaultMessage: 'Current model' },
  localModelSettings: { id: 'modelsBottomBar.localModelSettings', defaultMessage: 'Local Model Settings' },
  localModelSettingsTitle: { id: 'modelsBottomBar.localModelSettingsTitle', defaultMessage: 'Local Model Settings — {modelName}' },
  recentModels: { id: 'modelsBottomBar.recentModels', defaultMessage: 'Recent' },
  resolvedModel: { id: 'modelsBottomBar.resolvedModel', defaultMessage: 'Resolved model' },
  category: { id: 'modelsBottomBar.category', defaultMessage: 'Model category' },
  local: { id: 'modelsBottomBar.local', defaultMessage: 'Local' },
  api: { id: 'modelsBottomBar.api', defaultMessage: 'API / Cloud' },
  all: { id: 'modelsBottomBar.all', defaultMessage: 'All' },
  select: { id: 'modelsBottomBar.selectModel', defaultMessage: 'Select Model' },
  loading: { id: 'modelsBottomBar.loadingModel', defaultMessage: 'Loading model...' },
  search: { id: 'modelsBottomBar.search', defaultMessage: 'Search models' },
  empty: { id: 'modelsBottomBar.empty', defaultMessage: 'No matching models' },
  selected: { id: 'modelsBottomBar.selected', defaultMessage: 'Selected for this chat' },
  providers: { id: 'modelsBottomBar.providers', defaultMessage: 'Models and providers' },
});
interface Props {
  sessionId: string | null;
  dropdownRef: React.RefObject<HTMLDivElement>;
  setView: (view: View, options?: ViewOptions) => void;
  sessionModel?: string | null;
  sessionProvider?: string | null;
  latestInference?: Message['metadata']['inference'] | null;
  onModelChanged: (override: { model: string; provider: string }) => void;
  sessionLoaded?: boolean;
}
export default function ModelsBottomBar({ sessionId, dropdownRef, setView, sessionModel, sessionProvider, onModelChanged, sessionLoaded }: Props) {
  const intl = useIntl();
  const { currentModel, currentProvider, changeModel } = useModelAndProvider();
  const model = sessionModel ?? currentModel;
  const provider = sessionProvider ?? currentProvider;
  const runtime = useManagedGgufState();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const categoryChoice = useModelCategory();
  const [profiles, setProfiles] = useState<ProfileEntry[]>([]);
  const [models, setModels] = useState<Model[]>([]);
  const [loading, setLoading] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>();
  const [nativeSettings, setNativeSettings] = useState<string | null>(null);
  const pendingSettings = useRef<(() => void) | null>(null);
  const search = useRef<HTMLInputElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const t = (key: keyof typeof ggufMessages) => intl.formatMessage(ggufMessages[key]);
  useEffect(() => {
    let alive = true;
    const refresh = () => { void window.electron.ggufList().then((value) => { if (alive) setProfiles(value); }).catch((e) => { if (alive) setError(e); }); };
    refresh(); window.electron.on('gguf-profiles-changed', refresh);
    return () => { alive = false; window.electron.off('gguf-profiles-changed', refresh); };
  }, []);
  useEffect(() => {
    if (!open) return;
    let alive = true;
    setLoading(true);
    void acpListProviderDetails().then((all) => fetchModelsForProviders(all.filter((p) => p.is_configured)))
      .then((results) => { if (alive) setModels([...getPredefinedModelsFromEnv(), ...results.flatMap((result) => result.models ?? [])]); })
      .catch((e) => { if (alive) setError(e); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [open]);
  const external = profiles.filter((entry) => entry.profile.backend !== 'native');
  const managedProviders = new Set(external.map((entry) => entry.profile.providerId).filter((value): value is string => Boolean(value)));
  const seen = new Set<string>();
  const ordinary = models.filter((entry) => {
    const key = JSON.stringify([entry.provider, entry.name]);
    if (managedProviders.has(entry.provider) || seen.has(key)) return false;
    seen.add(key); return true;
  });
  if (provider && model && !managedProviders.has(provider) && !ordinary.some((entry) => entry.provider === provider && entry.name === model)) ordinary.unshift({ name: model, provider });
  const matches = (name: string, owner = '') => `${name} ${owner}`.toLocaleLowerCase().includes(query.toLocaleLowerCase());
  const choose = async (entry: Model, profile?: ProfileEntry['profile']) => {
    setPending(true); setError(undefined);
    try {
      let selected = entry;
      if (profile && !profile.providerId) {
        const registered = await registerLocalProfile(profile);
        selected = { ...entry, provider: registered.providerId! };
      }
      const reasoning = selected.reasoning ?? await fetchModelReasoning(selected.provider, selected.name);
      const ok = await changeModel(sessionId, { ...selected, reasoning: reasoning ?? undefined });
      if (ok) { onModelChanged({ model: selected.name, provider: selected.provider }); trackModelChanged(selected.provider, selected.name); setOpen(false); }
    } catch (e) { setError(e); } finally { setPending(false); }
  };
  const act = async (operation: () => Promise<unknown>) => {
    setError(undefined); setPending(true);
    try {
      if (hasBusyManagedSession(acpChatSessionStore.getActivitySnapshots(), profiles)) throw Error('GGUF:runtimeBusy:');
      await operation();
    } catch (e) { setError(e); } finally { setPending(false); }
  };
  const openSettings = (operation: () => void) => { pendingSettings.current = operation; setOpen(false); };
  const selectedProfile = external.find((entry) => entry.profile.providerId === provider);
  const triggerLabel = sessionId && !sessionLoaded ? intl.formatMessage(messages.loading) : selectedProfile?.profile.name ?? (model ? getModelDisplayName(model) : intl.formatMessage(messages.select));
  const busy = runtime.phase === 'starting' || runtime.phase === 'validating' || runtime.phase === 'stopping';
  const category = categoryChoice ?? (provider && isLocalModel(provider, managedProviders) ? 'local' : 'api');
  const categoryMatches = (local: boolean) => category === 'all' || (category === 'local') === local;
  const externalRows = external.filter((entry) => categoryMatches(true) && matches(entry.profile.name));
  const ordinaryRows = ordinary.filter((entry) => categoryMatches(isLocalModel(entry.provider, managedProviders)) && matches(entry.alias ?? entry.name, entry.provider));
  return <div ref={dropdownRef} className="flex min-w-0 items-center">
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger type="button" aria-label={intl.formatMessage(messages.select)} className="flex max-w-[200px] items-center gap-1 truncate text-xs text-text-primary/70 hover:text-text-primary focus-visible:outline focus-visible:outline-2">
        <Bot className="h-4 w-4 shrink-0" /><span className="truncate">{triggerLabel}</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent ref={content} side="top" align="start" collisionPadding={12} className="w-[min(22rem,calc(100vw-1.5rem))]"
        onCloseAutoFocus={(event) => { if (pendingSettings.current) { event.preventDefault(); const action = pendingSettings.current; pendingSettings.current = null; action(); } }}>
        <div role="group" aria-label={intl.formatMessage(messages.category)} className="mb-1 grid grid-cols-3 gap-1 rounded-lg bg-background-secondary p-0.5">
          {(['local','api','all'] as const).map((value) => <DropdownMenuItem key={value} asChild onSelect={(event) => { event.preventDefault(); rememberModelCategory(value); }} className="justify-center p-0"><button role="button" type="button" aria-pressed={category === value} className={`w-full rounded-md px-2 py-1 text-xs focus-visible:outline focus-visible:outline-2 ${category === value ? 'bg-background-primary text-text-primary' : 'text-text-secondary'}`}>{intl.formatMessage(messages[value])}</button></DropdownMenuItem>)}
        </div>
        <input ref={search} autoFocus aria-label={intl.formatMessage(messages.search)} placeholder={intl.formatMessage(messages.search)} value={query} onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'ArrowDown') { event.preventDefault(); content.current?.querySelector<HTMLElement>('[role="menuitem"]:not([data-disabled])')?.focus(); } if (event.key !== 'Escape') event.stopPropagation(); }}
          className="mb-1 w-full rounded-md border border-border-primary bg-background-primary px-2 py-1.5 text-xs" />
        <div className="max-h-[min(24rem,55vh)] overflow-y-auto space-y-1" aria-label={intl.formatMessage(messages.select)}>
          {externalRows.map((entry) => {
            const p = entry.profile;
            const rowName = external.some((other) => other.profile.id !== p.id && other.profile.name === p.name) ? `${p.name} · ${p.id?.slice(0, 6)}` : p.name;
            const selected = !!p.providerId && p.providerId === provider;
            const owned = runtime.profileId === p.id;
            const loaded = owned && runtime.phase === 'ready';
            const starting = owned && (runtime.phase === 'starting' || runtime.phase === 'validating');
            const phase = owned ? runtime.phase : 'idle';
            const status = !entry.available ? `${loaded ? t('ready') + ' · ' : ''}${t('missing')}` : t(phase);
            return <div key={p.id} role="group" aria-label={rowName} className={`flex items-center rounded-lg border p-0.5 ${selected ? 'border-purple-500' : loaded ? 'border-green-500' : 'border-border-primary'}`}>
              <DropdownMenuItem disabled={pending || !entry.available} onSelect={(event) => { event.preventDefault(); void choose({ name: 'local-gguf', provider: p.providerId ?? '' }, p); }} className="min-w-0 flex-1 cursor-pointer">
                <span role="status" aria-label={status} title={entry.error ? formatGgufError(intl, entry.error) : status} className={`h-1.5 w-1.5 shrink-0 rounded-full ${loaded ? 'bg-green-500' : starting ? 'bg-blue-500 animate-pulse motion-reduce:animate-none' : phase === 'failed' ? 'bg-text-danger' : 'bg-text-tertiary'}`} />
                <span className="truncate" title={`${p.name} · ${p.id?.slice(0, 8)}`}>{rowName}</span>
                {selected && <Check aria-label={intl.formatMessage(messages.selected)} className="h-3 w-3 shrink-0 text-purple-500" />}
              </DropdownMenuItem>
              <DropdownMenuItem aria-label={`${starting ? t('cancelLoad') : loaded ? t('unload') : t('load')}: ${rowName}`} title={starting ? t('cancelLoad') : loaded ? t('unload') : t('load')} disabled={(pending && !starting) || (!entry.available && !loaded && !starting) || (busy && !starting)}
                onSelect={(event) => { event.preventDefault(); void act(() => starting || loaded ? window.electron.ggufStop() : window.electron.ggufStart(p.id!)); }} className={`cursor-pointer p-1.5 ${loaded ? 'text-text-danger' : ''}`}>
                {starting ? <X className="h-3.5 w-3.5" /> : loaded ? <Square className="h-3.5 w-3.5" /> : busy && owned ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
              </DropdownMenuItem>
              <MtpQuickControl profile={p} runtime={runtime} act={act}/>
              <VisionQuickControl profile={p} runtime={runtime} act={act}/>
              <DropdownMenuItem aria-label={`${t('modelSettings')}: ${rowName}`} title={t('modelSettings')} onSelect={() => openSettings(() => setView('settings', { section: 'local-inference', ggufProfileId: p.id }))} className="cursor-pointer p-1.5"><Settings2 className="h-3.5 w-3.5" /></DropdownMenuItem>
            </div>;
          })}
          {ordinaryRows.map((entry) => {
            const selected = entry.provider === provider && entry.name === model;
            const savedNative = profiles.find((saved) => saved.profile.backend === 'native' && saved.profile.model === entry.name && saved.profile.providerId === entry.provider)?.profile;
            return <div key={JSON.stringify([entry.provider, entry.name])} role="group" aria-label={entry.alias ?? entry.name} className={`flex items-center rounded-lg border p-0.5 ${selected ? 'border-purple-500' : 'border-border-primary'}`}>
              <DropdownMenuItem disabled={pending} onSelect={(event) => { event.preventDefault(); void choose(entry); }} className="min-w-0 flex-1 cursor-pointer"><span className="min-w-0 truncate">{entry.alias ?? getModelDisplayName(entry.name)}<span className="ml-1 text-[10px] text-text-secondary">{entry.provider}</span></span>{selected && <Check aria-label={intl.formatMessage(messages.selected)} className="h-3 w-3 text-purple-500" />}</DropdownMenuItem>
              {entry.provider === 'local' && <DropdownMenuItem aria-label={`${t('modelSettings')}: ${entry.alias ?? entry.name}`} onSelect={() => openSettings(() => savedNative ? setView('settings', { section: 'local-inference', ggufProfileId: savedNative.id }) : setNativeSettings(entry.name))} className="p-1.5"><Settings2 className="h-3.5 w-3.5" /></DropdownMenuItem>}
            </div>;
          })}
          {!loading && externalRows.length === 0 && ordinaryRows.length === 0 && <p className="p-2 text-xs text-text-secondary">{intl.formatMessage(messages.empty)}</p>}
        </div>
        {loading && <p role="status" className="p-1 text-xs text-text-secondary">{intl.formatMessage(messages.loading)}</p>}
        {(error || runtime.phase === 'failed' && runtime.error) && <p role="alert" className="p-2 text-xs text-text-danger break-words">{formatGgufError(intl, error ?? runtime.error)}</p>}
        {runtime.logPath && <details className="p-2 text-xs text-text-secondary"><summary className="cursor-pointer">{t('runtime')}</summary><pre className="max-h-28 overflow-auto whitespace-pre-wrap break-all">{runtime.args?.join(' ')}{'\n'}{runtime.logPath}</pre></details>}
        <DropdownMenuItem onSelect={() => openSettings(() => setView('settings', { section: 'models' }))} className="text-xs">{intl.formatMessage(messages.providers)}</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
    <Dialog open={nativeSettings !== null} onOpenChange={(value) => { if (!value) setNativeSettings(null); }}><DialogContent><DialogHeader><DialogTitle>{t('modelSettings')}</DialogTitle></DialogHeader>{nativeSettings && <ModelSettingsPanel modelId={nativeSettings} />}</DialogContent></Dialog>
  </div>;
}
