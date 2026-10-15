# Getting started

[English](GETTING_STARTED.md) · [Русский](../ru/GETTING_STARTED.md) · [Home](../../README.md)

## Requirements

Linux x86_64 is the implemented Agent isolation target; Ubuntu 24.04 with Bubblewrap 0.9.0 is the primary validated environment. The Debian package includes Electron and Rust Agent Runtime, but not llama.cpp or GGUF weights. Other distributions, ARM, drivers and desktop environments need separate validation. The developer's RTX 3090 24 GB, Ryzen 7 5700X3D and 64 GB RAM are a test configuration, not minimum requirements.

Published packages are listed on [GitHub Releases](https://github.com/Kushch-Yaroslav/local-ai-desktop/releases). v0.2.0 passed installed-package acceptance on the developer's Ubuntu system; a clean-OS installation has not been independently verified.

## Install the latest published package

Download the amd64 `.deb` from [the v0.2.0 Experimental Alpha release](https://github.com/Kushch-Yaroslav/local-ai-desktop/releases/tag/v0.2.0), then install it with:

```sh
sudo apt install ./local-ai-desktop_0.2.0_amd64.deb
```

This installs the package and dependencies. Do not run Electron as root. The package provisions its dedicated helper and AppArmor profiles during configuration. An administrator must explicitly authorize each desktop account for the dedicated group, as described below. Missing isolation fails closed; there is no host-shell fallback.

## Ubuntu Agent terminal prerequisites

The tested deployment needs distro Bubblewrap, enabled AppArmor/user namespaces, and the application's dedicated enforcing policy/helper. Do not disable global AppArmor or user-namespace restrictions to resolve a startup refusal. Without secure startup, terminal tools fail closed; working file tools alone do not prove terminal readiness.

For a packaged installation, an administrator authorizes the intended desktop account with `sudo adduser ACCOUNT local-ai-desktop`; log out and back in before Agent terminal use. Package configuration must succeed first. Local policy modifications and unmanaged helpers require review rather than automatic replacement. Do not combine package management with the source installer.

For a source checkout only, run the reviewed standalone installer from the repository root:

```sh
installer="$PWD/scripts/install-bwrap-apparmor.sh"
test -n "$installer"
bash "$installer" --check
sudo /bin/bash "$installer" --install --group "$(id -gn)"
```

This copies `/usr/bin/bwrap` to `/usr/lib/local-ai-desktop/bwrap` (root:application-group, 0750, no setuid), writes `/etc/apparmor.d/local-ai-desktop-bwrap` (root:root, 0644), and loads/verifies the two dedicated enforcing profiles. It does not attach to or replace `/usr/bin/bwrap`, create groups, or change global security settings. The installed AppArmor parser must accept the shipped policy. The installer refuses an existing differing policy; review it and keep a backup before any separate update. It is not automatic or transactional.

Read-only verification, where profile visibility requires administrator access:

```sh
sudo grep -E '^local_ai_desktop_bwrap(_child)? \(enforce\)$' /sys/kernel/security/apparmor/profiles
```

Both profiles must appear. For packages, a dpkg trigger refreshes the managed helper after distro Bubblewrap updates; failed configuration leaves it unavailable until repaired. Standalone source copies require an administrator refresh through the reviewed installer. Helper access by a group is not exclusive caller authentication. The deployment is not an automatic rollback transaction. See the [technical installation record](../bwrap-installation-acceptance.md) for detail, read together with the newer [validation record](../noop-loader-validation-2026-10-13.md).

## Configure the model runtime

1. Install/build a compatible external `llama-server` supporting your GGUF architecture, GPU backend, optional MTP and projector.
2. Open **Settings → Models and runtime**. Set **Path to llama-server or its folder**. The app validates/searches the folder within bounds; choose the intended executable if several are found.
3. Set the model directory and actual GGUF path, plus a projector only where required. Models are not downloaded automatically. Save and select the model in the toolbar.
4. Explicitly load the selected context/KV configuration, wait for ready, then send a simple Chat request.
5. Select a disposable project, switch to Agent and test a small read/edit/test task. Start with Ask, or deliberately choose Absolute Autopilot within the same restrictions.

![Runtime settings](../img/settings.png)

GPU layers `999` requests maximum supported offload; `0` requests CPU layers. Partial offload is an intentional backend configuration, not an automatic response guaranteed after OOM. NVIDIA telemetry uses `nvidia-smi`; other GPU telemetry may be unavailable. Memory fit depends on weights, context, KV type and workload. Failed loading reports backend errors; reduce the request explicitly if needed.

## Build from source

Use Node.js 24, npm 10 or 11, a Rust toolchain compatible with the locked dependencies, and Linux development prerequisites. With no active run using the executable being rebuilt:

```sh
npm ci
npm run build
npm start
```

`npm run dev` also builds Rust and starts the development renderer/main workflow. Do not rebuild the running Rust executable during an Agent task; finish/stop your own task and restart normally after the build. The enforcing terminal acceptance command is `npm run test:sandbox-startup:electron`; it uses isolated fixtures and does not invoke a real model. Run tests as the desktop user, never via sudo.

## Data and upgrade precautions

Fresh installs use XDG directories: data in `$XDG_DATA_HOME/local-ai-desktop` (default `~/.local/share/local-ai-desktop`), configuration in `$XDG_CONFIG_HOME/local-ai-desktop`, cache in `$XDG_CACHE_HOME/local-ai-desktop`, and logs in `$XDG_STATE_HOME/local-ai-desktop/logs`. Defaults for the latter three are `~/.config`, `~/.cache` and `~/.local/state`. Existing source installations with `runtime/sqlite/local-ai-desktop.db` retain that legacy runtime layout; `LOCAL_AI_RUNTIME_ROOT` can select a separate instance root.

Before upgrading, close your instance cleanly and back up its actual data/config roots, including SQLite and attachments. Do not overwrite a different configuration file merely because it has an old model path. Correct the active profile's path through Settings. Task migration preserves legacy plans but cannot reconstruct missing old ownership/snapshots. Do not downgrade a migrated database without restoring a matching backup.

## Troubleshooting

- **UID map/newroot/old-root sandbox denial:** inspect the actual setup diagnostic and kernel AppArmor denial; verify the matching helper/policy. Switching permission modes cannot repair isolation.
- **Helper differs from distro binary:** request an administrator refresh; no unsafe fallback is provided.
- **Runtime executable replaced:** complete the build and restart that instance; do not replace another running session.
- **Connection refused/server offline:** inspect runtime logs and the selected endpoint; explicitly load a valid model, then continue the saved task.
- **Missing GGUF/projector/server:** correct the active settings path; do not download or overwrite files automatically.
- **Memory/vision failure:** check context, KV type, GPU layers and compatible projector. Recovery from total exhaustion is not guaranteed.

Continue with the [User guide](USER_GUIDE.md).
