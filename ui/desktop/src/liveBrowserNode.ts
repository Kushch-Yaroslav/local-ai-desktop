/** Local AI Desktop: validate the actual Node runtime, not just its presence. */
import { spawn } from 'node:child_process';

// playwright-core's installed package requires Node >=20.
export const LIVE_BROWSER_NODE_PROBE =
  "process.exit(Number(process.versions.node.split('.')[0]) >= 20 ? 0 : 78)";

export function probeLiveBrowserNode(
  cmd: string,
  env: Record<string, string>,
  timeoutMs = 8000,
): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(cmd, ['-e', LIVE_BROWSER_NODE_PROBE], {
      env: { ...process.env, ...env }, stdio: 'ignore',
    });
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(false); }, timeoutMs);
    child.once('error', () => { clearTimeout(timer); resolve(false); });
    child.once('exit', (code) => { clearTimeout(timer); resolve(code === 0); });
  });
}
