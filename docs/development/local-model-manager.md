# Local model manager — v0.4.0 development

The later [compact controls and MTP report](compact-controls-mtp.md) supersedes this report’s MTP-disabled limitation.


Continues the initial managed GGUF implementation. Goose's Rust agent, ACP,
providers, MCP, Skills, chat and native inference remain authoritative. No donor UI,
IPC system or agent loop was imported. No releases, tags or pushes were made.

## CUDA discrepancy: observed cause and limits

The RTX 3090 is available on the host. Both inspected executables currently list
`CUDA0: NVIDIA GeForce RTX 3090` when run with host access. Both report no CUDA
capable device inside the restricted execution sandbox. `/dev/nvidia*` is also
hidden there. Thus the earlier empty device list does not establish missing
hardware or a CPU-only build. The donor's earlier host-only empty result was not
reproduced; no permanent donor build fault is established.

Both binaries resolve their adjacent `libggml-cuda.so.0`, CUDA runtime/cuBLAS 12
libraries under `/usr/local/cuda-12.6`, and host `libcuda.so.1`. The standard build's
CMake cache has `GGML_CUDA=ON`, Release, CUDA compiler 12.6. The NVIDIA driver is
580.196.07. Driver/system CUDA files and both runtimes were left unchanged.

Probes execute the **selected** absolute executable, without a shell, with timeouts.
Version, advertised flags, raw device evidence and executable path are available in
Runtime diagnostics. Outcomes distinguish a visible GPU, unavailable device access
(which can be sandbox/driver/library access), and a backend lacking discovery.
An empty list never globally disables another executable. Unsupported requested
flags fail explicitly. CPU fallback is a user choice: GPU layers 0.

Standard fallback runtime:
`/media/yaroslav/DATA/llama.cpp/build-cuda/bin/llama-server`.

Host verification (the sandbox cannot substitute for this):

```sh
nvidia-smi
/media/yaroslav/DATA/llama.cpp/build-cuda/bin/llama-server --list-devices
/media/yaroslav/DATA/GUI-DEVELOP/local-ai-desktop/runtime/llama/llama-server --list-devices
ldd /media/yaroslav/DATA/llama.cpp/build-cuda/bin/llama-server
ldd /media/yaroslav/DATA/GUI-DEVELOP/local-ai-desktop/runtime/llama/llama-server
```

## Profiles and lifecycle

- Multiple profiles: Add, Edit, Duplicate, Delete with a Goose dialog confirmation,
  Select for chat, and available/missing/loading/running/failed status.
- Save validates file paths/GGUF magic and selected executable capabilities. It
  writes profile settings and registers a lightweight authenticated loopback
  endpoint, **without spawning llama-server or allocating model weights**.
- `gguf-profile.json` migrates into `gguf-profiles.json`; the old file is retained.
  Missing files remain listed, and returning focus refreshes availability.
- External GGUF/projector files are opened read only; deletion affects profile and
  its managed provider, never model files. Model weights are not copied.
- Saved external providers appear in Goose's normal Change Model selector. Native
  direct-path profiles are also added to its existing native model list.
- The first inference POST activates the chosen profile and forwards the original
  request once, streaming back through Goose's existing OpenAI-compatible provider.
  Metadata/model-list GETs never activate weights. `meta.n_ctx` reports configured
  context before weights load. Explicit Load is available in chat.
- Stop generation cancels the HTTP stream, preserving a ready server. Cancel
  loading aborts pending startup. Unload terminates only the owned inference
  process. Close waits for cleanup. No autoload or automatic restart is enabled.
- States: idle → validating → starting → ready → stopping → idle; errors → failed.
  Concurrent same-profile activations share one start. A different profile cannot
  interrupt another profile's active request; finish/cancel/unload first.
- The supervisor keeps one owned model process. Switching an idle loaded profile
  terminates it before loading another. Reusing unchanged settings avoids restart.
- Gateway ports/keys are persisted in a separate private `gguf-endpoints.json`;
  registry/credential files are mode 0600. Existing endpoint ports are reused on
  restart, occupied ports fail rather than terminating another listener. The
  internal inference port is dynamically allocated. A bind race fails visibly.
- API keys are passed in `LLAMA_API_KEY`, not command-line diagnostics. An executable
  must advertise that environment support. Effective args/log path omit secrets.
- Linux uses installed `/usr/bin/setpriv --pdeathsig KILL` before exec of the selected
  binary, providing parent-death protection while retaining the child PID. Without
  setpriv/non-Linux, normal close/exit cleanup remains, but forced-parent-death
  protection is not promised. SIGTERM escalates after three seconds.

Native profiles use existing Goose settings keyed by model path, with no external
proxy/model process. One native profile per path avoids silently sharing different
settings. GPU use through this native adapter is unverified and rejected with an
actionable external-CUDA fallback. Existing native onboarding/settings remain.

## UI and localization

All three onboarding choices remain. The manager uses Goose inputs, buttons,
dialogs, semantic theme tokens and collapsible advanced sections; it is shared by
onboarding and Settings → Local Inference. It supports the existing dark theme.

An accessible English/Russian selector is available during onboarding. Settings →
App retains Goose's language menu (and other languages). Language writes the same
persisted setting and updates the existing `IntlProvider` in place, without
reloading chat or changing the agent prompt/response language. Russian locale
resolution and explicit preference precedence use the existing Goose logic.

New manager controls, helper text, states and validation summaries have English
and Russian catalog messages. Raw executable/version/log evidence and technical
flag names remain verbatim diagnostics. Other language catalogs were retained.
Russian coverage is **not complete**: the catalog audit found 58 identical English/
Russian entries, including legitimate technical names/placeholders and untranslated
Apps, directory selection, external-backend, session and live-voice strings.
Native menus still use Goose's partial translation implementation. Matching catalog
IDs is not evidence that every screen is translated; uncatalogued text can remain.

## Capability-gated controls

| Control | Native profile adapter | Standard CUDA binary | Patched donor binary |
| --- | --- | --- | --- |
| Existing GGUF, GPU layers, context | Path/context; GPU unverified | CUDA chat tested at 24 layers / 8192 | Device detection verified; earlier CPU chat tested |
| Threads, batch, flash attention | Existing Goose mappings | Advertised; selectable | Advertised; selectable |
| Projector | Existing native settings; external field rejected | `--mmproj`, flag/path validated | Flag/path validated |
| KV K/V types, microbatch | Rejected by adapter | Capability gated | Capability gated |
| Jinja / built-in template name | Existing native template UI | Capability gated | Capability gated |
| First-N/all CPU MoE, tensor override | Rejected by adapter | First-N tested; all/tensor override advertised but untested | Advertised; gated |
| Expert GPU cache | Rejected | Unsupported: clear setting or change executable | Patched `--moe-cache-mib`, experimental/unbenchmarked |
| Draft/MTP GGUF | Existing native MLX differs from llama backend | Not enabled: compatibility validator incomplete | Not enabled despite advertised flags |

Quantized V cache requires explicit flash attention On. MoE settings require
metadata confirming experts. Expert caching also requires detected GPU, CPU expert
placement, bounded batch/microbatch and advertised no-host/no-repack/lazy-mode
controls. Unsupported saved values are not silently dropped: validation fails,
fields display a warning and a Clear unsupported settings action is provided.

The manager exposes useful supported flags, not an arbitrary extra-arguments box.
Model metadata inspection is bounded, reads scalar GGUF metadata and skips large
vocab/tensor content. It can return partial metadata; absence is not guessed as
support. For the test Qwen model it confirmed qwen35moe, 41 blocks, 256 experts.

## Donor logic and experimental placement

Inspected donor files include `models/llama-launch-config.ts`, `models/gguf-profile.ts`,
`models/advanced-placement.ts`, runtime supervisor/controller, model registry and
backend-capability services. Adapted concepts: per-executable validation, registry
identity, simple/advanced groups, file availability, explicit process ownership,
placement constraints and separation of generation cancellation from unloading.
The donor's black/orange UI and its Rust agent runtime were not copied.

The donor binary identifies commit `5047748`; the standard binary identifies
`d1d3c33`. The donor's nearby main-llama source currently identifies
`4f17ccf43bfd2cb912ebbb56054291cd8991af3b`, which differs from the binary identifier:
exact source/binary provenance is not established by proximity alone. The patch
is visible in `common/arg.cpp` (`--moe-cache-mib`), `src/llama-moe-cache.cpp`, and
`src/llama-context.cpp`, with GPU expert cache scheduling and compatibility guards.
No backend rebuild was attempted, and existing CUDA binaries were not overwritten.

Draft/MTP remains blocked until target/draft architecture, tokenizer identity,
embedding dimensions, context, draft format, backend algorithm and any shared-KV
requirements are validated. A flag or draft-path field alone is not compatibility.
Historical donor benchmark JSONs do not validate this build or its UI settings.
No acceleration claim or long-context/80B benchmark is made.

## Validation and limitations

The evidence directory records test output, host probes and selected screenshots.
Observed real tests: profile Save stayed idle; normal Goose chat lazily loaded the
standard CUDA executable and returned `CUDA_GOOSE_OK`; nvidia-smi attributed
12,374 MiB to its owned PID at 24 GPU layers / context 8192. Chat Stop retained the
same ready process; Unload released the process and GPU allocation. These are smoke
tests, not a baseline-versus-acceleration benchmark.

Profile duplicate/delete confirmation, retained GGUF paths, Russian/English live
selection, localized missing-file error, normal model selector integration, and
no-autoload on restart were exercised through the rendered GUI. Targeted fixture
checks cover authentication, shared starts, abort during startup, switching,
registry migration/missing files, no weight deletion, process reuse and shutdown.
TypeScript, targeted ESLint, locale compilation and relevant unit/integration tests
are run incrementally. No cloud model requests are required for these checks.

Remaining deliberate gaps: no validated draft/MTP activation; projector inference
and custom template/tool-call combinations need model-specific tests; patched
expert-cache acceleration is unbenchmarked; native GPU adapter is unverified;
Russian/native-menu coverage remains partial. Profile changes take effect on next
activation; saving does not restart an already-loaded model. A different model's
active inference must finish/cancel before switching. No automatic crash retry.

## Ubuntu integration

The dedicated entry is installed at both `~/Desktop/local-ai-desktop-goose-dev.desktop`
and `~/.local/share/applications/local-ai-desktop-goose-dev.desktop`.
`desktop-file-validate` passes. Gio GNOME search finds the dedicated ID. `xprop`
confirms WM_CLASS `local-ai-desktop-goose-dev`, matching StartupWMClass. This permits
Dock association/pinning; user Dock favorites were not changed. The existing
v0.3.2.0 launchers and reference Goose application identity were left intact.
The wrapper still runs the packaged application, never a build on click.


## Final observed checks

- 39 tests in 5 files passed, including existing Goose chat submission and model
  selector tests. TypeScript no-emit and targeted ESLint completed without errors.
- The final rendered UI restored Russian (`language=ru`) after restart and remained
  idle. The unloaded context indicator now uses profile context (8.2k), rather
  than the generic cloud default. The endpoint supplies Goose's `meta.n_ctx`.
- A native direct-path profile saved through Settings without model activation.
  Native inference itself was not exercised in this pass.
- A profile was selected through Goose's normal provider/model dialog, then a
  first request started the selected CUDA executable and returned
  `MOE_PLACEMENT_OK`. Effective arguments included GPU layers 24, context 8192,
  K cache q8_0, V cache f16, flash attention on, 8 CPU threads, batch 256,
  microbatch 128 and `--n-cpu-moe 20`. Its observed GPU allocation was 11,394 MiB.
  This is a configuration smoke test; settings/prompt differ from the earlier
  CUDA test, so the numbers are not an acceleration comparison.
- In that configuration Goose invoked the existing Developer MCP shell tool once
  to execute `printf LOCAL_TOOL_OK`; the model then reported the tool output.
  This verifies one tool-call path, not all tool/template compatibility.
- Skills displayed built-in/documentation/web-search skills; Extensions displayed
  the existing seven default MCP extensions and the available extension catalog.
  Other provider implementations/catalogs were retained; paid cloud inference
  was not invoked or claimed tested.
- Closing the real application while the CUDA model was ready terminated its
  inference child and Goose backend; host process inspection found no remaining
  development processes and nvidia-smi showed no compute allocation. Parent-death
  protection is enabled on this Ubuntu host; forcible-parent-death behavior was
  not separately crash-tested with real model weights.
- Renaming a profile does not change its runtime fingerprint or restart unchanged
  weights. Runtime-affecting edits take effect on activation, with active-request
  protection. The regression fixture verifies reuse after rename.

New core files: `ggufTypes.ts`, `ggufConfig.ts`, `ggufMetadata.ts`, `ggufMessages.ts`,
`managedGguf.ts`, their tests, `acp/managedLocalProfiles.ts`,
`hooks/useManagedGgufState.ts`, `components/InterfaceLanguage.tsx`,
`components/ManagedLocalRuntime.tsx` and the shared
`components/onboarding/AdvancedLocalInference.tsx`.
Modified integration files: `main.ts`, `preload.ts`, `renderer.tsx`, `ChatInput.tsx`,
`ModelAndProviderContext.tsx`, onboarding guard/selector, Settings App/local inference,
modelInterface, English/Russian catalogs, Forge packaging config, launcher and reports.
All paths above are relative to `ui/desktop/src` unless noted. No Rust source was
changed in this follow-up. Build output is local/ignored; changes remain uncommitted.


Final package check: restored Russian, rendered the manager and selected the
standard `Qwen CUDA Dev` profile while state remained idle. The separate MoE test
profile is optional. The dedicated GNOME desktop entry was then used for the normal
launch without terminal/debugging arguments. Standard profile selection does not
autoload; submit a chat message or press Load model when needed.

Launcher follow-up: the short-lived tool's process-group cleanup initially ended
its `gio launch` child. The wrapper now uses a guarded `setsid --fork` re-exec so
Electron owns a separate session. Retesting the actual GNOME entry left Electron
and its backend alive after gio/the initiating command exited (Electron reparented
to the desktop session, SID equal to its PID), reached backend/React readiness and
allocated no GPU weights. This also makes terminal closure independent of the app.
