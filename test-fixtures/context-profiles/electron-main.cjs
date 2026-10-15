const { app, BrowserWindow, ipcMain } = require('electron');
const { resolve } = require('node:path');
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const fixture = await require(resolve('dist/main/ipc/context-profiles.test.js')).contextProfileFixture(process.env.LOCAL_AI_RUNTIME_ROOT, true);
  global.contextFixture = fixture;
  ipcMain.handle('fixture:flags', (_event, flags) => fixture.set(flags));
  const window = new BrowserWindow({ width: 1280, height: 900, webPreferences: { preload: resolve('dist/preload/index.js'), contextIsolation: true, nodeIntegration: false, sandbox: false } });
  await window.loadFile(resolve('dist/renderer/index.html'));
}).catch(error => { console.error(error); app.exit(1); });
