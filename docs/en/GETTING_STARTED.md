# Getting started

[English](GETTING_STARTED.md) · [Русский](../ru/GETTING_STARTED.md) · [Home](../../README.md)

## Before you begin

The local v0.3.0 Experimental Alpha package targets Linux x86_64. Ubuntu 24.04 is the primary tested environment. The amd64 Debian package requires Bubblewrap 0.9.0 or later and AppArmor 4.0.0 or later; `apt` installs these system dependencies when compatible versions are available. The package includes the desktop app and Agent runtime, but not `llama.cpp` or model weights. Install a compatible `llama-server` and obtain a GGUF model separately. Other Linux distributions, ARM devices, GPUs, drivers and desktop environments need their own validation.

Agent terminal commands require Bubblewrap, Linux user namespaces and AppArmor enforcement. Do not disable AppArmor or user-namespace restrictions to make the terminal start. If required isolation is unavailable, terminal commands remain blocked. You can still use chat and supported file features.

## Install the local v0.3.0 package

The v0.3.0 package is prepared locally and has not been published. From the repository root, run:

```sh
sudo apt install ./release/local-ai-desktop_0.3.0_amd64.deb
```

This privileged command installs the package and its system dependencies and configures the managed Agent helper and AppArmor profiles. Review the package source and allow the package manager to make these system changes. Never run Local AI Desktop itself as root.

After package configuration succeeds, an administrator must grant the intended desktop account access to the dedicated helper group:

```sh
sudo adduser ACCOUNT local-ai-desktop
```

Replace `ACCOUNT` with that user's login name. Add only accounts that should be able to use Agent terminal commands. The user must log out and back in for the group change to take effect. If package configuration or policy setup fails, do not bypass it; repair the package setup before using the Agent terminal.

## Install isolation for a source checkout

Use this procedure only when running from a source checkout. Do not use it to manage a packaged installation. From the repository root, first run the non-privileged policy check:

```sh
installer="$PWD/scripts/install-bwrap-apparmor.sh"
test -n "$installer"
bash "$installer" --check
```

If the check succeeds, an administrator can install the helper for the current user's primary group:

```sh
sudo /bin/bash "$installer" --install --group "$(id -gn)"
```

This privileged step requires an existing non-root group, the expected root-owned system Bubblewrap executable, an accepted AppArmor policy, and no conflicting managed files. It installs a separate root-owned, non-setuid helper and loads two enforcing profiles. It does not replace `/usr/bin/bwrap`, create groups, or change global security settings. The selected group grants its members access to the helper, so use a group whose membership is appropriate. If the installer reports an existing policy or helper conflict, stop and have an administrator review it; do not remove or overwrite the file blindly. The installer is not an automatic rollback transaction.

To confirm both profiles are enforcing, run:

```sh
sudo grep -E '^local_ai_desktop_bwrap(_child)? \(enforce\)$' /sys/kernel/security/apparmor/profiles
```

Both `local_ai_desktop_bwrap (enforce)` and `local_ai_desktop_bwrap_child (enforce)` must appear. Package installations refresh the managed helper after system Bubblewrap updates. A failed refresh leaves the helper unavailable until an administrator repairs the package. For more detail, see the [technical installation reference](../bwrap-installation-acceptance.md).

## Set up a model

1. Install or build a `llama-server` version compatible with your GGUF model and hardware. The app does not download the server, weights or projectors.
2. Open **Settings → Models and runtime** and set **Path to llama-server or its folder**.
3. Choose the model directory and the actual GGUF file. Choose a projector only for a model that needs one.
4. Select the model from the toolbar. Choose a context size and FP16 or Q8 KV cache, then explicitly load the selected configuration.
5. Wait until the runtime reports ready, then send a short Chat message.

![Model runtime settings](../img/settings.png)

The GPU layer setting `999` requests the maximum offload supported by the backend; `0` requests CPU layers. Partial CPU/GPU offload must be selected deliberately when needed. A failed load does not guarantee automatic fallback to a smaller context or fewer GPU layers. Available memory alone does not guarantee a configuration will fit.

## Try an Agent task

Select a disposable project, switch to Agent and ask for a small task, such as reading a file or making a contained edit and running its tests. **Ask for confirmation** is a good way to learn which actions the Agent proposes. Absolute Autopilot uses the same mandatory boundaries and can still block actions. Review changes yourself; the app does not provide a universal undo.

## Build from source

For development, use Node.js 24, npm 10 or 11, a Rust toolchain compatible with the locked dependencies, and the Linux build prerequisites. From the repository root:

```sh
npm ci
npm run build
npm start
```

`npm run dev` builds the Rust Agent runtime and starts the development app. Do not replace the runtime executable while an Agent task is using it. Finish or stop your own task before rebuilding, then restart the app normally. Run development commands as your desktop user, never with `sudo`.

## Data and upgrades

Fresh installations store data under `~/.local/share/local-ai-desktop`, settings under `~/.config/local-ai-desktop`, cache under `~/.cache/local-ai-desktop`, and logs under `~/.local/state/local-ai-desktop/logs` (unless you set the matching XDG directory variables).

Before upgrading, close the app and back up its data and settings, including its database and attachments. If an existing model path no longer works, update the active profile in Settings; do not overwrite a different settings file. A database migration cannot recreate task history that was never stored. Do not downgrade a migrated database unless you restore a matching backup.

## Troubleshooting

- **Agent terminal says isolation is unavailable:** Ask an administrator to check package configuration, the dedicated helper and both enforcing AppArmor profiles. Changing permission mode does not repair isolation.
- **The helper no longer matches system Bubblewrap:** Ask an administrator to repair or refresh the managed helper. The app intentionally has no host-shell fallback.
- **The model server is offline or refuses connections:** Check its path and runtime logs, select a valid model and explicitly load its configuration.
- **Model loading runs out of memory:** Try a supported smaller context, another KV precision or a deliberate GPU-layer setting. Recovery from total memory exhaustion is not guaranteed.
- **Image input fails:** Confirm that the model supports vision and that its required projector file is configured.

Continue with the [User guide](USER_GUIDE.md).
