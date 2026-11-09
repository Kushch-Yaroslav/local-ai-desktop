# P0 Dock and Qwen investigation (2026-11-10)

Full completion is not claimed: physical Dock click/fresh-login acceptance is pending and the packaged second-instance E2E timed out.

## Dock

The canonical menu/favorite ID is local-ai-desktop.desktop, but desktopMain still advertised the now-hidden local-ai-desktop-goose-dev.desktop. The new build advertises the canonical desktop name/class and the installer uses the matching StartupWMClass. X11 xprop on the actual QA executable confirmed WM_CLASS local-ai-desktop. This removes the confirmed identity inconsistency; it does not prove every Dock activation failure was caused by it.

The old second-instance handler restored minimized windows then focused them without showing hidden windows. revealWindow now restores, shows and focuses. app activate also reveals an existing regular window. Only window IDs/counts are logged under [activation]. Closing all Linux windows already quits the app; this code was retained.

Unit activation cases pass; actual packaged test for hidden/minimized second-instance activation timed out at 90s and is NOT a pass. Its owned process exited; no user process was killed. A physical click/fresh login was not automated. scripts/dev/diagnose-dock-activation.py provides a one-command, 20-second capture of window identity/state and allowlisted app activation events while the user clicks Dock.

## Qwen

The complete 48,095-line supplied runtime log was inspected programmatically; the initial console view was truncated, followed by a full-file error scan. It contains successful loads/generation and several explicit cudaMalloc out-of-memory errors, not an inferred OOM. The final failure is allocating 80.02 MiB while creating an MTP draft context, followed by failed to create MTP context and model loading error. Earlier failures include 1280 MiB and 164.05 MiB allocations.

The saved Qwen3.6 profile selects Flash Attention on, gpuLayers 999 and mtp-embedded. Its binary is the managed llama-server inside the prior checked package, build 1 d1d3c33 per log. No system CUDA/driver changes were made. Runtime GPU test used a temporary profile cloned from that configuration with context 32768, f16 K/V, FA on and speculativeMode off; user settings/GGUF were untouched. Real generation returned OK.; runtime logs confirm flash_attn enabled. Actual args include --gpu-layers 999 --ctx-size 32768 --cache-type-k f16 --cache-type-v f16 --flash-attn on --spec-type none.

Sequential full discovery on that MTP-Off temporary profile confirmed FP16 65536 and Q8 106496, with startup, health, inference and allocation measurements. Accepted device headroom was 541065216 and 556793856 bytes respectively (host about 55.8 GB). These are algorithm-confirmed options under the current reserve policy/free memory, not an absolute hardware limit and not valid predictions for MTP On. Qwen3.8-27B also passed a separate sequential real 32K FP16 generation test. Workers were shut down through their own service; no second resident model was loaded concurrently.

The existing memory error hint now mentions MTP's additional context. Discovery classifies startup errors separately (CUDA OOM, flash attention, cache type, GGUF load, invalid arguments, runtime/dependencies, timeout, unexpected exit), and aborts infrastructure errors after one probe with restoration. Genuine memory allocation failures can still define a search boundary. No silent fallback disables a user's MTP preference: to reproduce the confirmed 32K working setup, turn MTP off. MTP On at 32K with full GPU offload remains unconfirmed/known to have failed in the supplied log.

## Validation and installation

Host targeted suite: 53 PASS. Restricted-namespace fixture execution initially had 17 credentialUnsupported failures because its fake runtime could not probe correctly; rerun on the host passed all 53. TSC passed. Real Qwen35 baseline/discovery PASS, real Qwen27 baseline PASS. Packaged activation E2E FAIL (timeout), physical Dock and new login NOT VERIFIED.

Fresh package: .local-work/p0-dock-qwen/Local AI Desktop-linux-x64/. Activated via the existing selector and canonical menu installer; no extra activation is needed for the next start. Existing processes were not replaced. If an older instance remains open, it must be closed normally before the new executable takes effect. Validation artifacts are ignored under the package's validation directory.
