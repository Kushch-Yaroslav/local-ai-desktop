# MTP-aware Maximum Context Discovery — acceptance, 2026-11-10

This follow-up addresses Qwen3.6-35B with **MTP On**, independently of the earlier successful MTP Off and Dock checks. No user model, profile, chat, GGUF, primary Electron, proxy or inference process was stopped or replaced. Tests cloned the existing profile into isolated directories and refused to run while a llama-server was resident. All GPU experiments were sequential.

## Confirmed causes and runtime contract

The earlier runtime failure was an allocation failure while creating the additional MTP context, not a missing GGUF or CUDA initialization failure. Discovery additionally had three application-level blind spots: it began at 16,384 tokens, although smaller MTP configurations work; its first-point prediction could treat fixed recurrent/compute buffers as context-linear; and persistence rejected results below 16K. Consequently, a failure at the initial point did not prove that MTP could never run. Default server auto parallelism resolved to four slots in these measurements, increasing recurrent/speculative state substantially.

The binary tested here is the integrated llama.cpp `0.8.0-dev`, build 0, commit `5047748`, SHA256 `77f54d96774645417affb2b382b574eb1ac1c126a0b9104d00657c2fb61f2691`. The packaged binary matches `runtime/integrated-llama/build/bin/llama-server`. Do not identify it by the older runtime revision in historical user logs.

The checked-in, ignored runtime source provides the exact contract:

- `runtime/integrated-llama/source/common/speculative.cpp`, `common_speculative_init_result`: embedded `draft-mtp` calls `llama_init_from_model(model_tgt, cparams)` with `LLAMA_CONTEXT_TYPE_MTP`, `ctx_other=ctx_tgt`, and `n_ctx=llama_n_ctx(ctx_tgt)`. It shares the existing model weights; it does not load a second complete model.
- `common_base_params_to_speculative`: draft K/V cache types and draft microbatch are independent of target K/V. The default draft KV remains FP16 when the main KV is Q8. Changing main KV is not equivalent to changing both caches.
- `common_speculative_get_output_limits`, server context setup and recurrent snapshots: slots and maximum draft tokens affect additional outputs/state. Target/draft compute buffers depend on microbatch, architecture and context; they cannot all be estimated as a single KV multiplier.
- `runtime/integrated-llama/source/common/arg.cpp`: supported controls include `--parallel`, `--spec-draft-n-max`, `--spec-draft-n-ubatch`, `--cache-type-k-draft`, `--cache-type-v-draft` and `--n-cpu-moe`. This embedded mode has no independently loaded draft model for `--gpu-layers-draft` to relocate. Expert offload applies to the shared model. No unsupported draft-only CPU placement was invented.
- Server context/slot semantics remain those of llama.cpp (`server-context.cpp`, `n_ctx_slot`). Reported discovery values are `--ctx-size`; with the recommended one slot this is the chat capacity. Do not interpret a multi-slot allocation as the same one-chat context.

## Implementation

`ui/desktop/src/managedGguf.ts`, `runContextDiscovery`, still uses the same validated profile, owned runtime and launch-argument builder as ordinary inference. MTP probes now generate several sentences rather than two tokens and require positive `timings.draft_n`. A healthy server with MTP configured but no observed drafting cannot certify MTP On. Drafted/accepted counts, allocation evidence, process VRAM and resident RAM are recorded. Runtime failure classification continues to distinguish OOM, incompatible parameters, Flash Attention, GGUF/runtime errors, timeout and unexpected exit; non-OOM infrastructure failures stop discovery.

`src/contextDiscovery/contextDiscovery.ts` begins MTP search at 4K, measures a nearby second 4K point before extrapolating growth, and refines on 4K boundaries. Final candidates must satisfy **both** configured RAM/VRAM reserves and the existing process budget. The previous process-budget branch could ignore a larger explicit device reserve; that is corrected. FP16 and Q8 are reported independently for MTP, even if Q8 gains less than the donor's 8K display threshold. Nothing silently disables MTP or changes offload.

`contextDiscoveryPersistence.ts` accepts valid 4K/8K results; policy version 2 separates obsolete calibrations. Identity includes explicit device reserve and retains slot, draft cache, draft token, microbatch and placement arguments, separating MTP Off, full GPU and partial offload results. Main context/KV being calibrated remain per-option. Historical data are not deleted.

`ggufTypes.ts`, `ggufConfig.ts`, `AdvancedLocalInference.tsx`, `ggufMessages.ts`, EN/RU catalogs add explicit slot count, draft microbatch and independent draft KV controls, capability checking and persistence. MoE cache/block-placement profiles reject contradictory parallel counts instead of appending conflicting flags.

The **explicit, review-before-save** MTP preset sets one slot, one draft token, batch 512, target microbatch 128 and draft microbatch 128 (clamping an explicitly larger minimum draft length to one). It preserves MTP, Flash Attention, context, target/draft KV and GPU/CPU placement. It does not load weights or save automatically. CPU offload remains a separate explicit choice. Existing profiles are not silently migrated to these settings.

## Real measurements

Hardware: RTX 3090 24GB, 64GB RAM, Ryzen 7 5700X3D. Existing read-only `Qwen3.6-35B-A3B-UD-Q4_K_M.gguf`. Flash Attention On in effective arguments/runtime. MTP mode `draft-mtp`; accepted generations have actual drafted and accepted tokens. No second GGUF instance loaded concurrently.

The minimum manually verified context is **512 tokens**, the application's validation floor, with both the old default and the explicit preset. This is not the discovery search floor (4K). With unchanged default auto slots, two draft tokens and default batches, the repaired search found **8,192 FP16 / 16,384 Q8**, and both options survived a fresh supervisor initialization and generated normally. This alone disproves the previous conclusion that no MTP configuration worked.

For useful larger contexts, all following rows use `gpuLayers=999`, one slot, one draft token, batch 512, target/draft microbatch 128, Flash Attention On, target KV as labelled, draft KV default FP16:

| Explicit placement | Confirmed FP16 | Confirmed Q8 | Median decode at 32K, short identical prompt |
|---|---:|---:|---:|
| Full GPU, no CPU experts | 45,056 | 69,632 | 195.5 tokens/s |
| `nCpuMoe=1` | 57,344 | 90,112 | 185.0 tokens/s |
| `nCpuMoe=2` | 81,920 | 118,784 | 167.2 tokens/s |

Each discovered mode was subsequently applied through ordinary profile save/start and generated with MTP still active. These are bounded-search, policy-confirmed maxima in the measured environment, **not absolute OOM limits or a benchmark with the entire context filled**. More CPU placement was not exhaustively optimized. Full GPU is the fastest tested option; two CPU expert blocks buy capacity at about a 14% decode reduction on this short prompt. Long-prompt ingestion and different draft acceptance rates can change that tradeoff.

| Placement / KV at accepted maximum | Process VRAM MiB | Free device MiB | Worker RSS MiB | Available host GiB |
|---|---:|---:|---:|---:|
| Full GPU FP16 | 22,582 | 731 | 1,360 | 53.5 |
| Full GPU Q8 | 22,614 | 699 | 1,376 | 53.3 |
| CPU1 FP16 | 22,552 | 761 | 1,864 | 53.5 |
| CPU1 Q8 | 22,622 | 691 | 1,887 | 53.5 |
| CPU2 FP16 | 22,628 | 989 | 2,383 | 53.1 |
| CPU2 Q8 | 22,580 | 1,031 | 2,407 | 52.9 |

RSS is resident process RAM, not all reclaimable OS file cache. Device counters include runtime overhead not represented by tensor allocation logs. Configured host reserve was 8GiB; device policy retains the absolute 1,550MiB non-LLM budget plus 384MiB estimator margin, not 1,550MiB added to observed background usage. Larger explicitly configured reserves are also enforced. Free-device values vary with the desktop; rerun discovery after material background changes.

Allocation examples from runtime evidence, MiB:

| Allocation | Full GPU FP16 45,056 | Full GPU Q8 69,632 |
|---|---:|---:|
| Device weights (shared by MTP) | 21,087.7 | 21,087.7 |
| Target KV | 880 | 722.5 |
| MTP KV (FP16) | 88 | 136 |
| Target CUDA compute | 37.0 | 166.0 |
| MTP CUDA compute | 22 | 28 |
| Recurrent state | 125.6 | 125.6 |
| Additional complete draft model weights | 0 | 0 |

Default four-slot/two-draft state measured **753.75MiB**, versus **125.6MiB** with one slot/one draft. Moving experts from the first one/two blocks reduced logged device weights by about 464/928MiB and raised measured worker RSS. This explains why reducing only the main KV context was insufficient to recover the larger default configuration.

Comparable short generation at 8K with the original slots/batches, three sequential repeats each, identical prompt/seed/output: MTP Off **147.5 tokens/s** median; MTP On with two draft tokens **198.5 tokens/s** median (~35% faster). MTP run drafted 50 and accepted 30 tokens. Separate 32K preset measurements drafted 31/accepted 23. These are decode timings from actual responses, not advertised model throughput, and exclude model loading. No universal speedup is claimed.

## Verification and reproducibility

- 100 targeted tests / 14 files PASS: discovery, reserves, lower contexts, storage, runtime supervision, speculation, arguments, placement and settings persistence. `mtpDiscovery.test.ts` checks launch flags and distinct identity; `managedGguf.test.ts` refuses a response with no actual draft activity.
- Opt-in real GPU integration (`src/mtpDiscovery.gpu.integration.test.ts`): baseline On/Off repeats, 512 floor, default discovery/restart and three explicit placement searches PASS. Same profile save/normal startup validates each returned maximum. Owned workers shut down in finally; final host check found no llama-server left by QA.
- **Fresh packaged Electron**: `tests/e2e/mtp-settings.spec.ts` PASS with `LAD_E2E_MTP_GPU=1`. UI preset save reached actual main-process registry, real bundled runtime discovery returned **45,056 / 69,632**, normal start/generation passed for both. Draft counts were 31/23 and 30/23 (drafted/accepted). Native-window screenshot inspected at 1600×1000: independent target/draft cache, slots and microbatch fields visible without overlap.
- TSC, targeted ESLint, message extraction and RU placeholder validation PASS. Full all-locale validation remains FAIL: non-RU catalogs already lack the GGUF/Live Browser keys (244 missing per affected locale after these additions); no claim of full translated-catalog completeness. EN fallback remains available. A first command invoked an incompatible system pnpm; checks/build were rerun using the pinned Node24 and direct project scripts.
- Preliminary harness problems (missing capability flags, busy preset click, long TMPDIR breaking Chromium socket paths) were corrected. Final GUI test unsets TMPDIR and uses a short isolated profile path. Those failed preparations are not counted as GPU passes.

Evidence persists, ignored by Git, under `.local-work/mtp-verification/`: `units.log`, `baseline-gpu.log`, `minimum-gpu.log`, `default-discovery.log`, `discovery-gpu.log`, `package-e2e.log`, native screenshots and JSON in `package-results-20261110T145459/`, isolated result JSON/logs under `profiles/`. Do not commit private isolated profiles or credentials. GPU tests must run from the host GUI environment; this agent's private PID/network namespace is not a reliable resident-model inventory.

For another host run, first ensure there is no resident model; do not stop the user's worker. Run the targeted unit suite normally. GPU integration is disabled unless `LAD_MTP_DISCOVERY=1`; its `LAD_MTP_MATRIX` specifies explicit profile variations, `LAD_MTP_RUN_DISCOVERY=1` enables searches, `LAD_MTP_RESTART=1` and `LAD_MTP_VERIFY_CATALOG=1` check persisted reload. The fixture currently targets the known user test profile; adapt that fixture to another machine before enabling it. Packaged E2E uses `LAD_E2E_ISOLATE=1`, `LAD_E2E_PACKAGED_EXECUTABLE`, `LAD_E2E_MTP_GPU=1`; without GPU opt-in it only saves settings and never loads weights.

Qwen3.8-27B was not reloaded for this follow-up; shared runtime/supervision tests pass, but this is not a new real-model acceptance for every other GGUF. Long-context quality, fully populated prompts and sustained multi-hour throughput remain unmeasured.

Implementation and regression tests: commit `91f14ed` on `feature/goose-live-browser`. The checked package manifest records this source revision and hashes all bundled llama runtime files as well as the Electron/Goose/Live Browser resources.

## Checked package and safe activation

Candidate: `.local-work/mtp-discovery-mtp-on/Local AI Desktop-linux-x64/` (permanent side-by-side path). It contains current Electron code, integrated llama runtime, Goose and Live Browser runtime/Node resources. The old selected application was not overwritten or activated automatically. Validation manifests are saved alongside this candidate.

After closing the current application normally, from repository root:

```bash
sudo scripts/dev/install-dev-apparmor.sh "$PWD/.local-work/mtp-discovery-mtp-on/Local AI Desktop-linux-x64/Local AI Desktop"
scripts/dev/activate-packaged-build.sh --check "$PWD/.local-work/mtp-discovery-mtp-on/Local AI Desktop-linux-x64"
scripts/dev/activate-packaged-build.sh --activate "$PWD/.local-work/mtp-discovery-mtp-on/Local AI Desktop-linux-x64"
```

The exact-path AppArmor rule is necessary for Ubuntu's Chromium sandbox; activation refuses to claim success without it. Open the existing canonical `local-ai-desktop.desktop` Dock/menu entry. No new shortcut or data migration is required. In Local Models → Edit → Advanced, apply the explicit MTP preset, review/save, then run discovery. Choose CPU expert offload only if the larger capacity is worth the measured tradeoff; results for that placement are separate.
