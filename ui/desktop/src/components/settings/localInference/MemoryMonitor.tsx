// Local AI Desktop: visible model-page sampling only; no inference budget decisions.
import { useEffect, useState } from 'react';
import type { MemorySnapshot, MemoryReading } from '../../../memoryTelemetryTypes';
import { defineMessages, useIntl } from '../../../i18n';
export const memoryMessages = defineMessages({
  location: { id: 'memoryMonitoring.location', defaultMessage: 'Show RAM and VRAM in Chat and Local Models' },
  enabled: { id: 'memoryMonitoring.enabled', defaultMessage: 'Memory Usage Monitoring' },
  usage: { id: 'memoryMonitoring.usage', defaultMessage: 'System memory usage' },
  unavailable: { id: 'memoryMonitoring.unavailable', defaultMessage: 'Unavailable' },
});
export function useMemoryMonitoringPreference() {
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    let alive = true;
    const refresh = () => {
      void window.electron
        .getSetting('memoryMonitoring')
        .then((v) => {
          if (alive) setEnabled(v === true);
        })
        .catch(() => {
          if (alive) setEnabled(false);
        });
    };
    refresh();
    window.addEventListener('memoryMonitoringChanged', refresh);
    return () => {
      alive = false;
      window.removeEventListener('memoryMonitoringChanged', refresh);
    };
  }, []);
  return enabled;
}
export default function MemoryMonitor() {
  const enabled = useMemoryMonitoringPreference();
  const intl = useIntl();
  const [snapshot, setSnapshot] = useState<MemorySnapshot | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let alive = true,
      timer: ReturnType<typeof setTimeout> | undefined,
      sampling = false;
    const sample = async () => {
      if (!alive || document.hidden || sampling) return;
      sampling = true;
      try {
        const value = await window.electron.memorySample();
        if (alive) setSnapshot(value);
      } catch {
        if (alive) setSnapshot(null);
      } finally {
        sampling = false;
        if (alive && !document.hidden) timer = setTimeout(() => void sample(), 2000);
      }
    };
    const visibility = () => {
      clearTimeout(timer);
      if (document.hidden) {
        window.electron.memoryCancel();
        setSnapshot(null);
      } else void sample();
    };
    void sample();
    document.addEventListener('visibilitychange', visibility);
    return () => {
      alive = false;
      clearTimeout(timer);
      window.electron.memoryCancel();
      document.removeEventListener('visibilitychange', visibility);
    };
  }, [enabled]);
  if (!enabled) return null;
  const format = (value: MemoryReading | null | undefined) =>
    value
      ? `${(value.used / 1024 ** 3).toFixed(1)} / ${(value.total / 1024 ** 3).toFixed(1)} GiB`
      : '—';
  return (
    <div
      aria-label={intl.formatMessage(memoryMessages.usage)}
      className="flex flex-wrap justify-end gap-x-3 gap-y-1 text-[11px] tabular-nums text-text-secondary"
    >
      <span title={!snapshot?.ram ? intl.formatMessage(memoryMessages.unavailable) : undefined}>
        RAM {format(snapshot?.ram)}
      </span>
      {snapshot?.gpus.length ? (
        snapshot.gpus.map((gpu) => (
          <span key={gpu.id} className="contents" title={`NVIDIA GPU ${gpu.id}`}>
            <span>VRAM{snapshot.gpus.length > 1 ? ` GPU ${gpu.id}` : ''} {format(gpu)}</span>
            <span>
              GPU{snapshot.gpus.length > 1 ? ` ${gpu.id}` : ''}{' '}
              {gpu.utilizationPercent === null ? '—' : `${Math.round(gpu.utilizationPercent)}%`}
            </span>
          </span>
        ))
      ) : (
        <>
          <span title={intl.formatMessage(memoryMessages.unavailable)}>VRAM —</span>
          <span title={intl.formatMessage(memoryMessages.unavailable)}>GPU —</span>
        </>
      )}
    </div>
  );
}
