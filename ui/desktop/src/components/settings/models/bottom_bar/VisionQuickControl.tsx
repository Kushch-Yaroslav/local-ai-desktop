import { registerLocalProfile } from '../../../../acp/managedLocalProfiles';
// Local AI Desktop: profile preference and effective owned runtime are separate.
import { useEffect, useState } from 'react';
import { Eye, RotateCw } from 'lucide-react';
import { DropdownMenuItem } from '../../../ui/dropdown-menu';
import type { GgufProfile, RuntimeState } from '../../../../ggufTypes';
import { defineMessages, useIntl } from '../../../../i18n';
const messages = defineMessages({
  invalid:{id:'visionQuick.invalid',defaultMessage:'Vision: projector unavailable or incompatible'},
  active: { id: 'visionQuick.active', defaultMessage: 'Vision: active in runtime' },
  on: { id: 'visionQuick.on', defaultMessage: 'Vision: enabled (saved)' },
  off: { id: 'visionQuick.off', defaultMessage: 'Vision: disabled' },
  pending: { id: 'visionQuick.pending', defaultMessage: 'Vision: reload required' },
  reload: { id: 'visionQuick.reload', defaultMessage: 'Apply Vision / reload model' },
  confirm: {
    id: 'visionQuick.confirm',
    defaultMessage: 'Reload the shared model now to apply saved Vision settings?',
  },
});
export default function VisionQuickControl({
  profile,
  runtime,
  act,
}: {
  profile: GgufProfile;
  runtime: RuntimeState;
  act: (action: () => Promise<unknown>) => Promise<void>;
}) {
  const intl = useIntl();
  const [invalid,setInvalid]=useState(false);
  const [supported, setSupported] = useState(false);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    let alive = true;
    setSupported(false);
    void window.electron
      .ggufCapabilities(profile.id!)
      .then((c) => {
        if (alive) setSupported(c.visionSupported === true);
        if (alive) setInvalid(!!c.visionError);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [profile.id, profile.executable, profile.model, profile.visionEnabled]);
  if (!supported && !invalid) return null;
  const saved = profile.visionEnabled !== false;
  const loaded = runtime.profileId === profile.id && runtime.phase === 'ready';
  const index = runtime.args?.indexOf('--mmproj') ?? -1;
  const active = loaded && index >= 0;
  const pending = loaded && saved !== active;
  const label = intl.formatMessage(
    messages[invalid ? 'invalid' : pending ? 'pending' : active ? 'active' : saved ? 'on' : 'off']
  );
  return (
    <>
      <DropdownMenuItem
        aria-label={label}
        title={label}
        disabled={saving || invalid}
        className={`p-1.5 ${active ? 'text-green-500' : saved ? 'text-purple-500' : 'text-text-secondary'}`}
        onSelect={(e) => {
          e.preventDefault();
          setSaving(true);
          void act(async () => { const updated = await window.electron.ggufSetVision(profile.id!, !saved); await registerLocalProfile(updated); }).finally(() =>
            setSaving(false)
          );
        }}
      >
        <Eye className="h-3.5 w-3.5" />
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
                await registerLocalProfile(profile);
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
