import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { llamaRuntimeProfile } from '../models/llama-runtime-policy';
import type { LlamaKvCacheType, RuntimeActivation, MtpMode } from '../../shared/types';
import { llamaCapabilityLimit } from './gguf-context';

/**
 * What the launcher says is running. `modelId`/`contextWindow` describe the
 * server that answers on the port right now, never a requested value.
 */
export type LlamaRuntimeState = {
  /** Explicit activation diagnostics, attached by the coordinator; not effective settings. */
  activation?: RuntimeActivation;
  status: 'idle' | 'starting' | 'ready' | 'switching' | 'offline' | 'stopped';
  modelId: string | null;
  contextWindow: number | null;
  kvCacheType?: LlamaKvCacheType;
  kvOffload?: boolean;
  mtpMode?: MtpMode;
  mtpFallbackReason?: string;
  speculativeMode?: 'mtp' | 'eagle3' | 'none';
  projectorDevice?: 'cpu' | 'gpu';
  pendingProjectorDevice?: 'cpu' | 'gpu';
  deviceError?: string;
  error?: string;
  requestId?: string;
  /** The requested runtime failed to start and the previous one was restored. */
  rolledBack?: boolean;
  /** The launcher that wrote this state; a state whose launcher is gone describes nothing. */
  launcherPid?: number;
  serverPid?: number;
  serverStartTime?: string;
  launcherStartTime?: string;
};

export type LlamaSwitchResult =
  | { ok: true; state: LlamaRuntimeState }
  | { ok: false; state: LlamaRuntimeState; error: string };

export type LlamaRuntimeFiles = {
  stateFile: string;
  requestFile: string;
  launcherPidFile: string;
};

type Deps = {
  readText: (path: string) => Promise<string>;
  signal: (pid: number) => void;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  capabilityLimit: (modelId: string) => Promise<number>;
};

const defaultDeps: Deps = {
  readText: (path) => readFile(path, 'utf8'),
  signal: (pid) => { process.kill(pid, 'SIGUSR1'); },
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
  capabilityLimit: llamaCapabilityLimit,
};

/** Error text of a state with no live launcher; never implies an active model. */
export const LAUNCHER_ABSENT = 'Launcher llama.cpp не запущен';
export const SERVER_ABSENT = 'Процесс llama-server недоступен. Загрузите модель повторно и продолжите задачу.';

/** Parses the launcher's state document defensively: it is another process's output. */
export function parseLlamaRuntimeState(raw: string): LlamaRuntimeState | null {
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    const status = value.status;
    if (status !== 'idle' && status !== 'starting' && status !== 'ready' && status !== 'switching' && status !== 'offline' && status !== 'stopped') return null;
    const modelId = typeof value.modelId === 'string' && value.modelId ? value.modelId : null;
    const contextWindow = typeof value.contextWindow === 'number' && value.contextWindow > 0 ? value.contextWindow : null;
    return {
      status, modelId, contextWindow,
      ...(['auto', 'on', 'off'].includes(String(value.mtpMode)) ? { mtpMode: value.mtpMode as MtpMode } : {}),
      ...(typeof value.mtpFallbackReason === 'string' && value.mtpFallbackReason ? { mtpFallbackReason: value.mtpFallbackReason } : {}),
      ...(value.kvCacheType === 'f16' || value.kvCacheType === 'q8_0' ? { kvCacheType: value.kvCacheType } : {}),
      ...(typeof value.kvOffload === 'boolean' ? { kvOffload: value.kvOffload } : {}),
      ...(value.speculativeMode === 'mtp' || value.speculativeMode === 'eagle3' || value.speculativeMode === 'none' ? { speculativeMode: value.speculativeMode } : {}),
      ...(value.projectorDevice === 'cpu' || value.projectorDevice === 'gpu' ? { projectorDevice: value.projectorDevice } : {}),
      ...(typeof value.error === 'string' && value.error ? { error: value.error } : {}),
      ...(typeof value.requestId === 'string' && value.requestId ? { requestId: value.requestId } : {}),
      ...(value.rolledBack === true ? { rolledBack: true } : {}),
      ...(typeof value.launcherPid === 'number' && value.launcherPid > 0 ? { launcherPid: value.launcherPid } : {}),
      ...(typeof value.serverPid === 'number' && value.serverPid > 0 ? { serverPid: value.serverPid } : {}),
      ...(typeof value.serverStartTime === 'string' && value.serverStartTime ? { serverStartTime: value.serverStartTime } : {}),
      ...(typeof value.launcherStartTime === 'string' && value.launcherStartTime ? { launcherStartTime: value.launcherStartTime } : {}),
    };
  } catch { return null; }
}

/**
 * Model and context changes for the launcher-managed llama-server as one
 * transaction. The caller persists a selection only after `ok: true`, so the
 * stored conversation, the UI and the actual server cannot disagree.
 */
export class LlamaRuntimeController {
  private chain: Promise<unknown> = Promise.resolve();
  private readonly deps: Deps;

  constructor(private readonly files: LlamaRuntimeFiles, private readonly timeoutMs = 240_000, deps: Partial<Deps> = {}) {
    this.deps = { ...defaultDeps, ...deps };
  }

  async state(): Promise<LlamaRuntimeState> {
    const gone: LlamaRuntimeState = { status: 'offline', modelId: null, contextWindow: null, error: LAUNCHER_ABSENT };
    let parsed: LlamaRuntimeState | null;
    try {
      parsed = parseLlamaRuntimeState(await this.deps.readText(this.files.stateFile));
    } catch { return gone; }
    if (!parsed) return { status: 'offline', modelId: null, contextWindow: null, error: 'Состояние llama.cpp не читается' };
    // A state file outlives its launcher; only a live launcher can vouch for it.
    if (parsed.launcherPid !== undefined && !(await this.deps.readText(`/proc/${parsed.launcherPid}/cmdline`).then((text) => text.includes('run-local-ai-desktop-llama-cpp-mtp.sh'), () => false))) return gone;
    const startTime = async (pid: number) => {
      const raw = await this.deps.readText(`/proc/${pid}/stat`).catch(() => '');
      return raw.slice(raw.lastIndexOf(') ') + 2).trim().split(/\s+/)[19];
    };
    if (parsed.launcherPid && parsed.launcherStartTime && await startTime(parsed.launcherPid) !== parsed.launcherStartTime) return gone;
    if (parsed.status === 'ready' && parsed.serverPid) {
      const commandLine = await this.deps.readText(`/proc/${parsed.serverPid}/cmdline`).catch(() => '');
      // Runtime settings permit renamed/custom server binaries. Recognize the
      // launch arguments, rather than requiring a particular executable name.
      const args = commandLine.split('\0');
      if (!args.includes('--port') || !args.includes('--ctx-size') || parsed.serverStartTime && await startTime(parsed.serverPid) !== parsed.serverStartTime) {
        return { ...parsed, status: 'offline', modelId: null, contextWindow: null, error: SERVER_ABSENT };
      }
    }
    if (parsed.status === 'ready' && !parsed.projectorDevice && parsed.serverPid) {
      // Older launchers did not publish projector placement. Inspect only the live
      // command line so upgrading does not require an otherwise redundant restart.
      const args = (await this.deps.readText(`/proc/${parsed.serverPid}/cmdline`).catch(() => '')).split('\0');
      if (args.includes('--mmproj')) parsed.projectorDevice = args.includes('--no-mmproj-offload') ? 'cpu' : 'gpu';
    }
    return parsed;
  }

  /** Switches are serialized: two concurrent requests would otherwise race on one request file. */
  switchTo(modelId: string, contextWindow: number, kvCacheType: LlamaKvCacheType = 'f16', kvOffload = true, projectorDevice?: 'cpu' | 'gpu', mtpMode?: MtpMode): Promise<LlamaSwitchResult> {
    const run = this.chain.then(() => this.perform(modelId, contextWindow, kvCacheType, kvOffload, projectorDevice, mtpMode));
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async perform(modelId: string, contextWindow: number, kvCacheType: LlamaKvCacheType, kvOffload: boolean, projectorDevice?: 'cpu' | 'gpu', mtpMode?: MtpMode): Promise<LlamaSwitchResult> {
    if (mtpMode !== undefined && !['auto', 'on', 'off'].includes(mtpMode)) return { ok: false, state: await this.state(), error: 'Invalid MTP mode' };
    const profile = llamaRuntimeProfile(modelId);
    if (!profile) return { ok: false, state: await this.state(), error: `Модель ${modelId} не поддерживается llama.cpp runtime` };
    if (!Number.isSafeInteger(contextWindow) || contextWindow < 4_096 || contextWindow > await this.deps.capabilityLimit(modelId) || contextWindow % 4_096 !== 0) return { ok: false, state: await this.state(), error: `Контекст ${contextWindow} не поддерживается для ${modelId}` };

    const launcherPid = Number((await this.deps.readText(this.files.launcherPidFile).catch(() => '')).trim());
    if (!Number.isSafeInteger(launcherPid) || launcherPid <= 0) return { ok: false, state: await this.state(), error: 'Launcher llama.cpp не запущен: перезапуск модели невозможен без него.' };
    const commandLine = await this.deps.readText(`/proc/${launcherPid}/cmdline`).catch(() => '');
    if (!commandLine.includes('run-local-ai-desktop-llama-cpp-mtp.sh')) return { ok: false, state: await this.state(), error: 'PID launcher не принадлежит Local AI Desktop.' };

    const requestId = randomUUID();
    await mkdir(dirname(this.files.requestFile), { recursive: true });
    const temporary = `${this.files.requestFile}.${process.pid}.tmp`;
    await writeFile(temporary, `REQUEST_ID=${requestId}\nMODEL_ID=${modelId}\nCONTEXT=${contextWindow}\nKV_TYPE=${kvCacheType}\nKV_OFFLOAD=${kvOffload ? 1 : 0}\n${projectorDevice ? `PROJECTOR_DEVICE=${projectorDevice}\n` : ''}${mtpMode ? `MTP_MODE=${mtpMode}\n` : ''}`, 'utf8');
    await rename(temporary, this.files.requestFile);
    try { this.deps.signal(launcherPid); }
    catch (error) {
      await rm(this.files.requestFile, { force: true });
      return { ok: false, state: await this.state(), error: `Не удалось передать запрос launcher: ${error instanceof Error ? error.message : String(error)}` };
    }

    const deadline = this.deps.now() + this.timeoutMs;
    while (this.deps.now() < deadline) {
      const state = await this.state();
      if (state.requestId === requestId && (state.status === 'ready' || state.status === 'offline')) {
        if (state.status === 'ready' && !state.error && state.modelId === modelId && state.contextWindow === contextWindow && state.kvCacheType === kvCacheType && state.kvOffload === kvOffload && (!projectorDevice || state.projectorDevice === projectorDevice) && (!mtpMode || state.mtpMode === mtpMode && (mtpMode !== 'on' || state.speculativeMode === 'mtp') && (mtpMode !== 'off' || state.speculativeMode === 'none'))) return { ok: true, state };
        return { ok: false, state, error: state.error ?? `llama.cpp не подтвердил запрошенную конфигурацию: ${modelId}, ${contextWindow / 1024}K ${kvCacheType}, KV ${kvOffload ? 'GPU' : 'RAM'}; активно ${state.modelId ?? 'none'}, ${(state.contextWindow ?? 0) / 1024}K ${state.kvCacheType ?? '?'}, KV ${state.kvOffload ? 'GPU' : 'RAM'}.` };
      }
      await this.deps.sleep(500);
    }
    return { ok: false, state: await this.state(), error: 'Launcher llama.cpp не ответил на запрос смены модели вовремя' };
  }
}
