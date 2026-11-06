import fs from 'node:fs/promises';
import path from 'node:path';
import type { ContextDiscoveryOption } from './contextEstimator';
import {
  isPersistableDiscoveryOption,
  mergeSavedDiscoveryOptions,
  parseStoredDiscoveryOption,
} from './contextDiscoveryPersistence';

// New storage preserves the donor's key/identity/option semantics. Only the
// container differs because Goose Desktop does not use the donor's SQLite DB.
export interface StoredDiscoveryRow {
  config_key: string;
  identity: string;
  model_id: string;
  kv_cache_type: 'f16' | 'q8_0';
  kv_offload: number;
  context_window: number;
  option: string;
  saved_at: number;
}
interface DiscoveryDocument {
  version: 1;
  rows: StoredDiscoveryRow[];
}
const emptyDocument = (): DiscoveryDocument => ({ version: 1, rows: [] });

export async function readDiscoveryDocument(file: string): Promise<DiscoveryDocument> {
  try {
    const value: unknown = JSON.parse(await fs.readFile(file, 'utf8'));
    if (
      typeof value !== 'object' ||
      value === null ||
      !Array.isArray((value as DiscoveryDocument).rows)
    )
      return emptyDocument();
    return { version: 1, rows: (value as DiscoveryDocument).rows.filter(isStoredRow).slice(-4096) };
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT')
      return emptyDocument();
    throw error;
  }
}

function isStoredRow(value: unknown): value is StoredDiscoveryRow {
  if (typeof value !== 'object' || value === null) return false;
  const row = value as Partial<StoredDiscoveryRow>;
  return (
    typeof row.config_key === 'string' &&
    typeof row.identity === 'string' &&
    typeof row.model_id === 'string' &&
    (row.kv_cache_type === 'f16' || row.kv_cache_type === 'q8_0') &&
    (row.kv_offload === 0 || row.kv_offload === 1) &&
    Number.isInteger(row.context_window) &&
    typeof row.option === 'string' &&
    Number.isFinite(row.saved_at)
  );
}

export async function saveDiscoveryOptions(
  file: string,
  configKey: string,
  identity: string,
  options: readonly ContextDiscoveryOption[],
  now = Date.now(),
  replaceConfiguration = false,
  completedModelId?: string
): Promise<number> {
  const valid = options.filter((option) => isPersistableDiscoveryOption(option));
  if (!valid.length && !replaceConfiguration) return 0;
  const document = await readDiscoveryDocument(file);
  const modelId = valid[0]?.modelId ?? options[0]?.modelId ?? completedModelId;
  if (!modelId) return 0;
  // Only a completed search calls this replacement path. Remove both cache modes
  // for this exact model/config before writing the new, validated findings.
  // A cancelled/failed search never calls persistence, preserving prior findings.
  const retained = document.rows.filter(
    (row) => !(replaceConfiguration && row.config_key === configKey && row.model_id === modelId)
  );
  const freshModes = new Set(
    valid.map((option) => `${option.kvCacheType}:${option.kvOffload ? 1 : 0}`)
  );
  const withoutReplacedModes = retained.filter(
    (row) =>
      !(
        row.config_key === configKey &&
        row.model_id === modelId &&
        freshModes.has(`${row.kv_cache_type}:${row.kv_offload}`)
      )
  );
  const rows = valid.map((option) => ({
    config_key: configKey,
    identity,
    model_id: option.modelId,
    kv_cache_type: option.kvCacheType,
    kv_offload: option.kvOffload ? 1 : 0,
    context_window: option.contextWindow,
    option: JSON.stringify(option),
    saved_at: now,
  }));
  const next: DiscoveryDocument = {
    version: 1,
    rows: [...withoutReplacedModes, ...rows].slice(-4096),
  };
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    await fs.writeFile(temporary, JSON.stringify(next), { mode: 0o600 });
    await fs.rename(temporary, file);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
  return rows.length;
}

export async function loadDiscoveryOptions(
  file: string,
  input: {
    configKey: string;
    modelId: string;
    hardLimit: number;
    kvOffload?: boolean;
  }
): Promise<{ options: ContextDiscoveryOption[]; previous: ContextDiscoveryOption[] }> {
  const document = await readDiscoveryDocument(file);
  const exact: ContextDiscoveryOption[] = [];
  const previous: ContextDiscoveryOption[] = [];
  for (const row of document.rows.filter((candidate) => candidate.model_id === input.modelId)) {
    const parsed = parseStoredDiscoveryOption(row.option, {
      modelId: input.modelId,
      kvCacheType: row.kv_cache_type,
      kvOffload: row.kv_offload === 1,
      hardLimit: input.hardLimit,
    });
    if (!parsed) continue;
    if (
      row.config_key === input.configKey &&
      (input.kvOffload === undefined || row.kv_offload === (input.kvOffload ? 1 : 0))
    )
      exact.push(parsed);
    else
      previous.push({
        ...parsed,
        conditions: 'changed',
        validation: 'previous',
        conditionWarning:
          'Runtime, model, placement or hardware conditions changed; rerun discovery to confirm this value.',
      });
  }
  return {
    options: mergeSavedDiscoveryOptions([], exact),
    previous: mergeSavedDiscoveryOptions([], previous),
  };
}
