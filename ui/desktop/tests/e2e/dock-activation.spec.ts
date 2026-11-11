import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
test('second instance reveals hidden and minimized packaged windows', async () => {
  test.setTimeout(90000);
  const executablePath = process.env.LAD_E2E_PACKAGED_EXECUTABLE!;
  test.skip(!executablePath, 'packaged executable required');
  const root = mkdtempSync(join(tmpdir(), 'lad-dock-profile-'));
  const xdg = mkdtempSync(join(tmpdir(), 'lad-dock-xdg-'));
  mkdirSync(join(root, 'electron'), { recursive: true });
  writeFileSync(join(root, 'electron', 'settings.json'), '{}');
  const env = {
    ...process.env,
    LOCAL_AI_DESKTOP_DEV_ROOT: root,
    GOOSE_PATH_ROOT: join(root, 'goose-backend'),
    XDG_CONFIG_HOME: xdg,
    ELECTRON_RUN_AS_NODE: '',
  };
  const app = await electron.launch({ executablePath, args: ['--disable-setuid-sandbox'], env });
  try {
    await app.firstWindow();
    for (const minimized of [false, true]) {
      await app.evaluate(({ BrowserWindow }, minimized) => {
        const w = BrowserWindow.getAllWindows().find(
          (w) => !w.webContents.getURL().startsWith('about:')
        )!;
        if (minimized) w.minimize();
        else w.hide();
      }, minimized);
      const child = spawn(executablePath, ['--disable-setuid-sandbox'], { env, stdio: 'ignore' });
      await expect
        .poll(
          () =>
            app.evaluate(({ BrowserWindow }) =>
              BrowserWindow.getAllWindows().some(
                (w) => w.isVisible() && !w.isMinimized() && w.isFocused()
              )
            ),
          { timeout: 15000 }
        )
        .toBe(true);
      await new Promise<void>((resolve, reject) => {
        if (child.exitCode !== null) resolve();
        else {
          child.once('exit', () => resolve());
          child.once('error', reject);
        }
      });
    }
  } finally {
    await app.close();
  }
});
