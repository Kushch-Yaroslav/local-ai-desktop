// A real Electron window/preload and Rust child; only model responses and
// conversation storage are fixtures. Never opens the user's database/project.
const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const { join } = require('node:path');
const { mkdirSync, writeFileSync, renameSync } = require('node:fs');
const { AutonomySessions } = require('../../dist/main/services/autonomy-session');
const autonomy = new AutonomySessions();
const { ApprovalBroker } = require('../../dist/main/services/approval-broker');
const { RustAgentRuntime } = require('../../dist/main/services/rust-agent-runtime');
const { DiagramValidationBridge } = require('../../dist/main/services/diagram-validation');
const root = process.env.LOCAL_AI_APPROVAL_FIXTURE_ROOT;
const broker = new ApprovalBroker(30000);
const diagram = new DiagramValidationBridge();
const agent = new RustAgentRuntime(process.env.LOCAL_AI_APPROVAL_FIXTURE_ENDPOINT);
const conversation = { id: 'approval-fixture', title: 'Permission regression', mode: 'agent', workingDirectory: root, modelId: 'fixture', contextWindow: 32768, reasoningMode: 'fast', createdAt: '', updatedAt: '', webMode: 'off' };
const content = [
  "```mermaid\nflowchart LR\n  client[Vue 3 клиент\\ncient/client, порты 8888] -->|/api, /convert,\\n/enhance, /translate, /remove-bg| server[Node/Express сервер\\nserver/, порты 3000]\n  server -->|spawn Python| rembg[.venv-rembg\\nrembg + onnxruntime-gpu\\nудаление фона]\n  server -->|spawn Python| nllb[.venv-translate\\nPyTorch CUDA + NLLB-200 3.3B\\nперевод JSON]\n  server -->|spawn бинарник| ncnn[realesrgan-ncnn-vulkan /\\nwaifu2x-ncnn-vulkan\\nAI-апскейл]\n  server --> sharp[sharp (npm)\\nсжатие/конверт/resize]\n```",
  '```mermaid\nflowchart LR\n A[sharp (npm)\\nserver/src/image.js] --> B[Aya Expanse 8B]\n```',
  '```mermaid\nflowchart LR\\n A["C:\\new\\node"] --> B[OK]\n```',
  '```mermaid\nflowchart LR\n invalid @@@\n```',
  '```python\nprint("ordinary code survives")\n```',
].join('\n\n');
const messages = [{ id: 'diagrams', conversationId: conversation.id, role: 'assistant', createdAt: '', content }];
let active;
mkdirSync(process.env.LOCAL_AI_RUNTIME_ROOT, { recursive: true });
const loopStages = [];
const runStateFile = join(process.env.LOCAL_AI_RUNTIME_ROOT, 'approval-active.json');
const persistActive = () => {
  writeFileSync(runStateFile+'.tmp', JSON.stringify({ active: active?.runId ?? null, loopStages }));
  renameSync(runStateFile+'.tmp', runStateFile);
};
persistActive();
const transcript = [];
ipcMain.handle('conversations:list', () => [conversation]);
ipcMain.handle('messages:list', () => messages);
ipcMain.handle('agent-plan:get', () => null);
ipcMain.handle('agent-plan:legacy', () => null);
ipcMain.handle('agent-tasks:list', () => []);
ipcMain.handle('analysis:list', () => []);
ipcMain.handle('models:list', () => [{ id: 'fixture', name: 'Fixture', shortName: 'Fixture', installed: true, supportedContextPresets: [32768], maxContext: 32768, reasoning: { thinkingToggle: true, efforts: [] } }]);
ipcMain.handle('settings:get', () => ({ uiLanguage: 'en', modelsPath: '', llamaServerPath: null, llamaRuntime: { status: 'ready', modelId: 'fixture', contextWindow: 32768 } }));
ipcMain.handle('hardware:get', () => null);
ipcMain.handle('browser-qa:status', () => ({mode:'off',autonomous:false,available:false}));
ipcMain.handle('context:estimate', () => ({ unknownReasons: [], configuredMaxTokens: 32768 }));
ipcMain.handle('context:discovery-status', () => ({ busy: false }));
ipcMain.handle('chat:diagram-validation-result', (event, id, error) => diagram.reply(event.sender.id, id, error));
ipcMain.handle('chat:approve', (event, request) => active?.runId === request.generationId && broker.reply(event.sender.id, request));
ipcMain.handle('chat:permissions', () => autonomy.get(conversation.id));
ipcMain.handle('chat:grants', (_event, _id, runId) => broker.list(runId||conversation.id));
ipcMain.handle('chat:set-permissions', async (_event, _id, mode, trust) => {
  const permissions = await autonomy.set(conversation.id, mode, [root], trust, async () => (await dialog.showMessageBox({ message: 'Absolute Autopilot can cause data loss. Arbitrary scripts, deletion, Git history, installs and access outside the project.', buttons: ['Cancel', 'Enable Absolute Autopilot'], defaultId: 0, cancelId: 0 })).response === 1);
  if (active) await agent.control(active.runId, { permissions }); return permissions;
});
ipcMain.handle('chat:loop-control', (_event, _id, runId, signature, action) => agent.control(runId, { signature, action }));
ipcMain.handle('chat:revoke-approvals', (_event, _conversationId, runId, grantId) => { broker.revoke(conversation.id, grantId); return true; });
ipcMain.handle('chat:stop', () => { active?.abort.abort(); });
ipcMain.handle('chat:send', async (event, request) => {
  const abort = new AbortController(); active = { abort, runId: request.generationId };
  persistActive();
  transcript.length = 0; loopStages.length = 0;
  const emit = chunk => { transcript.push(chunk); if (chunk.type === 'loop-event') { loopStages.push(chunk.lifecycle.stage); persistActive(); } event.sender.send('chat:stream', { ...chunk, conversationId: conversation.id, generationId: request.generationId }); };
  try {
    const stream = agent.stream('fixture', request.messages, [{ id: 'project', slot: 1, label: 'Fixture project', root }], abort.signal, 32768, 'fast', 'off', request.generationId, undefined, conversation.id, false, undefined, [], (source, signal) => diagram.validate(event.sender, source, signal), broker.forRun(event.sender, conversation.id, request.generationId), undefined, autonomy.get(conversation.id));
    let output = '';
    for await (const chunk of stream) {
      if (chunk.type === 'token') output += chunk.content;
      if (chunk.type === 'done') emit({ ...chunk, assistant: { id: request.generationId, conversationId: conversation.id, role: 'assistant', content: output, createdAt: '' } });
      else emit(chunk);
    }
    if (abort.signal.aborted) emit({ type: 'cancelled' });
  } finally { broker.endRun(request.generationId); active = undefined; persistActive(); }
});
app.setPath('userData', process.env.LOCAL_AI_RUNTIME_ROOT);
app.whenReady().then(async () => {
  const window = new BrowserWindow({ width: 1200, height: 1000, webPreferences: { preload: join(__dirname, '../../dist/preload/index.js'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  global.approvalFixture = { transcript, active: () => active?.runId ?? null };
  await window.loadFile(join(__dirname, '../../dist/renderer/index.html'));
});
app.on('before-quit', () => active?.abort.abort());
app.on('window-all-closed', () => app.quit());
