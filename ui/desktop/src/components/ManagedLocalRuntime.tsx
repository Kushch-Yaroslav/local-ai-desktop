// Local AI Desktop: quiet collapsible inference controls; Goose retains generation controls.
import { useEffect, useId, useState, useSyncExternalStore } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { useIntl } from '../i18n';
import { ggufMessages as messages, formatGgufError } from '../ggufMessages';
import { useManagedGgufState } from '../hooks/useManagedGgufState';
import type { GgufProfile } from '../ggufTypes';
import { Button } from './ui/button';
// Session-only, keyed by provider. Navigation/remounts retain disclosure state; app restarts do not.
const disclosures = new Map<string, boolean>();
const listeners = new Set<() => void>();
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
function disclose(provider: string, value: boolean) {
  disclosures.set(provider, value);
  for (const listener of listeners) listener();
}
export default function ManagedLocalRuntime({
  provider,
  onCancelGeneration,
  onOpenSettings,
}: {
  provider?: string | null;
  onCancelGeneration?: () => void;
  onOpenSettings?: () => void;
}) {
  const intl = useIntl();
  const state = useManagedGgufState();
  const panelId = useId();
  const [profiles, setProfiles] = useState<GgufProfile[]>([]);
  const [error, setError] = useState<unknown>();
  const expanded = useSyncExternalStore(subscribe, () => disclosures.get(provider ?? '') ?? false);
  useEffect(() => {
    const refresh = () => {
      void window.electron
        .ggufList()
        .then((entries) => setProfiles(entries.map((entry) => entry.profile)))
        .catch(setError);
    };
    refresh();
    window.electron.on('gguf-profiles-changed', refresh);
    return () => window.electron.off('gguf-profiles-changed', refresh);
  }, [provider]);
  const profile = profiles.find((p) => p.providerId === provider && p.backend !== 'native');
  const selected = !!profile && state.profileId === profile.id;
  const failure = error ?? (selected ? state.error : undefined);
  useEffect(() => {
    if (failure && provider) disclose(provider, true);
  }, [failure, provider]);
  useEffect(() => {
    setError(undefined);
  }, [provider]);
  useEffect(() => {
    if (selected && state.phase === 'ready') setError(undefined);
  }, [selected, state.phase]);
  if (!profile) return null;
  const t = (key: keyof typeof messages) => intl.formatMessage(messages[key]);
  const phase = selected ? state.phase : 'idle';
  const pending = state.phase === 'starting' || state.phase === 'validating';
  return (
    <div className="mb-1 text-xs text-text-secondary">
      <Button
        type="button"
        variant="ghost"
        size="xs"
        className="w-full justify-start px-2 font-normal text-xs"
        aria-expanded={expanded}
        aria-controls={panelId}
        aria-label={intl.formatMessage(messages.compactControls, { name: profile.name })}
        onClick={() => disclose(provider!, !expanded)}
      >
        <span
          role="status"
          aria-label={t(phase)}
          title={t(phase)}
          className={`size-1.5 shrink-0 rounded-full ${phase === 'ready' ? 'bg-text-success' : phase === 'failed' ? 'bg-text-danger' : pending && selected ? 'bg-text-info animate-pulse' : 'bg-text-tertiary'}`}
        />
        <span className="truncate">{profile.name}</span>
        <span className="ml-auto" aria-hidden="true">
          {expanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
        </span>
      </Button>
      {expanded && (
        <div id={panelId} className="mt-1 rounded-lg border border-border-primary p-3 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <span aria-live="polite">{t(phase)}</span>
            {selected && (pending || phase === 'ready') ? (
              <Button
                type="button"
                size="xs"
                variant="outline"
                onClick={async () => {
                  setError(undefined);
                  try {
                    onCancelGeneration?.();
                    await window.electron.ggufStop();
                  } catch (e) {
                    setError(e);
                  }
                }}
              >
                {t(pending ? 'cancelLoad' : 'unload')}
              </Button>
            ) : (
              <Button
                type="button"
                size="xs"
                variant="outline"
                disabled={pending || state.phase === 'stopping'}
                onClick={async () => {
                  setError(undefined);
                  try {
                    await window.electron.ggufStart(profile.id!);
                  } catch (e) {
                    setError(e);
                  }
                }}
              >
                {t('load')}
              </Button>
            )}
            {onOpenSettings && (
              <Button type="button" variant="ghost" size="xs" onClick={onOpenSettings}>
                {t('modelSettings')}
              </Button>
            )}
          </div>
          {pending && !selected && <p>{t('runtimeBusy')}</p>}
          {failure != null && (
            <p role="alert" className="text-text-danger break-all">
              {formatGgufError(intl, failure)}
            </p>
          )}
          {selected && state.logPath && (
            <details>
              <summary className="cursor-pointer">{t('runtime')}</summary>
              <pre className="mt-2 whitespace-pre-wrap break-all">
                {state.args?.join(' ')}
                {'\n'}
                {state.logPath}
              </pre>
            </details>
          )}
        </div>
      )}
    </div>
  );
}
