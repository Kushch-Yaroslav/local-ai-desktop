// Local AI Desktop: donor placement interaction adapted to Goose components.
import { useEffect, useMemo, useState, useRef } from 'react';
import { useIntl, defineMessages } from '../../i18n';
import type { GgufProfile } from '../../ggufTypes';
import { parseLayerRanges, formatLayerRanges } from '../../moe/model-memory';
import { needsPlacementIdentityConfirmation } from '../../moe/placementIdentity';
import { Button } from '../ui/button';
const messages = defineMessages({
  cache: { id: 'placement.cache', defaultMessage: 'GPU Expert Cache' },
  standard: { id: 'placement.standard', defaultMessage: 'Standard' },
  auto: { id: 'placement.auto', defaultMessage: 'Automatic' },
  manual: { id: 'placement.manual', defaultMessage: 'Manual' },
  cacheCpuPlacement: {
    id: 'placement.cacheCpuPlacement',
    defaultMessage:
      'Cache mode keeps expert weights in CPU memory and caches selected experts in VRAM for this launch. Your standalone CPU MoE choice is preserved.',
  },
  cacheCpuConflict: {
    id: 'placement.cacheCpuConflict',
    defaultMessage: 'Clear “First N MoE layers on CPU” before enabling the expert cache.',
  },
  blocks: { id: 'placement.blocks', defaultMessage: 'CPU / GPU blocks' },
  enable: { id: 'placement.enable', defaultMessage: 'Selective placement' },
  detected: { id: 'placement.detected', defaultMessage: 'Detected blocks: {count}' },
  confirmIdentity: {
    id: 'placement.confirmIdentity',
    defaultMessage: 'Confirm this GGUF for the placement',
  },
  gpu: { id: 'placement.gpu', defaultMessage: 'All GPU' },
  cpu: { id: 'placement.cpu', defaultMessage: 'All CPU' },
  reset: { id: 'placement.reset', defaultMessage: 'Reset' },
  range: { id: 'placement.range', defaultMessage: 'GPU blocks (0-based ranges)' },
  priority: {
    id: 'placement.priority',
    defaultMessage: 'Block overrides take priority over GPU Layers.',
  },
  inspect: { id: 'placement.inspect', defaultMessage: 'Inspecting metadata and memory…' },
  unavailable: {
    id: 'placement.unavailable',
    defaultMessage: 'Unavailable for this model/runtime or incomplete metadata.',
  },
  pending: {
    id: 'placement.pending',
    defaultMessage:
      'Placement is not confirmed for this GGUF. Review the detected blocks and cache settings, then confirm.',
  },
  budget: {
    id: 'placement.budget',
    defaultMessage: 'GPU estimate with reserve: {gpu} GiB · mandatory RAM + reserve: {ram} GiB',
  },
  paging: {
    id: 'placement.paging',
    defaultMessage: 'The full mmap working set may page under memory pressure.',
  },
});
type Preview = Awaited<ReturnType<typeof window.electron.ggufPlacement>>;
export default function PlacementSettings({
  profile,
  onChange,
}: {
  profile: GgufProfile;
  onChange: (p: GgufProfile) => void;
}) {
  const intl = useIntl(),
    t = (key: keyof typeof messages) => intl.formatMessage(messages[key]);
  const [previewState, setPreviewState] = useState<{ key: string; value: Preview }>(),
    [errorState, setErrorState] = useState<{ key: string; value: string }>(),
    [range, setRange] = useState('');
  const lastBlock = useRef<number | null>(null);
  // Tie metadata previews to a profile and GGUF path. Changing from GPT-OSS
  // to Qwen hides the old result synchronously, before effects run.
  const previewKey = useMemo(
    () => JSON.stringify([profile.id ?? null, profile.model, profile.executable]),
    [profile.id, profile.model, profile.executable]
  );
  const preview = previewState?.key === previewKey ? previewState.value : undefined;
  const error = errorState?.key === previewKey ? errorState.value : '';
  useEffect(() => {
    lastBlock.current = null;
  }, [previewKey]);
  useEffect(() => {
    let alive = true;
    setErrorState(undefined);
    const timer = setTimeout(() => {
      if (profile.model)
        void window.electron
          .ggufPlacement(profile)
          .then((v) => {
            if (alive) setPreviewState({ key: previewKey, value: v });
          })
          .catch((e) => {
            if (alive) setErrorState({ key: previewKey, value: String(e) });
          });
    }, 350);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [profile, previewKey]);
  useEffect(
    () => setRange(formatLayerRanges(profile.gpuBlockIds ?? [])),
    [profile.gpuBlockIds, profile.model]
  );
  const change = (patch: Partial<GgufProfile>) => onChange({ ...profile, ...patch });
  const ids = profile.gpuBlockIds,
    count = preview?.inspection.layers ?? 0;
  const choose = (values: number[]) => change({ gpuBlockIds: values, tensorOverride: undefined });
  const mode = profile.moeCacheMode ?? (profile.moeCacheMiB ? 'manual' : 'standard');
  const cpuLayerConflict = profile.nCpuMoe !== undefined;
  return (
    <div className="space-y-3">
      <label className="block text-sm">
        {t('cache')}
        <select
          aria-label={t('cache')}
          className="mt-1 w-full rounded-lg border border-border-primary bg-background-primary p-2"
          value={mode}
          onChange={(e) => change({ moeCacheMode: e.target.value as GgufProfile['moeCacheMode'] })}
        >
          <option value="standard">{t('standard')}</option>
          <option value="automatic" disabled={!preview?.cacheSupported || cpuLayerConflict}>
            {t('auto')}
          </option>
          <option value="manual" disabled={!preview?.cacheSupported || cpuLayerConflict}>
            {t('manual')}
          </option>
        </select>
      </label>
      {mode !== 'standard' && (
        <p className="text-xs text-text-secondary" role="status">
          {t('cacheCpuPlacement')}
        </p>
      )}
      {mode !== 'standard' && cpuLayerConflict && (
        <p className="text-xs text-text-danger" role="alert">
          {t('cacheCpuConflict')}
        </p>
      )}
      {mode === 'manual' && (
        <select
          aria-label={t('manual')}
          className="w-full rounded-lg border border-border-primary bg-background-primary p-2"
          value={profile.moeCacheMiB ?? ''}
          onChange={(e) => change({ moeCacheMiB: Number(e.target.value) })}
        >
          <option value="" disabled>
            —
          </option>
          {[2048, 4096, 8192, 12288, 16384].map((n) => (
            <option key={n} value={n} disabled={!preview?.sizes.includes(n)}>
              {n / 1024} GiB
            </option>
          ))}
        </select>
      )}
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={ids !== undefined}
          disabled={!preview?.supported}
          onChange={(e) =>
            change({
              gpuBlockIds: e.target.checked
                ? Array.from({ length: count }, (_, n) => n)
                : undefined,
              tensorOverride: undefined,
            })
          }
        />
        {t('enable')}
      </label>
      {preview && (
        <p className="text-xs text-text-secondary">
          {preview.inspection.architecture && <span>{preview.inspection.architecture} · </span>}
          {intl.formatMessage(messages.detected, { count })}
        </p>
      )}
      {ids !== undefined && preview?.supported && (
        <div className="space-y-2">
          <p className="text-xs text-text-secondary">{t('priority')}</p>
          <div className="grid grid-cols-8 gap-1" role="group" aria-label={t('blocks')}>
            {Array.from({ length: count }, (_, n) => (
              <button
                type="button"
                key={n}
                aria-pressed={ids.includes(n)}
                aria-label={`${n}: ${ids.includes(n) ? 'GPU' : 'CPU'}`}
                className={`rounded border p-1 text-xs focus-visible:outline focus-visible:outline-2 ${ids.includes(n) ? 'border-purple-500 bg-background-secondary' : 'border-border-primary text-text-secondary'}`}
                onClick={(e) => {
                  const previous = lastBlock.current ?? n;
                  lastBlock.current = n;
                  const affected = e.shiftKey
                    ? Array.from(
                        { length: Math.abs(n - previous) + 1 },
                        (_, i) => Math.min(n, previous) + i
                      )
                    : [n];
                  const next = new Set(ids);
                  for (const id of affected) {
                    if (ids.includes(n)) next.delete(id);
                    else next.add(id);
                  }
                  choose([...next].sort((a, b) => a - b));
                }}
              >
                {n}
              </button>
            ))}
          </div>
          <div className="flex flex-wrap gap-1">
            <Button
              type="button"
              variant="outline"
              onClick={() => choose(Array.from({ length: count }, (_, n) => n))}
            >
              {t('gpu')}
            </Button>
            <Button type="button" variant="outline" onClick={() => choose([])}>
              {t('cpu')}
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => change({ gpuBlockIds: undefined })}
            >
              {t('reset')}
            </Button>
          </div>
          <label className="block text-xs">
            {t('range')}
            <input
              className="mt-1 w-full rounded border border-border-primary bg-background-primary p-2"
              value={range}
              onChange={(e) => setRange(e.target.value)}
              onBlur={() => {
                try {
                  choose(parseLayerRanges(range, count));
                  setErrorState(undefined);
                } catch (e) {
                  setErrorState({ key: previewKey, value: String(e) });
                }
              }}
            />
          </label>
        </div>
      )}
      {preview && (mode !== 'standard' || ids !== undefined) && (
        <p className="text-xs text-text-secondary">
          {intl.formatMessage(messages.budget, {
            gpu: (preview.estimate.requiredMiB / 1024).toFixed(1),
            ram: (preview.host.requiredMiB / 1024).toFixed(1),
          })}
          {!preview.host.workingSetFits && ` ${t('paging')}`}
        </p>
      )}
      {preview && needsPlacementIdentityConfirmation(profile, preview.inspection.identity) && (
        <div role="alert" className="space-y-2">
          <p className="text-xs text-text-danger">{t('pending')}</p>
          <Button
            type="button"
            variant="outline"
            aria-label={t('confirmIdentity')}
            onClick={() =>
              onChange({ ...profile, placementIdentity: preview.inspection.identity })
            }
          >
            {t('confirmIdentity')}
          </Button>
        </div>
      )}
      {!preview && !error && <p className="text-xs text-text-secondary">{t('inspect')}</p>}
      {preview && !preview.cacheSupported && (
        <p className="text-xs text-text-secondary">{t('unavailable')}</p>
      )}
      {error && (
        <p role="alert" className="text-xs text-text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
