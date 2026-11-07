// Local AI Desktop: the main app has exited before any snapshot is copied.
import { app, BrowserWindow, dialog } from 'electron';
import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { StorageService } from './storageService';
import { readWorkerRequest, processIdentity } from './storageWorkerProtocol';
import type { StorageProgress } from './storageTypes';
export async function runStorageWorker(file: string) {
  const request = readWorkerRequest(file);
  if (!request) throw new Error('Storage maintenance request missing');
  request.workerPid = process.pid;
  request.workerIdentity = processIdentity(process.pid);
  await fs.writeFile(file + '.tmp', JSON.stringify(request), { mode: 0o600 });
  await fs.rename(file + '.tmp', file);
  await app.whenReady();
  const win = new BrowserWindow({
    width: 600,
    height: 290,
    resizable: false,
    closable: false,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      partition: 'storage-maintenance',
    },
  });
  await win.loadURL(
    'data:text/html;charset=utf-8,' +
      encodeURIComponent(
        `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><style>body{font:16px system-ui;background:#16181d;color:#eee;padding:28px}h2{font-size:21px}#phase{margin-top:24px;color:#b8c7ef}</style><h2>Moving application storage / Перенос хранилища</h2><p>Keep this window open. Originals are retained.<br>Не закрывайте окно. Исходные данные сохраняются.</p><p id="phase">Waiting for the app to close / Завершение приложения…</p><p id="count">…</p>`
      )
  );
  let lastUpdate = 0,
    lastPhase = '';
  const update = (p: StorageProgress) => {
    if (p.phase === lastPhase && Date.now() - lastUpdate < 100 && p.completed < p.total) return;
    lastUpdate = Date.now();
    lastPhase = p.phase;
    win.setProgressBar(p.total > 0 ? p.completed / p.total : 2);
    const phases: Record<string, string> = {
      checking: 'Checking storage / Проверка хранилища',
      copying: 'Copying and verifying / Копирование и сверка',
      verifying: 'Checking databases / Проверка баз данных',
      restarting: 'Restarting / Перезапуск',
    };
    void win.webContents
      .executeJavaScript(
        `document.getElementById('phase').textContent=${JSON.stringify(phases[p.phase] ?? p.phase)};document.getElementById('count').textContent=${JSON.stringify(p.total > 0 ? Math.round((100 * p.completed) / p.total) + '%' : '…')}`
      )
      .catch(() => {});
  };
  const service = new StorageService(request.environment, update);
  const stopped = async () => {
    const deadline = Date.now() + 30000;
    while (processIdentity(request.parentPid) === request.parentIdentity) {
      if (Date.now() > deadline) throw new Error('storageInUse: original app has not exited');
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  };
  let failed = false;
  try {
    await stopped();
    if (request.operation === 'rollback') await service.rollback(stopped);
    else {
      if (!request.choice) throw new Error('Storage choice missing');
      await service.transfer(request.choice, stopped);
    }
  } catch (error) {
    failed = true;
    await dialog.showMessageBox(win, {
      type: 'error',
      title: 'Application Storage / Хранилище приложения',
      message:
        'Transfer stopped. Original data is retained. / Перенос остановлен. Исходные данные сохранены.',
      detail: String(error),
      buttons: ['Open previous storage / Открыть прежнее хранилище'],
      noLink: true,
    });
  }
  const environment = { ...process.env };
  delete environment.LOCAL_AI_DESKTOP_STORAGE_WORKER;
  await fs.rm(file, { force: true });
  const child = spawn(process.execPath, request.launchArgs, {
    env: environment,
    detached: true,
    stdio: 'ignore',
  });
  child.on('error', (error) => {
    dialog.showErrorBox('Application Storage', String(error));
  });
  child.unref();
  win.destroy();
  app.exit(failed ? 1 : 0);
}
