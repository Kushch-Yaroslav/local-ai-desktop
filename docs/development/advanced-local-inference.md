# Advanced local inference — v0.4.0 development

Historical initial implementation report. The later [model manager report](local-model-manager.md) supersedes its single-profile, manual-load and GPU-unavailable limitations. Host CUDA visibility and inference have since been verified.

Local AI Desktop additions; Goose runtime, ACP, providers, MCP and Skills remain in place.

## Desktop launcher

Desktop entry: `~/Desktop/local-ai-desktop-goose-dev.desktop`.
Entrypoint: `scripts/dev/launch-goose-dev.sh`. The launcher executes the packaged
`ui/desktop/out/Local AI Desktop-linux-x64/Local AI Desktop` with repository working directory.
No compiler, package manager or dev server runs on click.

Electron data: `${XDG_DATA_HOME:-$HOME/.local/share}/local-ai-desktop-goose-dev/electron`.
Goose storage: sibling `goose-backend`, explicitly passed as `GOOSE_PATH_ROOT`.
Launcher diagnostics: `${XDG_STATE_HOME:-$HOME/.local/state}/local-ai-desktop-goose-dev/desktop.log`.
External inference log: `electron/gguf-server.log`. No previous profiles are imported.

One-time preparation used Node 24.19.0 and pnpm 10.30.0 (global pnpm was too old):

```sh
cd ui/desktop
npm exec --yes --package=pnpm@10.30.0 -- pnpm install --frozen-lockfile
cd ../..
cargo build --release -p goose-cli --bin goose
cp target/release/goose ui/desktop/src/bin/goose
cd ui/desktop
# Ensure Node 24 is selected in PATH
node scripts/i18n-compile.js
node ../node_modules/@electron-forge/cli/dist/electron-forge.js package
```

This machine additionally needed CMake/Ninja (installed under `/tmp/lad-build-tools`)
and `BINDGEN_EXTRA_CLANG_ARGS='-isystem /usr/lib/gcc/x86_64-linux-gnu/13/include'`.
Temporary build tools are not launcher dependencies. A preexisting missing comma
in the Flatpak Forge configuration blocked packaging and was repaired.

## UI and initial path

Onboarding has native Local Model, Advanced Local Inference and provider options.
Advanced uses existing theme tokens, rounded cards, buttons and file picker.
It reappears in Settings → Local Inference. Simple mode selects paths and profile
name. Advanced mode additionally exposes GPU layers and context. CPU is the safe
default (0 layers). The current implementation saves **one reusable profile**.

Start validates files, GGUF magic, executable access and advertised flags; spawns
without a shell, uses a dynamically allocated loopback port and random API key,
waits for health, and creates/updates an existing Goose OpenAI-compatible custom
provider. The alias is `local-gguf`; chat remains Goose chat. Stop terminates only
the owned process, escalating to SIGKILL after three seconds. A new start stops the
old owned process. Failed startup cleans up. App exit sends termination signals.

Restart requires starting the saved profile before using its provider. Automatic
profile activation, multiple profiles, server restart recovery and start-time
cancellation are unfinished. Stop is disabled during startup. Graceful exit cleanup waits for the owned process before quitting and
is implemented; forced OS termination can still orphan a child and needs a stronger
supervisor before production use. Port reservation closes before spawn; a competing
bind fails rather than killing another listener. Inference cancellation is delegated
to the existing Goose streaming provider and was verified in normal chat against the donor CPU server.

## Capability matrix

S = supported and tested; U = supported in source/advertised but inference untested;
E = external-only implementation path; P = new/patched backend required; X = unsupported
in that backend. S below refers only to the tested donor CPU path; help listings alone never earn S.

| Feature | Native Goose | CUDA external d1d3c33 | Donor external 5047748 | Initial UI |
| --- | --- | --- | --- | --- |
| Existing GGUF path, no copy | U (`lib.rs` explicit_model_path) | U | S (CPU) | Tested in Goose chat |
| GPU layers, context | U | U | S (context/CPU); GPU untested | Exposed; GPU requires detected device |
| CPU threads, batch | U | U | U | Deferred |
| Flash attention | U | U | U | Deferred |
| KV cache type K/V | P (no ModelSettings field) | E/U | E/U | Deferred |
| Vision projector | U (resolved mmproj) | U | U | Deferred |
| Embedded/custom tool templates | U | U (Jinja options) | U | Deferred |
| Draft/MTP GGUF | P for native llama path; draft setting used by MLX | E/U, model dependent | E/U, model dependent | Deferred |
| CPU MoE / first N layers on CPU | P (no settings mapping) | E/U | E/U | Deferred |
| Tensor override placement | P | E/U | E/U | Deferred |
| Expert GPU cache `--moe-cache-mib` | P | X | E/U patched binary | Deferred |
| Save/reopen external profile | Additional desktop code | N/A | N/A | S (save and reopen in Settings) |
| Validation errors / idempotent stop | N/A | N/A | N/A | S (unit tests) |

Native audit locations: `crates/goose-local-inference/src/model.rs`, `lib.rs`,
`llamacpp/mod.rs`, `llamacpp/inference_engine.rs`, `mlx.rs`, `management.rs`;
ACP adapter `crates/goose/src/acp/server/local_inference.rs`.
Native settings already map GPU layers, batch, threads, context and flash attention;
these do not need a new agent or inference loop. New native KV/MoE controls require
explicit Rust settings, ACP types, validation and llama binding support. A draft
field must not be advertised as native GGUF MTP support: llama execution does not
consume the draft path as MLX does.

Full local binary help captured in `gguf-audit/`. Both binaries executed `--help`
and `--version` successfully. CUDA probe reported no CUDA-capable device.

- `/media/yaroslav/DATA/llama.cpp/build-cuda/bin/llama-server`:
  version 0.4.1-dev, commit d1d3c33;
  SHA256 `d7061d202c2ee116fa826963d781cef67d2b36b18805c5d81322d11ef9f52e1b`.
- Donor `runtime/llama/llama-server`: version 0.8.0-dev, commit 5047748;
  SHA256 `77f54d96774645417affb2b382b574eb1ac1c126a0b9104d00657c2fb61f2691`.

## MoE feasibility and proposed advanced design

Donor `src/main/models/llama-launch-config.ts` validates target/draft architecture,
embedding dimensions, tokenizer identity, context, shared KV metadata and file
identity. Reuse those requirements conceptually; no donor agent loop was copied.
Its `docs/experiments/advanced-placement-moe` contains cache experiments and runtime
help. Those historical numbers are not v0.4.0 benchmarks.

Both inspected binaries advertise `--cpu-moe`, `--n-cpu-moe`, `--override-tensor`.
Only donor advertises `--moe-cache-mib`; this is a patch-dependent capability.
No llama.cpp rebuild or modification was attempted. No acceleration claim is made.

Future advanced form should have collapsible Runtime, Memory, Vision, Speculation,
Tools and Experimental MoE sections, using existing settings controls. Backend
selection gates each section using executable-specific probes and model metadata.
Native selection routes to existing native settings. External profiles must store
capability evidence/build identity, then reject stale or unsupported options on
activation. Diagnostics should show effective argv, backend build, selected device,
resolved context/cache, startup log and exit reason, with API secrets redacted.
Experimental controls must be labeled and omitted when their flag is absent.

Benchmark before enabling acceleration: same binary baseline, GGUF/hash, prompt,
seed, sampling, context, threads and hardware; warmup plus repeated runs, record
prompt tokens/s, generation tokens/s, wall time, peak RSS and device VRAM. Include
normal text and tool-call correctness and cancellation checks. Compare changed
placement/cache alone. CUDA is unavailable in the current execution environment,
so no valid GPU acceleration benchmark was run.

## Validation on 2026-11-03

- Rust 1.99.0 release build completed successfully (no Rust source changes).
- Electron Forge Linux x64 packaging succeeded with bundled 196 MiB Goose executable.
- Actual launcher command reached HTTPS backend health success and rendered React onboarding.
  The first attempted package lacked Goose; the reported screenshot was reproduced,
  diagnosed and corrected by bundling the completed Rust build. The launcher now checks
  backend existence before starting Electron.
- Inspected rendered UI through localhost CDP; did not infer GUI readiness from PIDs.
- Existing `Qwen3.6-35B-A3B-UD-Q4_K_M.gguf` loaded through the donor binary on CPU,
  without copying the model. Default 4096 context failed visibly with a 4396-token
  Goose request; default increased to 8192. Context size is a real operational limit.
- Ordinary Goose chat returned `LOCAL_GGUF_OK` using the managed custom provider.
  Server task processed 4400 prompt tokens and generated 29 tokens, 20.50 s total;
  generation timing reported 8.29 tokens/s. This is a smoke test, not an acceleration
  comparison or reproducible benchmark.
- A second counting request was cancelled using chat Stop. The server recorded
  `cancel task` and released its slot. Explicit Stop server then logged clean shutdown.
- Profile paths/name/context were saved and reopened through Settings. Models were
  read from the original paths. Old app/reference checkout were read only.
- Four targeted Vitest tests pass, including real owned fixture-process readiness,
  cleanup/port release, invalid values/paths and rejection of GPU offload when no
  device is found. Tests require host loopback access; sandbox execution cannot
  exercise the fixture server correctly.
- TypeScript no-emit and targeted ESLint pass; shell syntax and diff whitespace pass.
- Both runtime device probes report `(none)`. GPU > 0 is rejected before launch in
  this environment; no experimental acceleration controls are enabled.

## Modified files

- `scripts/dev/launch-goose-dev.sh`: stable isolated packaged-app launcher.
- User Desktop `local-ai-desktop-goose-dev.desktop`: separate trusted shortcut.
- `ui/desktop/forge.config.ts`: repair existing packaging syntax error.
- `ui/desktop/src/main.ts`: isolate development storage; register inference lifecycle.
- `ui/desktop/src/preload.ts`: typed GGUF IPC methods.
- `ui/desktop/src/managedGguf.ts`: validation, process ownership, readiness, profiles.
- `ui/desktop/src/managedGguf.test.ts`: validation and process integration checks.
- `ui/desktop/src/components/onboarding/ProviderSelector.tsx`: third option.
- `ui/desktop/src/components/onboarding/OnboardingGuard.tsx`: current theme tokens.
- `ui/desktop/src/components/onboarding/AdvancedLocalInference.tsx`: shared profile form.
- `ui/desktop/src/components/settings/localInference/LocalInferenceSection.tsx`: profile access.
- This report and `gguf-audit/*`: design, source/runtime evidence and limitations.

Build products and installed dependencies are ignored artifacts, not source changes.
No releases, tags, commits or pushes were created.

Final restart checks: the final packaged UI restored dark theme and the saved
profile (GPU 0, context 8192) after a full application restart. A real model was
started again and closing the application through its normal window action
cleanly shut down the inference server. Host process inspection found neither
the development Electron/backend nor its owned llama-server remaining. The app
was then launched normally without a debugging port. After each app restart,
open Settings → Local Inference → Start and save profile before using chat.

Screenshot: `gguf-audit/evidence/profile-dark.png`. Targeted test output:
`gguf-audit/evidence/tests.txt`. A non-fatal Mesa driver permission warning is
present in launcher diagnostics; UI rendering and CPU chat were verified despite it.
