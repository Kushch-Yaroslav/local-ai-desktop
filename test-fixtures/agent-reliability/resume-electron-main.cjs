const { app, BrowserWindow } = require('electron');
const { resolve, join } = require('node:path');
const { mkdirSync } = require('node:fs');
app.disableHardwareAcceleration();
const profile = join(process.env.LOCAL_AI_RUNTIME_ROOT, 'electron-profile');
mkdirSync(profile, { recursive: true }); app.setPath('userData', profile);
app.whenReady().then(async () => {
  const fixture = await require(resolve('dist/main/ipc/context-profiles.test.js')).contextProfileFixture(process.env.LOCAL_AI_RUNTIME_ROOT, true);
  const workspace = process.env.LOCAL_AI_AGENT_FIXTURE_WORKSPACE || join(process.env.LOCAL_AI_RUNTIME_ROOT, 'workspace'); mkdirSync(workspace, { recursive: true });
  fixture.db.updateConversation(fixture.chat.id, { mode: 'agent', workingDirectory: workspace });
  fixture.db.recoverInterruptedRuns();
  global.resumeFixture = { id: fixture.chat.id, workspace, modelId: fixture.modelId, db: fixture.db };
  const window = new BrowserWindow({ width: 1280, height: 1000, webPreferences: { preload: resolve('dist/preload/index.js'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  await window.loadFile(resolve('dist/renderer/index.html'));
}).catch(error => { console.error(error); app.exit(1); });
app.on('window-all-closed', () => app.quit());
