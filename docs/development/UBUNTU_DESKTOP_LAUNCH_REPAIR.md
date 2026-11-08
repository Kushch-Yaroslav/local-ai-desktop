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
