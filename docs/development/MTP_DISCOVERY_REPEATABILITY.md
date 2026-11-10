# MTP discovery repeatability: generation-time CUDA OOM and truthful recovery

2026-11-10. Follow-up to commit `4ec7ec8` and [the diagnostic-quota fix](MTP_DISCOVERY_LOG_REGRESSION.md). That fix remains necessary but did not cover the failure below. No requirement to preload the model is introduced.

## Confirmed latest user failure

User application launch: **15:50:14–15:50:15 Kyiv** in `electron/logs/main.log`. The failed run's existing runtime log is:

`/media/yaroslav/01D9B3596C5596B0/Linux/Local-AI-Desktop/logs/runtime/gguf-fdf5e70b-0e52-4624-a733-925dbbe21af4.log`

At approximately **15:51**, Q8 search reached **94,208 tokens**. The log contains complete target/MTP initialization, one sequence slot, batch512, microbatch128, Flash Attention enabled, draft maximum1, a ready listening server and actual `draft-mtp` activity. It then reports:

```text
CUDA error: out of memory
in function ggml_cuda_graph_launch_chunk
cudaGraphInstantiate(&graph->instances[idx], cuda_graph, nullptr, nullptr, 0)
```

This is a **real allocation failure during generation**, after startup succeeded. It differs from the previous truncated diagnostic log and from failure to load MTP's context. The raw failed log (5,112,203 bytes) and its backtrace were preserved under ignored `.local-work/mtp-repeatability/user-failure-1551.log`. User clarification confirms the model was not preloaded; this supported state is reproduced below.

The primary application bug was a narrow OOM classifier: it recognized `CUDA out of memory` and `cudaMalloc failed: out of memory`, but missed llama.cpp's actual **`CUDA error: out of memory`**. Consequently the normal search-boundary OOM was labelled `unexpected-exit`, aborting the whole search instead of trying smaller contexts. The renderer then replaced the useful error with an unconditional generic recovery message.

This explains why identical settings could pass a prior run but fail a later one: individual search probes above the accepted final size can encounter real, generation-dependent CUDA graph allocations. Such a failed probe is an expected upper boundary, not evidence that every smaller MTP context fails. In the new repetitions the actual OOM boundary was 86,016, illustrating why the search cannot rely on one invariant free-memory snapshot.

The stored ordinary profile remained Embedded MTP On, FA On, one slot/one draft token, batch512, target/draft microbatch128, GPU999, no CPU expert offload. Runtime remains integrated `5047748`; all resource files except app.asar match the preceding installed package. The old log supports MTP initialization, not a missing runtime. Historical peak VRAM/concurrency before this instrumentation was not recorded; no invented historical process/memory measurement is claimed.

## Changes

- `src/contextDiscovery/runtimeFailure.ts` recognizes the exact CUDA graph OOM form and `cudaErrorMemoryAllocation`. Non-OOM CUDA errors still stop the search. `contextDiscovery.ts` already treats classified OOM as a boundary and now preserves both the primary error and a restoration error if recovery also fails.
- `managedGguf.ts` stops only its owned child and awaits child exit **and stdout/stderr closure** before classifying failure or starting another model. This prevents a pending diagnostic stream from losing the actual fatal message. Managed HTTP gateways remain separate lightweight proxies; they do not own extra GGUF weights.
- Every probe receives a **separate log file**, not a slice of a shared rotating file. Every run writes a receipt with run ID, initial state, selected launch arguments/runtime version, per-probe stage/PID/log, measurements, failure and actual restoration outcome. Completed diagnostic runs are bounded to the latest 20; in-progress runs are retained. Logs contain synthetic probe requests, not user chat content; endpoint keys are never included in receipts.
- Lifecycle: unloaded → search → owned temporary probes → unloaded; loaded → snapshot effective launch configuration → stop owned model → probes → reload that exact effective configuration. Profile settings and persistent context selection are not rewritten by search. Restoration is observed and reported, not assumed.
- `contextDiscovery/discoveryFailure.ts` carries structured stage/context/KV/recovery details through Electron's Error.message serialization. `SessionSettingsPopover.tsx` displays the concrete primary reason, the stage and actual recovery result, plus the diagnostic receipt path. If a new search fails, a separate notice explicitly identifies the visible values as **earlier measurements**. A later failed search is not presented as a fresh success. EN/RU messages updated.

OOM encountered while looking above the boundary is recorded in the run receipt and search continues downward with MTP still On. There is no automatic MTP/FA/graph disabling, CPU placement change or preset reapplication.

## Ordinary-profile repeated acceptance

After the user explicitly closed the primary application, the fresh full Forge build was prepared at `.local-work/mtp-repeatability-final/Local AI Desktop-linux-x64/`. Only the verified changed `resources/app.asar` was atomically installed into the already activated `.local-work/mtp-discovery-mtp-on/Local AI Desktop-linux-x64/`, after guarding that no main application process was running. Old archive retained at `.local-work/mtp-repeatability/active-before-app.asar`. Existing Desktop Entry, pointer, AppArmor permission and runtime resources remain unchanged.

The real permanent `~/.local/share/applications/local-ai-desktop.desktop` was invoked via `gio launch`, with the **ordinary storage/profile** and selected saved Qwen3.6-35B. No isolated/cloned registry, provider script or preset was used. Each search used the actual **Session settings → Find maximum** button. A fresh run receipt and result timestamps were checked, so previously saved values could not satisfy the acceptance accidentally.

| Run, same Electron process | Before → after | FP16 | Q8 | Observed handled OOM |
|---|---|---:|---:|---|
| Cold launch, never loaded | idle → idle | 45,056 | 69,632 | Q8 86,016, generation |
| Re-search with saved results | idle → idle | 45,056 | 69,632 | None |
| Third search without restarting | idle → idle | 45,056 | 69,632 | Q8 86,016, generation |
| After successful Qwen generation | ready → ready | 45,056 | 69,632 | None |
| After normal managed model stop | idle → idle | 45,056 | 69,632 | Q8 86,016, generation |
| Sixth search without restarting | idle → idle | 45,056 | 69,632 | Q8 86,016, generation |

**All six searches PASS (76 real probes in total).** The loaded-state round compared restored effective arguments (ignoring only the newly assigned port), then generated again with actual MTP: drafted/accepted **31/23** before and after recovery. Before testing no model was resident (760MiB device usage / 23,359MiB free for the desktop); after owned-worker cleanup the device showed 701MiB used / 23,418MiB free. Process monitoring observed at most **one GGUF model worker**; every probe had its own nonempty log without truncation, and every completed synthetic inference had positive drafted/accepted counts and complete allocation evidence. The stop scenario used the ordinary main/preload stop API; all six searches used the real UI button.

A subsequent extra UI selection check initially timed out because the helper demanded Apply even for an already applied value. That was a **test-helper failure after all six successful searches**, not reported as a clean overall test. The helper now recognizes an already selected context; separate normal-start/persistence acceptance after reopening completes the FP16/Q8 checks. Final normal-start acceptance after reopening: **PASS**. Both persisted options were selected/applied through the UI and generated normally: FP16 45,056 drafted/accepted **31/23**, Q8 69,632 **30/23**. The original failed helper report is retained; `normal-start-after-repeats-results.json` references the six successful rounds and records the subsequent checks separately.

The profile registry hash must remain identical before/after; original context selection is restored through the public API, and newly discovered measurements remain saved. The original manual override was 65,536 FP16: tests preserve it rather than silently choosing a different user preference. For normal MTP use choose one of the new measured options.

## Regression checks and evidence

- **112 tests / 15 files PASS**: exact CUDA graph error classification; illegal CUDA access remains fatal; OOM boundary fallback; primary+restore failure preservation; repeated unloaded and loaded failure/recovery cycles; independent receipts/log identity; meaningful UI failure with older-results notice; existing managed inference, placement, memory reserve and persistence cases.
- TSC, targeted ESLint, EN extraction check and RU catalog validation PASS. No new claim of all-locale completeness or filled long-context model quality.
- Controlled supervisor failure tests induce missing draft activity, repeat three times from unloaded and three from loaded, and confirm the actual restored state and effective settings. They supplement the real GPU sequence, not replace it.
- Evidence: ignored `.local-work/mtp-repeatability/`: original failure log, `units.log`, `repeat.log`, `repeated-user-profile-results.json`, later normal-start report, screenshots, installation hashes and build/compiler logs. Run/probe receipts are in the user's configured runtime log directory under `discovery/<profile-id>-<run-id>/result.json` and individual `NN-KV-context.log` files. Read credentials only through existing authorized endpoints; never paste endpoint keys into reports.

Only test-owned processes were closed. The user's existing app was closed by the user explicitly, not killed by the agent. No GGUF, chats, profiles or global GPU settings were reset, no second model was loaded concurrently, and the original repository remained read-only. Physical Dock clicks/new GNOME login were not automated; this acceptance uses the permanent entry and actual ordinary-profile interface.

The existing active installation is already updated and verified. No sudo or activation is required; open the existing Dock/menu entry normally. The separate fresh Forge candidate is retained at `.local-work/mtp-repeatability-final/Local AI Desktop-linux-x64/`.

Implementation/regression commit: `dd27388` (`feature/goose-live-browser`).
