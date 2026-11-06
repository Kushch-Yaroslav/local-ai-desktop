import { useState } from 'react';
// Local AI Desktop: capability-gated speculative configuration, outside the chat composer.
import type { GgufProfile, RuntimeProbe } from '../../ggufTypes';
import { useIntl } from '../../i18n';
import { ggufMessages as messages } from '../../ggufMessages';
import { Input } from '../ui/input';
import { Button } from '../ui/button';
export default function SpeculativeSettings({
  profile,
  probe,
  busy,
  onChange,
  onProbe,
  onValidate,
  savedMode, savedTokens, activeMode, activeTokens,
}: {
  profile: GgufProfile;
  probe?: RuntimeProbe;
  busy: boolean;
  onChange: (profile: GgufProfile) => void;
  onProbe: () => void;
  onValidate: () => void;
  savedMode?: string; savedTokens?: number; activeMode?: string; activeTokens?: string;
}) {
  const intl = useIntl();
  const [diagnostics, setDiagnostics] = useState<{args?: string[]; accepted?: number; proposed?: number}>();
  const t = (key: keyof typeof messages) => intl.formatMessage(messages[key]);
  const modes = profile.backend === 'native' ? [] : (probe?.speculativeModes ?? []);
  const mode = profile.speculativeMode ?? 'off';
  const enabled = mode !== 'off';
  const names: Record<string, keyof typeof messages> = {
    'mtp-embedded': 'specEmbedded',
    'mtp-external': 'specExternal',
    'draft-simple': 'specSimple',
  };
  const update = <K extends keyof GgufProfile>(key: K, value: GgufProfile[K]) =>
    onChange({ ...profile, [key]: value });
  return (
    <div className="space-y-4 text-sm">
      {profile.id && <p className="text-xs text-text-secondary">{t('specSaved')}: {savedMode === 'mtp-embedded' ? t('specEmbedded') : !savedMode || savedMode === 'off' ? t('off') : savedMode} · {t('specActive')}: {activeMode ?? t('idle')}{activeTokens ? ` · ${activeTokens}` : ''}</p>}
      {profile.id && (mode !== (savedMode ?? 'off') || (profile.draftTokens ?? 2) !== (savedTokens ?? 2)) && <p className="text-xs text-text-secondary">{t('specPending')}</p>}
      {activeMode && (activeMode !== (mode === 'mtp-embedded' ? 'draft-mtp' : 'none') || enabled && activeTokens !== String(profile.draftTokens ?? 2)) && <p className="text-xs text-text-secondary">{t('reloadRequired')}</p>}
      <p className="text-text-secondary">{t('specTradeoff')}</p>
      {profile.id && <details onToggle={event => { if (event.currentTarget.open) void window.electron.ggufDiagnostics(profile.id!).then(setDiagnostics).catch(() => setDiagnostics(undefined)); }}>
        <summary className="cursor-pointer text-xs text-text-secondary">{t('runtime')}</summary>
        <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-all text-xs">{diagnostics?.args?.join(' ') ?? '—'}</pre>
        <p className="text-xs text-text-secondary">{t('specAcceptance')}: {diagnostics?.accepted !== undefined && diagnostics.proposed ? `${diagnostics.accepted}/${diagnostics.proposed} (${(100*diagnostics.accepted/diagnostics.proposed).toFixed(1)}%)` : '—'}</p>
      </details>}

      {!probe && (
        <Button
          type="button"
          variant="outline"
          disabled={busy || profile.backend === 'native'}
          onClick={onProbe}
        >
          {t('probe')}
        </Button>
      )}
      {profile.backend === 'native' && <p>{t('nativeUnsupported')}</p>}
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={enabled}
          disabled={busy || (!enabled && !modes.length)}
          onChange={(event) =>
            update(
              'speculativeMode',
              event.target.checked ? (modes[0] as GgufProfile['speculativeMode']) : 'off'
            )
          }
        />
        {t('specEnable')}
      </label>
      {probe && !modes.length && <p>{t('specBackend')}</p>}
      {enabled && (
        <>
          <label className="block space-y-2">
            <span>{t('specMode')}</span>
            <select
              aria-label={t('specMode')}
              disabled={busy}
              value={mode}
              className="w-full rounded-lg border border-border-primary bg-background-primary p-2"
              onChange={(event) =>
                update('speculativeMode', event.target.value as GgufProfile['speculativeMode'])
              }
            >
              {!modes.includes(mode) && (
                <option value={mode} disabled>
                  {t('unsupported')}
                </option>
              )}
              {modes.map((value) => (
                <option value={value} key={value}>
                  {t(names[value])}
                </option>
              ))}
            </select>
          </label>
          {(mode !== 'mtp-embedded' || profile.draft) && (
            <label className="block space-y-2">
              <span>{t('draftPath')}</span>
              <div className="flex gap-2">
                <Input
                  aria-label={t('draftPath')}
                  value={profile.draft ?? ''}
                  disabled={busy}
                  onChange={(event) => update('draft', event.target.value || undefined)}
                />
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy || mode === 'mtp-embedded'}
                  onClick={async () => {
                    const file = await window.electron.selectFileOrDirectory();
                    if (file) update('draft', file);
                  }}
                >
                  {t('browse')}
                </Button>
              </div>
              {mode === 'mtp-embedded' && (
                <p className="text-text-danger">{t('specEmbeddedPath')}</p>
              )}
            </label>
          )}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {(['draftTokens', 'draftMinTokens', 'draftGpuLayers'] as const)
              .filter(
                (key) =>
                  key === 'draftTokens' ||
                  (key === 'draftMinTokens' &&
                    (probe?.flags.includes('--spec-draft-n-min') ||
                      profile.draftMinTokens !== undefined)) ||
                  (key === 'draftGpuLayers' &&
                    (mode !== 'mtp-embedded' || profile.draftGpuLayers !== undefined) &&
                    (probe?.flags.includes('--gpu-layers-draft') ||
                      profile.draftGpuLayers !== undefined))
              )
              .map((key) => (
                <label key={key} className="block space-y-2">
                  <span>{t(key)}</span>
                  <Input
                    type="number"
                    aria-label={t(key)}
                    disabled={busy}
                    value={profile[key] ?? (key === 'draftTokens' ? 2 : '')}
                    onChange={(event) =>
                      update(
                        key,
                        event.target.value === '' ? undefined : Number(event.target.value)
                      )
                    }
                  />
                </label>
              ))}
          </div>
          <p className="text-text-secondary">{t('specTrial')}</p>
          <Button type="button" variant="outline" disabled={busy} onClick={onValidate}>
            {t('specValidate')}
          </Button>
        </>
      )}
    </div>
  );
}
