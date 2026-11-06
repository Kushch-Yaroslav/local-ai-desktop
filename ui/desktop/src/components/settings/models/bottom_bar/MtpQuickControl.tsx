// Local AI Desktop: profile preference and effective owned runtime are separate.
import { useEffect, useState } from 'react';
import { Zap, RotateCw } from 'lucide-react';
import { DropdownMenuItem } from '../../../ui/dropdown-menu';
import type { GgufProfile, RuntimeState } from '../../../../ggufTypes';
import { defineMessages, useIntl } from '../../../../i18n';
const messages = defineMessages({
  active: { id: 'mtpQuick.active', defaultMessage: 'MTP: active in runtime' },
  on: { id: 'mtpQuick.on', defaultMessage: 'MTP: enabled (saved)' },
  off: { id: 'mtpQuick.off', defaultMessage: 'MTP: disabled' },
  pending: { id: 'mtpQuick.pending', defaultMessage: 'MTP: reload required' },
  reload: { id: 'mtpQuick.reload', defaultMessage: 'Apply MTP / reload model' },
  confirm: {
    id: 'mtpQuick.confirm',
    defaultMessage: 'Reload the shared model now to apply saved MTP settings?',
  },
});
export default function MtpQuickControl({
  profile,
  runtime,
  act,
}: {
  profile: GgufProfile;
  runtime: RuntimeState;
  act: (action: () => Promise<unknown>) => Promise<void>;
}) {
  const intl = useIntl();
  const [supported, setSupported] = useState(false);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    let alive = true;
    setSupported(false);
    void window.electron
      .ggufCapabilities(profile.id!)
      .then((c) => {
        if (alive) setSupported(c.embeddedMtp === true);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [profile.id, profile.executable, profile.model, profile.speculativeMode]);
  if (!supported) return null;
  const saved = profile.speculativeMode === 'mtp-embedded';
  const loaded = runtime.profileId === profile.id && runtime.phase === 'ready';
  const index = runtime.args?.indexOf('--spec-type') ?? -1;
  const active = loaded && index >= 0 && runtime.args?.[index + 1] === 'draft-mtp';
  const pending = loaded && saved !== active;
  const label = intl.formatMessage(
    messages[pending ? 'pending' : active ? 'active' : saved ? 'on' : 'off']
  );
  return (
    <>
      <DropdownMenuItem
        aria-label={label}
        title={label}
        disabled={saving}
        className={`p-1.5 ${active ? 'text-green-500' : saved ? 'text-purple-500' : 'text-text-secondary'}`}
        onSelect={(e) => {
          e.preventDefault();
          setSaving(true);
          void act(() => window.electron.ggufSetMtp(profile.id!, !saved)).finally(() =>
            setSaving(false)
          );
        }}
      >
        <Zap className="h-3.5 w-3.5" />
      </DropdownMenuItem>
      {pending && (
        <DropdownMenuItem
          aria-label={intl.formatMessage(messages.reload)}
          title={intl.formatMessage(messages.reload)}
          className="p-1.5"
          onSelect={(e) => {
            e.preventDefault();
            if (!window.confirm(intl.formatMessage(messages.confirm))) return;
            void act(async () => {
              const token = await window.electron.ggufDiscoveryAcquire();
              try {
                await window.electron.ggufReloadProfile(profile.id!, token);
              } finally {
                await window.electron.ggufDiscoveryRelease(token);
              }
            });
          }}
        >
          <RotateCw className="h-3.5 w-3.5" />
        </DropdownMenuItem>
      )}
    </>
  );
}
