# Ubuntu Desktop Entry launch investigation — 2026-11-08

## Actual launch chain

- Goose Dev menu entry: `/home/yaroslav/.local/share/applications/local-ai-desktop-goose-dev.desktop`.
- Exec/TryExec: `/media/yaroslav/DATA/GUI-DEVELOP/local-ai-desktop-goose-040/scripts/dev/launch-goose-dev.sh`.
- Path: `/media/yaroslav/DATA/GUI-DEVELOP/local-ai-desktop-goose-040`.
- Launcher runs `ui/desktop/out/Local AI Desktop-linux-x64/Local AI Desktop` through the bounded Python diagnostics wrapper, with `--disable-setuid-sandbox`; the existing exact-path AppArmor rule grants userns. It is a Forge directory package, not AppImage/deb.
- Separately, `/usr/share/applications/local-ai-desktop.desktop` and two legacy user aliases point to `/opt/local-ai-desktop/local-ai-desktop` (via /usr/bin alternatives for aliases). dpkg and resources/app/package.json identify that installation as **0.3.0**. It was not replaced or modified.

## Reproduced errors

`gio launch .../local-ai-desktop-goose-dev.desktop` initially returned:

```
mkdir: cannot create directory '/home/yaroslav/.local/state/local-ai-desktop-goose-dev': File exists
```

That path is a symlink to `/media/yaroslav/DATA/Local-AI-Desktop/logs/launcher`; its target was missing. `set -e` stopped the launcher before diagnostics/Electron. `Exec`, executable permission and working directory were correct. The launcher now resolves the log destination with `readlink -m` before mkdir, retaining the original user symlink. A focused regression test reproduces the dangling link and verifies successful launch handoff without replacing it.

After this fix, the actual user-profile launch reached the storage error dialog. Read-only execution of the application's own `readStorageConfiguration` confirmed:

```
Storage marker missing: /media/yaroslav/DATA/Local-AI-Desktop/data/goose-dev
```

The configured data directory is nearly empty (window-state.json and empty backend directory), inconsistent with the migration receipt reporting 8049 files/links. No marker was fabricated and no storage check was bypassed. Existing bootstrap configuration and profile paths were not changed. The investigation does not establish when or why those data disappeared.

A pre-migration archive dated 2026-11-06 exists on the bulk disk. SHA256 matches its receipt (`1a1c5f558d939ba8d2e4749b8defb7c3292a0d166319c0fd612e36de91401d2c`). A separate /tmp extraction passes SQLite integrity_check and contains 26 sessions / 943 messages. Restoring it requires an explicit decision because later data would not be in that snapshot; current files and archive remain intact. No rollback script was run.

## Permanent package

Fresh Forge package built with Node 24.22.1, Electron 43.4.0 cached ZIP, `LOCAL_AI_DESKTOP_DEV_BUILD=1`, including source commit `63389f7` and the staged Live Browser tree. Build first went into ignored `ui/desktop/out-menu-staging`, then after checking /proc executable paths for running users it replaced the unused `ui/desktop/out/Local AI Desktop-linux-x64` directory. Previous package retained in `ui/desktop/out-menu-backups/20261108-172633`. No /tmp executable is used by the menu. This preserves the existing Desktop Entry and exact-path AppArmor policy. No process running that installation was present before replacement.

Installed metadata: `resources/local-build.json`; runtime at `resources/live-browser/dist/live-browser.js` with package.json and browsers.json at its parent. Installed app version remains 0.4.0-alpha.1. Original reference repository untouched.

## Real Desktop Entry verification

Executed the actual existing Desktop Entry via `gio launch`, with isolated XDG_CONFIG_HOME/XDG_DATA_HOME/XDG_STATE_HOME for the independent binary check, and a UI-only placeholder provider (no model inference). Verified:

- X11 window `Goose`, WM_CLASS `local-ai-desktop-goose-dev`, visible 940×800.
- Launcher JSONL reports Electron started and backend_ready.
- Renderer URL is `file:///media/.../ui/desktop/out/Local AI Desktop-linux-x64/resources/app.asar/...`, not /tmp.
- Live Browser opens deterministic loopback page: `Desktop Entry: Live Browser OK`.
- Canvas 1280×800, 3,032,692 non-dark RGB channel values; screenshot `/tmp/lad-menu-installed-live-browser.png`.
- Main IPC runtime status running=true, error=null, script inside the installed resources/live-browser tree, node-on-PATH.
- `desktop-file-validate` and `bash -n` pass; launcher regression unittest passes.

This proves the installed package and Desktop Entry launch chain work independently of the missing user profile. Normal-profile success remains blocked pending the user's recovery decision; do not report it as fixed merely because isolated launch passes. Reboot was not performed; storage disks must be mounted for the configured paths. Existing inference processes and user sessions were not stopped. No global settings, system package, original source repository, model files or user chats were removed.

## Confirmed profile recovery — 2026-11-08 17:40 +02:00

The user explicitly authorized restoring the November 6 snapshot. Rechecked archive SHA256 against the receipt, restored it to a sibling staging directory (6963 regular files, 1086 internal MCP symlinks, 418427089 bytes), and verified sessions.db integrity/counts before activation. The storage marker was written only after recovering and validating the complete initialized profile. No marker was fabricated for the empty directory.

The previous nearly empty profile was retained without changes at:
`/media/yaroslav/DATA/Local-AI-Desktop/data/goose-dev.before-restore-20261108-174012`.

Restore receipt (private, outside Git):
`/media/yaroslav/DATA/Local-AI-Desktop/data/restore-receipt-20261108-174012.json`.

Activated restored root at the existing configured path; bootstrap storage configuration and both UUID requirements remain unchanged. Original archive remains intact. No running product process was present at activation; no inference process was stopped, and no model inference was requested.

**Normal user-profile launch now verified:** executed the existing Goose Dev Desktop Entry via gio without isolated XDG roots. X11 shows the actual 940×800 application window, launcher diagnostics report backend_ready, and the renderer loads from permanent ui/desktop/out, not /tmp. Missing-marker dialog no longer appears; history is present. Live Browser in this same recovered user instance opens https://example.com/, reports title Example Domain, running=true, and renders nonblank 1280×800 frames. Its script is the installed resources/live-browser/dist/live-browser.js. After launching, read-only SQLite integrity_check remains ok, with 26 sessions and 943 messages; GGUF profiles, Discovery registry and context overrides parse successfully. The application was left open for the user.

Recovery restores the dated snapshot, not data potentially created after November 6. No user files, chats, GGUF weights, previous directory, or backup archive were deleted. The earlier pending-recovery status above is superseded by this verified recovery.

Final checks: sessions comprise 23 user chats and 3 sub-agent sessions. A repeat plain `gio launch` of the same Desktop Entry exited its secondary Electron process with status 0, while the original visible window remained; there was no second storage dialog. Launcher source was already fixed in be018e3; this recovery required no further application-code or build changes.

## Live Browser boot failure after a normal menu restart — fixed 2026-11-08

The prior launch verification inherited the IDE's Node 24 PATH. On the user's subsequent ordinary menu restart, main.log explicitly reported `You are running Node.js 18.19.1. Playwright requires Node.js 20 or higher`, followed by runtime exit 1. The old probe only checked `process.exit(0)`, so it incorrectly accepted system Node 18. This was independent of profile/storage recovery.

Commit e6b07bf fixes the actual runtime dependency:

- Forge packages a native compatible Node executable at `resources/live-browser/bin/node`, along with the distribution's NODE-LICENSE and target metadata. No global Node install or on-click download is needed. Native builds validate Node >=20 and platform/architecture; cross builds must explicitly supply LAD_LB_NODE_BUNDLE and its license.
- Main prioritizes this offline executable over Hermit and PATH, and probes the Node major version instead of merely accepting an executable that exits successfully. esbuild now targets Node 20, matching playwright-core's requirement. Startup errors occurring during resolution are retained in status.
- Three regression tests accept the pinned Node, reject a missing executable, and reproduce/reject the Ubuntu Node 18 that the old probe accepted.
- Packaged E2E now optionally asserts that the child actually uses the packaged Node. With PATH=/usr/bin:/bin (system Node 18), the complete panel/navigation/region/layout/reopen scenario passed in 41.6s (42.1s total). Live Browser targeted tests: 37/37 passed; TypeScript and targeted ESLint passed.

A fresh native package was staged and activated only after checking that no process executed files from the installed package. Previous package retained at `ui/desktop/out-menu-backups/before-bundled-node-20261108-175150`. User profiles and storage configuration were not changed. The system Node remains 18.19.1.

**Installed normal-profile verification:** invoked the existing Goose Dev Desktop Entry via gio with PATH=/usr/bin:/bin, without isolated XDG/profile roots. Launcher reported backend_ready; main.log selected bundled-node-executable and runtime ready. Main IPC reported running=true, error=null, and node=`.../ui/desktop/out/Local AI Desktop-linux-x64/resources/live-browser/bin/node` (Node 24.22.1). Live Browser navigated to https://example.com/, title Example Domain, canvas 1280×800 with 1,022,220 non-dark pixels. This is the permanent installed package, not an artifact under /tmp. The working application was left open. No inference was invoked or stopped.
