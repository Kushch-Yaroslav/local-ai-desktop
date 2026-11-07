# Session controls / memory monitoring completion — 2026-11-05

This continuation made no implementation changes and did not rebuild the already
current package. Existing uncommitted changes were preserved. No GPU inference,
Vision/MTP matrix or benchmark was repeated.

## Actual desktop verification

No Goose Dev or llama-server process was running at the initial host inventory.
The existing GNOME desktop ID `local-ai-desktop-goose-dev` launched a new test-owned
Electron instance (PID 8851) and the bundled backend. The actual mapped X11 window
was `0x3400004`, WM_CLASS `local-ai-desktop-goose-dev`.

Appearance showed the Russian label “Мониторинг потребления памяти” and saved On.
Local Inference displayed physical system values: approximately RAM 7.7/62.7 GiB
and VRAM 0.7/24.0 GiB. During a 3.6-second observation, two nvidia-smi child samples
were seen, with maximum concurrency one.

Only that owned instance was normally quit using Quit. Launching the same GNOME
entry created a new instance (PID 10239). On persisted; the widget appeared again
without toggling it (approximately RAM 7.5/62.7 GiB, VRAM 0.7/24.0 GiB).

The requested original Off was then restored through the actual Appearance
switch. settings.json contains false. The widget disappeared from Local Inference;
no nvidia-smi sample was observed during the subsequent 3.6-second observation.
The app and backend remained alive after the initiating test units were stopped.
There was no remaining llama-server. No user process was terminated.

These are observed programmatic X11 interactions with real Electron. Activation
used gtk-launch from the real GNOME user session manager, not a physical mouse
click on the Applications/Dock icon.

## Package and isolation

Both existing desktop files passed desktop-file-validate. Their shared launcher
continues to execute:

`ui/desktop/out/Local AI Desktop-linux-x64/Local AI Desktop`

The ASAR contains the latest Vision/capability bridge, MTP pending-state label,
reasoning/budget controls and monitoring, including the compiled Russian label.
Bundled `resources/bin/goose` is executable and matches `src/bin/goose`:

`ff377475685b6c8b99485e9bceeec236a499f9807c114e489561a61d382cc92c`

AppArmor profile `local-ai-desktop-goose-dev` remains active, global userns
restriction remains 1, and --no-sandbox was not used. Launcher and AppArmor files
were not modified.

## Checks and preservation

- TypeScript: passed.
- Focused ESLint with zero warnings: passed.
- EN extraction consistency and RU locale validation: passed (1808 messages).
- Five relevant test files: 20 tests passed.
- git diff --check: passed.
- Hash comparison: GGUF profiles, context overrides, discovery/other gguf JSON
  and all application preferences other than the intentionally tested monitoring
  preference remained unchanged.

In particular the user's 98,304 FP16 override, saved MTP choices and saved Maximum
Context Discovery results were not changed. This continuation did not validate
Vision at that large FP16 allocation; the prior bounded GPU results belong to the
previous implementation stage. Prior /tmp test logs were no longer present and
were not recreated or represented as newly rerun results.

No remaining action in the requested completion scope. The current app is left
open, unloaded, with monitoring Off and language ru. No commit, push, tag or release.

## Controls

- Embedded MTP: Local Inference → edit profile → Advanced → Speculative Decoding /
  MTP → Embedded MTP → Save profile. A loaded model needs a safe unload/reload.
- Reasoning effort/budget: session-settings icon beside cost in chat; supported
  choices follow the selected model/template. No weight load is needed to edit.
- Monitoring: Application → Appearance → Memory Usage Monitoring. Visible only on
  Local Inference when enabled.

Screenshots: `docs/screenshots/appearance-memory-{on,off}-finish-electron.png`,
`models-memory-on-finish-electron.png`, `models-memory-after-restart-electron.png`,
`models-memory-off-finish-electron.png`.
