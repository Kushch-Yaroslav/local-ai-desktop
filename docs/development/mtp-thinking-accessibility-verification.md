# MTP, Thinking/Effort and monitoring accessibility — 2026-11-05

## Implemented changes

- The unified model menu now has a small lightning action only when the selected runtime and GGUF pass the existing embedded-head validator. No external draft is assumed. The icon distinguishes saved On, actual active `draft-mtp`, Off and reload pending. Clicking the action saves only speculativeMode, keeps the menu open and does not select the model or start weights. Draft token count and all other profile fields are retained. Pending loaded changes offer an explicit confirmation/reload action using the shared runtime lease and existing dependent-agent activity guard.
- A request for an already loaded profile keeps using its effective configuration. Saving MTP no longer causes the next message to silently restart the model. Explicit reload uses saved settings plus existing context overrides.
- Local thinking models have separate Thinking On/Off and qualitative Effort. The audited Qwen template supports low, medium and xhigh (Goose transport `high`); High and Ultra are not invented. Toggle-only templates get no effort selector. Cloud controls retain Goose's capability path.
- Numeric budget UI was removed. Backend support remains. An explicit local Thinking/Effort choice clears a stale budget to -1 (backend default), rather than mapping effort labels to arbitrary token counts. Opening controls does not reset settings. New-chat drafts apply configuration before the first prompt; a local-only default-budget reset is omitted if a subsequently selected cloud session never advertised that capability.
- Appearance now says where monitoring appears. The existing informational RAM/VRAM service and page-only polling were retained; no discovery memory formulas or resource safeguards changed.

## Real packaged Electron verification

The app was initially stopped. The existing GNOME desktop ID `local-ai-desktop-goose-dev` cold-launched the rebuilt package, Electron PID 21583 and bundled Goose PID 21846. The mapped X11 window had WM_CLASS `local-ai-desktop-goose-dev`. Backend readiness was confirmed by startup diagnostics.

The desktop focus was in an unrelated user application. Coordinate automation was stopped following an automatic safety rejection. Subsequent interactions used chrome-devtools-cli attached only to a deliberately launched isolated Electron test instance, with temporary data at `/tmp/lad-mtp-ui-owned` and loopback debugging. No user chats, credentials or weights were copied. One saved profile and UI preferences were copied for testing. These screenshots are real packaged Electron, not Chromium fixtures or physical GNOME mouse clicks.

Observed:

- Real target capability: embeddedMtp=true, thinking=true, nativeEfforts=true, vision=true.
- Clicking MTP saved mtp-embedded while runtime remained idle and the selector stayed open.
- Low was selectable; Thinking Off removed Effort; On restored Low. No numeric budget selector was present.
- Appearance displayed the Russian location helper. Local Inference displayed RAM approximately 9.4–10.0 / 62.7 GiB and physical VRAM 0.9 / 24.0 GiB. nvidia-smi corroborated physical memory readings (912 MiB at one sample).
- Off hid the widget. No test-owned nvidia-smi sample was observed for 3.5 seconds. On showed it again. After normal window close and restarting only the isolated instance, On persisted and real readings reappeared without toggling. No widget was present in chat.

## Bounded real GPU/protocol check

A single copied Qwen27B-3.8 profile was loaded at 8192 context, with projector and embedded MTP. Before loading, free VRAM was 23161 MiB. Ready state used `--spec-type draft-mtp --spec-draft-n-max 2 --ctx-size 8192`. A later total VRAM sample was 20350 MiB used, 3769 MiB free. No performance claim is made.

Saving Off while loaded showed reload pending and left draft-mtp active. A first Goose message with draft Chat Only / Thinking Off returned OK. A subsequent existing-session Low selection produced structural gateway evidence:

- system, user and assistant message roles retained;
- 17 tool schemas and Goose instructions retained;
- enable_thinking=true, reasoning_effort=low, reasoning_budget_tokens=-1;
- response reasoning_content present, finish_reason=stop, SSE DONE=true.

Pending Off stayed unapplied during both requests. Explicit confirmation/reload then returned Ready with no draft-mtp and context still 8192. Only the test-owned model was unloaded; its state became idle, then the isolated app was normally closed. No llama-server remained. This was not a new Vision/MTP matrix, tool-execution benchmark or context-discovery run. Actual MCP execution was not repeated; protocol/tool-call regressions passed on fixtures and existing earlier GPU results were not relabelled as new tests.

## Final package and validation

A final narrow cloud-draft budget-reset guard was packaged after the UI/GPU checks; it does not change those controls or local inference serialization. Both owned test instances were closed before installing the final candidate at the original path. The final GNOME cold start produced Electron PID 28175, bundled Goose PID 28441, a mapped window and backend_ready diagnostics. No inference process was left running.

Installed executable:
`ui/desktop/out/Local AI Desktop-linux-x64/Local AI Desktop`

Version: 0.4.0-development. Backend is executable and matches src/bin/goose. Launcher, desktop IDs, AppArmor and sandbox options were unchanged; global userns restriction remained 1. No --no-sandbox was introduced. Backups of the prior packages remain in out-before-mtp-accessibility and out-tested-mtp-accessibility.

- 9 focused test files: 68 tests passed, including real owned fixture child processes/HTTP, quick actions, pending reload, new-chat barrier, cloud isolation, telemetry, speculation validation and tool/SSE fidelity.
- TypeScript: passed.
- Targeted ESLint: passed, zero warnings.
- EN extraction check and RU validation: passed, 1817 messages.
- git diff --check: passed.
- Electron Forge packaging: passed; no Rust rebuild was needed.

The user's GGUF profile files, context overrides, saved discovery results and application settings were compared by hash and left unchanged. In particular the user's 98304 FP16 configuration and saved MTP choices were not replaced by the temporary 8192 test profile. The existing explicit memoryMonitoring=true preference was retained. The old application, upstream Goose, model weights and drivers were not modified. No commit, push, tag or release.

## Files changed in this continuation

- src/managedGguf.ts, src/preload.ts
- src/components/settings/models/bottom_bar/MtpQuickControl.tsx and ModelsBottomBar.tsx
- src/components/SessionSettingsPopover.tsx
- src/acp/newChatSettings.ts
- src/components/settings/app/AppSettingsSection.tsx
- src/components/settings/localInference/MemoryMonitor.tsx
- src/i18n/messages/en.json and ru.json (compiled resources regenerated)
- managedGguf, ModelsBottomBar, SessionSettingsPopover and newChatSettings tests
- This report and screenshots under docs/screenshots/lad-access-*.png.

Screenshots: mtp-electron, mtp-active-electron, mtp-pending-electron, thinking-electron, appearance-electron, memory-electron and memory-restart-electron.
