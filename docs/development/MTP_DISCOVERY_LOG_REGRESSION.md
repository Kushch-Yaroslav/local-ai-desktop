# Ordinary-profile MTP discovery: exhausted diagnostic log quota

**Later repeatability fix and six ordinary-profile searches:** [MTP_DISCOVERY_REPEATABILITY.md](MTP_DISCOVERY_REPEATABILITY.md). Its current installation/acceptance status supersedes this historical report.

Date: 2026-11-10. Follow-up to [MTP_CONTEXT_DISCOVERY.md](MTP_CONTEXT_DISCOVERY.md). This is a logging regression, distinct from CUDA OOM. The original repository remained read-only.

## Exact cause

The user's failed runtime log was:

`/media/yaroslav/01D9B3596C5596B0/Linux/Local-AI-Desktop/logs/runtime/gguf-fdf5e70b-0e52-4624-a733-925dbbe21af4.log`

The captured original was **16,773,843 bytes**, 3,373 bytes below the **16,777,216-byte** limit. It ended inside model metadata during initialization, followed by `[Local AI Desktop: runtime diagnostic limit reached]`. Earlier successful MTP initializations were present in the historical prefix. That prefix cannot legitimately prove the latest probe's configuration.

`ui/desktop/src/managedGguf.ts`, `start`, opens an append log, records its current length in `logStarts`, and reads only the current child's slice for discovery. That separation was correct. However, `logBytes` was initialized to the historical file size, so **previous launches consumed the current child's entire diagnostic allowance**. Dropping a large chunk and appending the short limit marker usually left the file below the rotation threshold. The next probe therefore inherited the exhausted allowance instead of receiving a full startup log.

The parser could not see current MTP mode, slots, draft KV, allocation summary or other required evidence. Weakening it or substituting old-launch evidence would falsely certify memory/configuration. Missing fields were not an OOM measurement.

The ordinary registry contained the user's actual saved settings: embedded MTP, one draft token, one parallel slot, batch512, target/draft microbatch128, Flash Attention On, GPU999, no CPU expert offload. Model/GGUF and integrated runtime matched the earlier accepted configuration. The selected runtime is intentionally canonicalized to the running package without rewriting the profile registry. All bundled runtime files were compared, not only the small llama-server entry executable. The version remains `5047748`. No CUDA/NVIDIA settings or GGUF changes were needed.

## Fix

- The diagnostic quota now starts at **zero per child**. `logStarts` remains the byte offset used to isolate this child's records. Existing inter-launch rotation and per-child output cap remain; no live log descriptor is truncated.
- A truncated log with incomplete allocation evidence now stops discovery as **`diagnostics-truncated`**, explicitly distinct from memory rejection. The strict allocation parser remains intact; no missing category is synthesized and no historical evidence is borrowed.
- Source files: `managedGguf.ts`, `contextDiscovery/runtimeFailure.ts`. Tests: `managedGguf.test.ts`, `contextDiscovery/runtimeFailure.test.ts`, `tests/e2e/mtp-settings.spec.ts`.

This was not an early read or a race with delayed log flushing: startup diagnostics were permanently dropped by the parent. The runtime's health and actual MTP generation could succeed while its startup evidence was missing.

## Reproduction and acceptance

1. **Old packaged binary, saturated-log reproduction: expected FAIL.** The real Qwen worker initialized, health passed and both FP16/Q8 probes generated (drafted/accepted **31/23** and **30/23**). Nevertheless, discovery returned no options because the log lacked the current context/allocation evidence. This proves that lack of fields did not mean lack of memory or disabled MTP.
2. **Fresh packaged binary, identical saturated-log regression: PASS.** Real discovery returned FP16/Q8, then normal profile start/generated at both accepted maxima. The optional E2E mode seeds only its own isolated log with `16MiB-64` bytes before the search (`LAD_E2E_MTP_GPU=1 LAD_E2E_MTP_SATURATED_LOG=1`). It refuses a resident model and never overwrites a user log.
3. **Actual ordinary profile: PASS.** The test launched the fresh package with the normal launcher storage roots, without isolated XDG/profile roots, without saving/reapplying a preset, and without cloning the registry. It used actual **Session settings → Find maximum**, persisted results in the normal discovery store, selected each FP16/Q8 option and clicked **Apply**. Normal `ggufStart` then generated with positive drafted/accepted counts. The profile registry SHA256 before/after was identical. The original context selection was restored through the public API; discovery results remain saved.

4. **Updated active package through the permanent Desktop Entry: PASS.** `gio launch ~/.local/share/applications/local-ai-desktop.desktop` opened the selected package with the ordinary profile. Actual Session settings search returned both maxima; each option was selected/applied and generated normally. FP16 drafted/accepted **31/23**, Q8 **30/23**. Launcher diagnostics confirmed the selected executable, backend readiness and normal Electron exit status 0. This certifies the real permanent entry invocation, not a physical Dock click or a new GNOME login.

The ordinary-profile results were **45,056 FP16 / 69,632 Q8**, full GPU, draft KV default FP16. These are bounded-search confirmations with short actual inference, not filled long-context quality tests. The pre-existing selected override was **65,536 FP16**; it was preserved after testing rather than silently replaced by a measured maximum. For subsequent use select a discovered result, not that older override.

Targeted unit/integration suite: **74 PASS / 11 files**, including histories just below, exactly at and above the cap, repeated child startup and rotation, plus error classification. TSC and targeted ESLint PASS. Preliminary test-harness failures were corrected: `prepare` is lazy (use `activate` when asserting ready); catalog reload deliberately marks disk results as previous (check fresh timestamps instead); asynchronous IPC completion must be awaited explicitly. Those failures are not counted as successful product tests.

## Build, installation and evidence

Fresh full Forge package: `.local-work/mtp-log-regression-checked/Local AI Desktop-linux-x64/`. To avoid consuming the nearly full project disk, Forge built into a unique owned `/tmp/lad-mtp-log-build.*` directory; the permanent candidate was then materialized under `.local-work`. Byte-identical resources are hard-linked to the preceding package, and the one changed file, `resources/app.asar`, was copied freshly. The candidate does not depend on `/tmp`; linked resources are never edited in place.

After confirming that no application main process was running, the already activated package was updated atomically: only its `resources/app.asar` changed, after verifying every other regular file against the fresh Forge package. The previous archive is retained as `.local-work/mtp-log-regression/active-before-app.asar`. No user profile, chat, model, runtime library, launcher pointer, Desktop Entry or AppArmor rule was replaced.

Active package remains `.local-work/mtp-discovery-mtp-on/Local AI Desktop-linux-x64/`; its app.asar now matches the fixed fresh candidate. **Reactivation and sudo are not needed for this existing installation.** The canonical entry remains `~/.local/share/applications/local-ai-desktop.desktop` → `scripts/dev/launch-goose-dev.sh` → existing selected package. The permanent fresh candidate is available separately if a clean side-by-side installation is desired.

Ignored evidence: `.local-work/mtp-log-regression/`: original log copy/hash, expected old-binary failure, fixed packaged regression, actual ordinary-profile results, installation old/new hashes, compiler/lint logs and screenshots. Credentials, private profiles, chat contents and build artifacts are not committed. Only test-owned app/runtime processes were closed; no pre-existing Electron, Goose, proxy or model was stopped. No concurrent model was loaded.
