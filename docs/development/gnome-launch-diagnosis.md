# Goose Dev GNOME activation: AppArmor reproduction (2026-11-04)

Status: user-session programmatic cold start verified after the administrator
installed the scoped rule. Actual GNOME/Dock mouse click remains NOT VERIFIED.
Prior gtk-launch checks from Codex did not establish activation outside the IDE Snap profile.

## Evidence

- GIO resolves `local-ai-desktop-goose-dev.desktop` to
  `~/.local/share/applications/local-ai-desktop-goose-dev.desktop` and the shared
  repository launcher. The pinned favorite uses that same ID.
- Codex inherits `snap.webstorm.webstorm (complain)`; GNOME Shell and user-session
  activation launch the package from `unconfined`. Both use X11 `DISPLAY=:0`,
  `/run/user/1000`, and the same session D-Bus.
- `kernel.apparmor_restrict_unprivileged_userns=1`.
- Kernel audit at 16:41:54 and 16:44:59 records `userns_create` transitioning the
  Electron executable to `unprivileged_userns`, followed by a `sys_admin` denial.
  Electron reports `No usable sandbox!`.
- No Goose Dev Electron, Goose backend, or llama-server was present before the
  cold-start reproduction at 16:48:34 through the user session manager. The same
  denial and crash occurred. No existing app/model was terminated.
- Reproduction with structured diagnostics at 16:52:32: correct GIO entry,
  `apparmor=unconfined`, Electron PID 41530, `no_usable_sandbox`, exit signal 5
  (shell status 133). GIO itself returned zero. No main window/backend appeared.

The test user services invoke the exact registered desktop ID using gtk-launch
outside the IDE's AppArmor context. `RemainAfterExit=yes` and `KillMode=process`
prevent service completion from killing a detached application. This is a
programmatic user-session activation, not a mouse-click test.

## Scoped fix requiring administrator action

The rule in `scripts/dev/apparmor/local-ai-desktop-goose-dev` allows `userns` only
for the exact development Electron executable, following Chromium's documented
AppArmor method. It does not alter the global sysctl, the legacy application
profile, drivers, or other applications. The packaged SUID helper is not used;
`--no-sandbox` is not introduced.

Run from the host terminal:

```sh
sudo /media/yaroslav/DATA/GUI-DEVELOP/local-ai-desktop-goose-040/scripts/dev/install-dev-apparmor.sh
```

The installer validates the rule, refuses to overwrite a different rule, installs
it root-owned mode 0644, and loads only that profile with apparmor_parser. No full
AppArmor service reload is needed. The user installed the rule with sudo on 2026-11-04 after Codex confirmed that
`sudo -n` was unavailable. The rule is now present and loaded.

Post-installation validation at 16:58:37 began with no existing Goose Dev or
llama-server processes. User-session activation through the exact GIO ID created
Electron PID 42434, backend PID 42701, and window 0x4600004. The backend startup
trace confirmed health at 16:58:39. The window was mapped (`IsViewable`), its
WM_CLASS was `local-ai-desktop-goose-dev`, and an X11 capture confirmed the real
rendered new-chat UI. See `docs/screenshots/goose-dev-gnome-cold-start.png`.

The Electron executable entered `local-ai-desktop-goose-dev (unconfined)`; its
renderer PID 42743 used a different user namespace and Seccomp=2. Global
apparmor_restrict_unprivileged_userns remains 1.

Repeat application-ID activation and Desktop-shortcut activation at 16:59:17
created only transient secondary PIDs 42930 and 42974, both exiting status 0.
The original PID/window and one backend remained. No globalShortcut or sandbox
failure was recorded. Stopping the completed initiating test units left Electron
42434 and backend 42701 alive with the existing window active. The application
itself was not stopped.

Acceptance classification:
- A cold start: verified programmatically in the actual user-session context and
  visually through a target-window screenshot; actual icon click NOT VERIFIED.
- B repeat activation: verified programmatically, same window active and no
  duplicate backend; actual Dock click NOT VERIFIED.
- C Dock: exact favorite ID and GIO resolution verified; mouse interaction NOT VERIFIED.
- D terminal independence: verified after launch commands and initiating units exited.
- E Desktop shortcut: exact desktop-file activation verified programmatically,
  same instance reused; actual desktop mouse click NOT VERIFIED.

An actual user cold icon-click test has been requested. No icon-click success is
claimed until that test is observed or the user reports its result.

## Diagnostics

`~/.local/state/local-ai-desktop-goose-dev/launcher.log` records invocation before
setsid; two files are retained with rotation at 1 MiB. Per-launch `launch-*.jsonl`
retain eight files, each capped at 256 KiB. They record only allowlisted session
environment fields, AppArmor label, executable, process IDs, fixed startup error
codes, backend health confirmation from the existing startup trace, and Electron
exit status. Raw stdout/stderr, request content, API keys and arbitrary environment
values are excluded. The detached supervisor keeps consuming discarded output so
hitting the log cap cannot cause Electron to receive SIGPIPE.

Diagnostics were tested with disposable fake processes: exit 23 propagated,
sandbox failure classified, backend readiness detected, private output discarded,
and 400 KiB output did not exceed the log cap. These are logger tests, not evidence
that the real GNOME application launched.

References:
- https://chromium.googlesource.com/chromium/src/+/main/docs/security/apparmor-userns-restrictions.md
