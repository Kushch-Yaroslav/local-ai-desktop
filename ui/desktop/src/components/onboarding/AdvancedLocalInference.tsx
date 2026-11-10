import PlacementSettings from './PlacementSettings';
import SpeculativeSettings from './SpeculativeSettings';
// Local AI Desktop: reusable model manager built with Goose components and catalogs.
import { useEffect, useRef, useState, useCallback } from 'react';
import type { GgufProfile, ProfileEntry, RuntimeProbe } from '../../ggufTypes';
import { registerLocalProfile, deleteLocalProfile } from '../../acp/managedLocalProfiles';
import { useIntl } from '../../i18n';
import { ggufMessages as messages, formatGgufError } from '../../ggufMessages';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '../ui/dialog';
import { useManagedGgufState } from '../../hooks/useManagedGgufState';
import { useModelAndProvider } from '../ModelAndProviderContext';
const blank = (): GgufProfile => ({
  name: '',
  model: '',
  executable: '',
  backend: 'external',
  gpuLayers: 999,
  context: 8192,
});
const flags: Partial<Record<keyof GgufProfile, string>> = {
  projector: '--mmproj',
  projectorCpu: '--no-mmproj-offload',
  cacheK: '--cache-type-k',
  cacheV: '--cache-type-v',
  flashAttention: '--flash-attn',
  parallel: '--parallel',
  draftCacheK: '--cache-type-k-draft',
  draftCacheV: '--cache-type-v-draft',
  draftUbatch: '--spec-draft-n-ubatch',
  threads: '--threads',
  batch: '--batch-size',
  ubatch: '--ubatch-size',
  cpuMoe: '--cpu-moe',
  nCpuMoe: '--n-cpu-moe',
  tensorOverride: '--override-tensor',
  moeCacheMiB: '--moe-cache-mib',
  jinja: '--jinja',
  chatTemplate: '--chat-template',
};
export default function AdvancedLocalInference({
  onConfigured,
  initialProfileId,
}: {
  initialProfileId?: string;
  onConfigured?: (provider: string, model?: string) => void | Promise<void>;
}) {
  const intl = useIntl();
  const t = (key: keyof typeof messages) => intl.formatMessage(messages[key]);
  const { changeModel } = useModelAndProvider();
  const [deleting, setDeleting] = useState<GgufProfile>();
  const [entries, setEntries] = useState<ProfileEntry[]>([]);
  const [profile, setProfile] = useState<GgufProfile>(blank);
  const [advanced, setAdvanced] = useState(false);
  const [placementReview, setPlacementReview] = useState(false);
  const [canonicalRuntime, setCanonicalRuntime] = useState('');
  useEffect(() => { void window.electron.ggufRuntime().then(setCanonicalRuntime).catch(setError); }, []);
  const [probe, setProbe] = useState<RuntimeProbe>();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<'saved' | 'valid'>();
  const [error, setError] = useState<unknown>();
  const state = useManagedGgufState();
  const [runtimeContext, setRuntimeContext] = useState<number>();
  useEffect(() => {
    let alive = true; setRuntimeContext(undefined);
    if (profile.id) void window.electron.ggufDiscoveryCatalog(profile.id).then(c => { if (alive) setRuntimeContext(c.selectedContext); }).catch(() => {});
    return () => { alive = false; };
  }, [profile.id, state]);
  const reload = async () => setEntries(await window.electron.ggufList());
  useEffect(() => {
    const refresh = () => {
      void reload().catch(setError);
    };
    refresh();
    window.addEventListener('focus', refresh);
    window.electron.on('gguf-profiles-changed', refresh);
    return () => {
      window.removeEventListener('focus', refresh);
      window.electron.off('gguf-profiles-changed', refresh);
    };
  }, []);
  useEffect(() => {
    if (!profile.id || profile.backend === 'native') return;
    let alive = true;
    const timer = setTimeout(() => { void window.electron.ggufProbe(profile.executable).then(value => { if (alive) setProbe(value); }).catch(() => {}); }, 300);
    return () => { alive = false; clearTimeout(timer); };
  }, [profile.id, profile.executable, profile.backend]);
  const select = useCallback((p: GgufProfile) => {
    setPlacementReview(false);
    setProfile({ ...p, executable: canonicalRuntime || p.executable, gpuLayers: p.gpuLayers ?? 999 });
    setProbe(undefined);
    setNotice(undefined);
    setError(undefined);
  }, [canonicalRuntime]);
  const openedProfile = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!initialProfileId || openedProfile.current === initialProfileId) return;
    const selected = entries.find((entry) => entry.profile.id === initialProfileId);
    if (selected) { select(selected.profile); openedProfile.current = initialProfileId; }
  }, [initialProfileId, entries, select]);
  const set = <K extends keyof GgufProfile>(key: K, value: GgufProfile[K]) => {
    setProfile((previous) => ({ ...previous, [key]: value }));
    setNotice(undefined);
    if (key === 'executable') setProbe(undefined);
  };
  const supported = (key: keyof GgufProfile) =>
    profile.backend === 'native'
      ? ![
          'projector',
          'cacheK',
          'cacheV',
          'ubatch',
          'parallel',
          'draftCacheK',
          'draftCacheV',
          'draftUbatch',
          'cpuMoe',
          'nCpuMoe',
          'tensorOverride',
          'moeCacheMiB',
          'jinja',
          'chatTemplate',
        ].includes(key)
      : !probe || !flags[key] || probe.flags.includes(flags[key]!);
  const present = (key: keyof GgufProfile) => supported(key) || Boolean(profile[key]);
  async function action(fn: () => Promise<void>) {
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      await fn();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  const validateForInspection = async () => {
    const result = await window.electron.ggufValidate(profile);
    if (result?.placementConfirmationRequired) {
      setAdvanced(true);
      setPlacementReview(true);
      setError(new Error('GGUF:placementIdentity:'));
    } else setNotice('valid');
  };
  const text = (
    key: 'name' | 'model' | 'executable' | 'projector' | 'tensorOverride' | 'chatTemplate',
    file = false
  ) => (
    <label className="block space-y-2 text-sm" key={key}>
      <span>{t(key)}</span>
      <div className="flex gap-2">
        <Input
          aria-label={t(key)}
          value={profile[key] ?? ''}
          disabled={busy}
          onChange={(event) => set(key, event.target.value)}
        />
        {file && (
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={async () => {
              const value = await window.electron.selectFileOrDirectory();
              if (value) set(key, value);
            }}
          >
            {t('browse')}
          </Button>
        )}
      </div>
      {!supported(key) && <p className="text-text-danger">{t('unsupported')}</p>}
    </label>
  );
  const number = (
    key: 'gpuLayers' | 'context' | 'threads' | 'batch' | 'ubatch' | 'parallel' | 'draftUbatch' | 'nCpuMoe' | 'moeCacheMiB'
  ) => (
    <label key={key} className="block space-y-2 text-sm">
      <span>{t(key)}</span>
      <Input
        type="number"
        disabled={busy}
        aria-label={t(key)}
        value={profile[key] ?? ''}
        onChange={(event) =>
          set(key, event.target.value === '' ? (undefined as never) : Number(event.target.value))
        }
      />
      {key === 'gpuLayers' && <p className="text-xs text-text-secondary">{t('gpuLayersHelp')}</p>}
      {!supported(key) && <p className="text-text-danger">{t('unsupported')}</p>}
    </label>
  );
  const choice = (key: 'cacheK' | 'cacheV' | 'draftCacheK' | 'draftCacheV' | 'flashAttention', values: string[]) => (
    <label key={key} className="block space-y-2 text-sm">
      <span>{t(key)}</span>
      <select
        className="w-full rounded-lg border border-border-primary bg-background-primary p-2"
        aria-label={t(key)}
        value={profile[key] ?? ''}
        onChange={(event) => set(key, (event.target.value as never) || undefined)}
      >
        <option value="">{t('default')}</option>
        {values.map((value) => (
          <option key={value} value={value}>
            {value === 'auto' || value === 'on' || value === 'off' ? t(value) : value}
          </option>
        ))}
      </select>
      {!supported(key) && <p className="text-text-danger">{t('unsupported')}</p>}
    </label>
  );
  const toggle = (key: 'cpuMoe' | 'jinja' | 'projectorCpu') => (
    <label className="flex items-center gap-2 text-sm">
      <input
        type="checkbox"
        checked={profile[key] ?? false}
        onChange={(event) => set(key, event.target.checked || undefined)}
      />
      {t(key)}
      {!supported(key) && <span className="text-text-danger">{t('unsupported')}</span>}
    </label>
  );
  const section = (
    key: 'runtime' | 'memory' | 'cpu' | 'vision' | 'speculation' | 'tools' | 'experimental',
    children: React.ReactNode
  ) => (
    <details open={key === 'experimental' && placementReview ? true : undefined} className="rounded-xl border border-border-primary p-4">
      <summary className="cursor-pointer font-medium">{t(key)}</summary>
      <div className="space-y-4 mt-4">{children}</div>
    </details>
  );
  return (
    <div className="space-y-5 text-text-primary">
      <Dialog
        open={!!deleting}
        onOpenChange={(open) => {
          if (!open) setDeleting(undefined);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('delete')}</DialogTitle>
          </DialogHeader>
          <p>{intl.formatMessage(messages.confirmDelete, { name: deleting?.name ?? '' })}</p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleting(undefined)}>
              {intl.formatMessage({ id: 'switchModelModal.cancel', defaultMessage: 'Cancel' })}
            </Button>
            <Button
              disabled={busy}
              onClick={() =>
                void action(async () => {
                  if (!deleting) return;
                  await deleteLocalProfile(deleting);
                  await reload();
                  if (profile.id === deleting.id) select(blank());
                  setDeleting(undefined);
                })
              }
            >
              {t('delete')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <h3 className="text-lg font-medium">{t('title')}</h3>
      <p className="text-sm text-text-secondary">{t('description')}</p>
      <div className="space-y-3">
        {entries.map(({ profile: p, available, error: entryError }) => (
          <div
            key={p.id}
            className="rounded-xl border border-border-primary bg-background-secondary p-4 space-y-3"
          >
            <div className="flex flex-wrap justify-between gap-2">
              <strong>{p.name}</strong>
              <span role="status" className="text-sm">
                {!available
                  ? t('missing')
                  : state.profileId === p.id
                    ? t(state.phase)
                    : t('available')}
              </span>
            </div>
            {entryError && (
              <p className="text-sm text-text-danger">{formatGgufError(intl, entryError)}</p>
            )}
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" onClick={() => select(p)}>
                {t('edit')}
              </Button>
              <Button
                variant="outline"
                onClick={() =>
                  select({ ...p, id: undefined, providerId: undefined, name: p.name + ' (2)' })
                }
              >
                {t('duplicate')}
              </Button>
              <Button
                disabled={!available || busy}
                onClick={() =>
                  void action(async () => {
                    const registered = await registerLocalProfile(p);
                    if (onConfigured)
                      await onConfigured(
                        registered.providerId!,
                        p.backend === 'native' ? p.model : 'local-gguf'
                      );
                    else
                      await changeModel(null, {
                        provider: registered.providerId!,
                        name: p.backend === 'native' ? p.model : 'local-gguf',
                        context_limit: p.context,
                      });
                  })
                }
              >
                {t('select')}
              </Button>
              <Button variant="outline" onClick={() => setDeleting(p)}>
                {t('delete')}
              </Button>
            </div>
          </div>
        ))}
      </div>
      <Button variant="outline" onClick={() => select(blank())}>
        {t('add')}
      </Button>
      <div className="space-y-4 rounded-xl border border-border-primary p-4">
        {text('name')}
        {text('model', true)}
        <label className="block space-y-2 text-sm">
          <span>{t('backend')}</span>
          <select
            className="w-full rounded-lg border border-border-primary bg-background-primary p-2"
            aria-label={t('backend')}
            value={profile.backend ?? 'external'}
            onChange={(event) => set('backend', event.target.value as 'external' | 'native')}
          >
            <option value="external">{t('external')}</option>
            <option value="native">{t('native')}</option>
          </select>
        </label>
        {profile.backend !== 'native' && <p className="text-xs text-text-secondary break-all" title={canonicalRuntime}>{t('executable')}: {canonicalRuntime}</p>}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {number('gpuLayers')}
          {number('context')}
        </div>
        {runtimeContext !== undefined && runtimeContext !== profile.context && <p className="text-xs text-text-secondary">{intl.formatMessage(messages.runtimeContext, { context: runtimeContext })}</p>}
        {!advanced && profile.backend !== 'native' && text('projector', true)}
        <Button variant="outline" onClick={() => setAdvanced(!advanced)}>
          {t(advanced ? 'simple' : 'advanced')}
        </Button>
        {advanced && (
          <div className="space-y-3">
            {section(
              'runtime',
              <>
                <Button
                  disabled={busy || profile.backend === 'native'}
                  onClick={() =>
                    void action(async () => {
                      setProbe(await window.electron.ggufProbe(profile.executable));
                    })
                  }
                >
                  {t('probe')}
                </Button>
                {profile.backend === 'native' && <p>{t('nativeNote')}</p>}
                <Button
                  variant="outline"
                  onClick={() => {
                    const next = { ...profile };
                    if (
                      probe &&
                      next.speculativeMode &&
                      next.speculativeMode !== 'off' &&
                      !probe.speculativeModes.includes(next.speculativeMode)
                    )
                      next.speculativeMode = 'off';
                    if (probe && !probe.flags.includes('--spec-draft-n-min'))
                      delete next.draftMinTokens;
                    if (probe && !probe.flags.includes('--gpu-layers-draft'))
                      delete next.draftGpuLayers;
                    for (const key of Object.keys(flags) as (keyof GgufProfile)[])
                      if (!supported(key)) delete next[key];
                    setProfile(next);
                  }}
                >
                  {intl.formatMessage({
                    id: 'gguf.clearUnsupported',
                    defaultMessage: 'Clear unsupported settings',
                  })}
                </Button>
                {probe && (
                  <>
                    <p>{t(probe.diagnosis)}</p>
                    <pre className="text-xs whitespace-pre-wrap break-all">
                      {probe.executable + '\n' + probe.version + '\n' + probe.devices}
                    </pre>
                  </>
                )}
              </>
            )}
            {section(
              'memory',
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {present('cacheK') && choice('cacheK', ['f16', 'q8_0', 'q4_0'])}
                {present('cacheV') && choice('cacheV', ['f16', 'q8_0', 'q4_0'])}
                {present('flashAttention') && choice('flashAttention', ['auto', 'on', 'off'])}
                {profile.speculativeMode?.startsWith('mtp-') && present('draftCacheK') && choice('draftCacheK', ['f16', 'q8_0'])}
                {profile.speculativeMode?.startsWith('mtp-') && present('draftCacheV') && choice('draftCacheV', ['f16', 'q8_0'])}
              </div>
            )}
            {section(
              'cpu',
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {number('threads')}
                {present('parallel') && number('parallel')}
                {profile.speculativeMode?.startsWith('mtp-') && present('draftUbatch') && number('draftUbatch')}
                {number('batch')}
                {present('ubatch') && number('ubatch')}
              </div>
            )}
            {profile.speculativeMode?.startsWith('mtp-') && probe?.flags.includes('--parallel') && probe?.flags.includes('--spec-draft-n-ubatch') && (
              <Button variant="outline" disabled={busy} onClick={() => {
                setProfile(p => ({
                  ...p, parallel: 1, batch: 512, ubatch: 128, draftUbatch: 128, draftTokens: 1,
                  draftMinTokens: p.draftMinTokens === undefined ? undefined : Math.min(p.draftMinTokens, 1),
                }));
                setNotice(undefined);
              }}>{t('mtpMemoryPreset')}</Button>
            )}
            {profile.backend !== 'native' && section('vision', <div className="space-y-2">{text('projector', true)}{toggle('projectorCpu')}</div>)}
            {section(
              'speculation',
              <SpeculativeSettings
                profile={profile}
                probe={probe}
                savedTokens={entries.find(e => e.profile.id === profile.id)?.profile.draftTokens}
                savedMode={entries.find(e => e.profile.id === profile.id)?.profile.speculativeMode ?? 'off'}
                activeMode={state.phase === 'ready' && state.profileId === profile.id ? state.args?.[state.args.indexOf('--spec-type') + 1] ?? 'none' : undefined}
                activeTokens={state.phase === 'ready' && state.profileId === profile.id && state.args?.includes('--spec-draft-n-max') ? state.args[state.args.indexOf('--spec-draft-n-max') + 1] : undefined}
                busy={busy}
                onChange={(value) => {
                  setProfile(value);
                  setNotice(undefined);
                }}
                onProbe={() =>
                  void action(async () => {
                    setProbe(await window.electron.ggufProbe(profile.executable));
                  })
                }
                onValidate={() =>
                  void action(async () => {
                    const capabilities = await window.electron.ggufProbe(profile.executable);
                    setProbe(capabilities);
                    await validateForInspection();
                  })
                }
              />
            )}
            {section(
              'tools',
              <>
                {present('jinja') && toggle('jinja')}
                {present('chatTemplate') && text('chatTemplate')}
              </>
            )}
            {profile.backend !== 'native' &&
              probe &&
              (['cpuMoe', 'nCpuMoe', 'tensorOverride', 'moeCacheMiB'] as const).some((key) =>
                present(key)
              ) &&
              section(
                'experimental',
                <>
                  <p className="text-sm text-text-secondary">{t('moeNote')}</p>
                  {present('cpuMoe') && (
                    <div className="space-y-1">
                      {toggle('cpuMoe')}
                      <p className="ml-6 text-xs text-text-secondary">{t('cpuMoeHelp')}</p>
                    </div>
                  )}
                  {present('nCpuMoe') && number('nCpuMoe')}
                  {present('tensorOverride') && text('tensorOverride')}
                  <PlacementSettings profile={profile} onChange={value => { setProfile(value); setNotice(undefined); setError(undefined); }} />
                </>
              )}
          </div>
        )}
        <div className="flex flex-wrap gap-2">
          <Button
            disabled={busy}
            onClick={() =>
              void action(async () => {
                let saved = await window.electron.ggufSave({ ...profile, executable: profile.backend === 'native' ? profile.executable : canonicalRuntime });
                saved = await registerLocalProfile(saved);
                select(saved);
                await reload();
                setNotice('saved');
                if (onConfigured)
                  await onConfigured(
                    saved.providerId!,
                    saved.backend === 'native' ? saved.model : 'local-gguf'
                  );
              })
            }
          >
            {t('save')}
          </Button>
          <Button
            variant="outline"
            disabled={busy}
            onClick={() =>
              void action(async () => {
                if (profile.backend !== 'native')
                  setProbe(await window.electron.ggufProbe(profile.executable));
                await validateForInspection();
              })
            }
          >
            {t('validate')}
          </Button>
        </div>
        {notice && (
          <p role="status" className="text-sm">
            {t(notice)}
          </p>
        )}
        {error != null && (
          <p role="alert" className="text-sm text-text-danger break-all">
            {formatGgufError(intl, error)}
          </p>
        )}
      </div>
    </div>
  );
}
