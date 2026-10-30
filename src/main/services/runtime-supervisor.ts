import {liveLauncherPid} from './launcher-identity';
import { spawn, type ChildProcess } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { paths } from './paths';
import { log } from './logger';

let owned: ChildProcess | undefined;
let starting:Promise<number>|undefined;
export function startRuntimeSupervisor():Promise<number> {
  if(starting)return starting;
  starting=ensureSupervisor().finally(()=>{starting=undefined;});return starting;
}
async function ensureSupervisor(): Promise<number> {
  const stateFile=join(paths.dataRoot,'llama-cpp-runtime-state.json');
  const files={stateFile,launcherPidFile:join(paths.dataRoot,'llama-cpp-mtp-launcher.pid')};
  const ownedPid=owned?.exitCode===null&&owned.signalCode===null?owned.pid:undefined;
  const live=await liveLauncherPid(files,undefined,ownedPid??process.ppid);
  if(live)return live;
  owned = spawn('bash', [join(paths.root, 'run-local-ai-desktop-llama-cpp-mtp.sh')], { env: { ...process.env,
    LOCAL_AI_APP_DIR: paths.root, LOCAL_AI_ELECTRON_BIN: process.execPath,
    LOCAL_AI_LAUNCHER_HEADLESS: '1', LOCAL_AI_PARENT_PID: String(process.pid),
  }, stdio: ['ignore', 'ignore', 'pipe'] });
  owned.stderr?.on('data', (data: Buffer) => log('runtime.supervisor.stderr', data.toString()));
  let startupError:Error|undefined;
  owned.on('error', (error) => {startupError=error;log('runtime.supervisor.error',error.message);});
  owned.on('exit', (code) => log('runtime.supervisor.exit', { code }));
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if(startupError)throw startupError;
    if (owned.exitCode !== null||owned.signalCode!==null)throw new Error(`Launcher exited during initialization (${owned.exitCode??owned.signalCode})`);
    try { if (owned.pid&&JSON.parse(await readFile(stateFile, 'utf8')).launcherPid === owned.pid) return owned.pid; } catch { /* Wait for atomic state write. */ }
    await new Promise((done) => setTimeout(done, 50));
  }
  owned.kill('SIGTERM');
  throw new Error('Launcher initialization timed out; no runtime was confirmed');
}

export async function stopRuntimeSupervisor(): Promise<void> {
  if (!owned || owned.exitCode !== null || owned.signalCode !== null) return;
  const child = owned;
  await new Promise<void>((done) => {
    const timer = setTimeout(done, 12_000);
    child.once('exit', () => { clearTimeout(timer); done(); });
    child.kill('SIGTERM');
  });
  owned = undefined;
}
