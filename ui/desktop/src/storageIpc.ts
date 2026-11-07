// Local AI Desktop: native picker, explicit confirmation and offline maintenance handoff.
import { app, BrowserWindow, dialog, ipcMain, session } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { StorageService } from './storageService';
import type { StorageChoice } from './storageTypes';
import { processIdentity, type StorageWorkerRequest } from './storageWorkerProtocol';
export function registerStorageIpc(service: StorageService, stopBackends: () => Promise<void>) {
  let applying = false;
  const authorized = (id: number) => {
    if (!BrowserWindow.getAllWindows().some((w) => w.webContents.id === id))
      throw new Error('Unknown app window');
  };
  ipcMain.handle('storage-status', (e) => {
    authorized(e.sender.id);
    return service.status();
  });
  ipcMain.handle('storage-choose', async (e) => {
    authorized(e.sender.id);
    if (applying) throw new Error('migrationBusy');
    const selected = await dialog.showOpenDialog(BrowserWindow.fromWebContents(e.sender)!, {
      title: 'Application Storage / Хранилище приложения',
      properties: ['openDirectory', 'createDirectory'],
    });
    return selected.canceled ? null : (selected.filePaths[0] ?? null);
  });
  ipcMain.handle('storage-preview', (e, choice: StorageChoice) => {
    authorized(e.sender.id);
    if (applying) throw new Error('migrationBusy');
    return service.preview(choice);
  });
  const handoff = async (operation: 'apply' | 'rollback', choice?: StorageChoice) => {
    const file = path.join(service.environment.configHome, 'local-ai-desktop-storage-worker.json');
    const request: StorageWorkerRequest = {
      version: 1,
      environment: service.environment,
      operation,
      choice,
      parentPid: process.pid,
      parentIdentity: processIdentity(process.pid),
      launchArgs: process.argv.slice(1),
    };
    try {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file + '.tmp', JSON.stringify(request), { mode: 0o600 });
      await fs.rename(file + '.tmp', file);
      // Stop all renderer activity, flush Chromium, then let the helper wait for our full exit.
      for (const win of BrowserWindow.getAllWindows()) win.setEnabled(false);
      await stopBackends();
      session.defaultSession.flushStorageData();
      await session.defaultSession.cookies.flushStore();
      const args = request.launchArgs.filter(
        (arg) =>
          !arg.startsWith('--remote-debugging-port') && !arg.startsWith('--remote-debugging-pipe')
      );
      const child = spawn(process.execPath, args, {
        env: { ...process.env, LOCAL_AI_DESKTOP_STORAGE_WORKER: file },
        detached: true,
        stdio: 'ignore',
      });
      await new Promise<void>((resolve, reject) => {
        child.once('spawn', resolve);
        child.once('error', reject);
      });
      child.unref();
      app.quit();
    } catch (error) {
      applying = false;
      await fs.rm(file, { force: true });
      await dialog.showMessageBox({
        type: 'error',
        title: 'Application Storage / Хранилище приложения',
        message:
          'The transfer could not start. Original data is retained. Restart the app and retry. / Не удалось начать перенос. Исходные данные сохранены. Перезапустите приложение и повторите попытку.',
        detail: String(error),
      });
      for (const win of BrowserWindow.getAllWindows()) win.setEnabled(true);
    }
  };
  ipcMain.handle('storage-apply', async (e, choice: StorageChoice) => {
    authorized(e.sender.id);
    if (applying) throw new Error('migrationBusy');
    const p = await service.preview(choice);
    if (applying) throw new Error('migrationBusy');
    if (p.unchanged) return;
    applying = true;
    setTimeout(() => void handoff('apply', choice), 50);
  });
  ipcMain.handle('storage-cleanup', async (e) => {
    authorized(e.sender.id);
    if (applying) throw new Error('migrationBusy');
    applying = true;
    try {
      const answer = await dialog.showMessageBox(BrowserWindow.fromWebContents(e.sender)!, {
        type: 'question',
        title: 'Application Storage / Хранилище приложения',
        message:
          'Remove verified previous transfer copies? Historical migration sources and backups are retained. / Удалить проверенные предыдущие копии? Исторические исходники и резервные архивы сохраняются.',
        buttons: ['Cancel / Отмена', 'Free space / Освободить место'],
        defaultId: 0,
        cancelId: 0,
      });
      if (answer.response === 1) await service.cleanup();
    } finally {
      applying = false;
    }
  });
  ipcMain.handle('storage-rollback', async (e) => {
    authorized(e.sender.id);
    if (applying) throw new Error('migrationBusy');
    applying = true;
    setTimeout(() => void handoff('rollback'), 50);
  });
}
