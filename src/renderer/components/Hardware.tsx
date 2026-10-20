import { useLocale } from '../use-locale';
import { t } from '../../shared/locale';
import type { HardwareStats } from '../../shared/types';
const gb = (bytes: number) => (bytes / 1024 ** 3).toFixed(1);
export function Hardware({ value, compact = false }: { value: HardwareStats | null; compact?: boolean }) {
  useLocale();
  const className = compact ? 'hardware hardware-compact' : 'hardware';
  if (!value) return <div className={className}>{t("Мониторинг…")}</div>;
  return <div className={className} aria-label={t('Мониторинг памяти и GPU')}>
    <span title="RAM">RAM {gb(value.ramUsedBytes)} / {gb(value.ramTotalBytes)} GB</span>
    {value.available ? <><span title="VRAM">VRAM {gb(value.vramUsedBytes ?? 0)} / {gb(value.vramTotalBytes ?? 0)} GB</span>{value.gpuUtilization!==null&&<span title={t('Загрузка GPU')}>GPU {value.gpuUtilization}%</span>}</> : <span title={t("nvidia-smi недоступен")}>{t("GPU недоступен")}</span>}
  </div>;
}
