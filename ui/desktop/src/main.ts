// Local AI Desktop: select the maintenance process before loading normal app modules.
import { app, dialog } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { recoverInterruptedStorage, verifyCommittedStorageSync } from './storageService';
import { readStorageConfiguration } from './storagePaths';
import { readWorkerRequest, requestIsActive } from './storageWorkerProtocol';
const worker = process.env.LOCAL_AI_DESKTOP_STORAGE_WORKER;
if (worker) {
  // Chromium in this process must never open the user's original profile.
  app.setPath(
    'userData',
    fs.mkdtempSync(
      path.join(
        process.platform === 'linux' ? (process.env.XDG_RUNTIME_DIR ?? '/tmp') : os.tmpdir(),
        'local-ai-storage-maintenance-'
      )
    )
  );
  void import('./storageWorker')
    .then(({ runStorageWorker }) => runStorageWorker(worker))
    .catch((error) => {
      dialog.showErrorBox('Application Storage / Хранилище приложения', String(error));
      app.exit(1);
    });
} else {
  const file = path.join(
    process.env.XDG_CONFIG_HOME ?? app.getPath('appData'),
    'local-ai-desktop-storage-worker.json'
  );
  const request = readWorkerRequest(file);
  if (request && requestIsActive(request)) {
    dialog.showErrorBox(
      'Application Storage / Хранилище приложения',
      'Storage migration is running. Wait for it to finish. / Выполняется перенос хранилища. Дождитесь его завершения.'
    );
    app.exit(1);
  } else {
    if (request) fs.unlinkSync(file);
    const configHome = process.env.XDG_CONFIG_HOME ?? app.getPath('appData');
    try {
      recoverInterruptedStorage(configHome);
      readStorageConfiguration(configHome); // Mounted volumes must be checked before any state is opened.
      verifyCommittedStorageSync(configHome);
      void import('./desktopMain');
    } catch (error) {
      void app.whenReady().then(async () => {
        const answer = await dialog.showMessageBox({
          type: 'error',
          title: 'Application Storage / Хранилище приложения',
          message:
            'Storage is unavailable or verification failed. No backend was started. / Хранилище недоступно или не прошло проверку. Backend не запущен.',
          detail: String(error),
          buttons: [
            'Exit and retry / Выйти и повторить',
            'Restore unverified transfer / Отменить непроверенный перенос',
          ],
          defaultId: 0,
          cancelId: 0,
        });
        if (answer.response === 1) {
          try {
            recoverInterruptedStorage(configHome, true);
            app.relaunch();
          } catch (rollbackError) {
            dialog.showErrorBox('Application Storage', String(rollbackError));
          }
        }
        app.exit(1);
      });
    }
  }
}
