# Q8 discovery: independent target / MTP precision — 2026-11-05

## Proven defect

`collectRuntimeContextEstimate` compared both target K/V and speculative K/V against `observed.kvCacheType`. For Q8 this rejected an independent F16 MTP context, even when both matched their own launch configuration.

Real selected d1d3c33 runtime log (sanitized, unchanged allocation values):

```
llama_kv_cache: CUDA0 KV buffer size = 544.00 MiB
llama_kv_cache: size = 544.00 MiB (16384 cells, 16 layers, 4/1 seqs), K (q8_0): 272.00 MiB, V (q8_0): 272.00 MiB
common_speculative_init_result: creating MTP draft context against the target model 'fixture.gguf'
llama_kv_cache: CUDA0 KV buffer size = 64.00 MiB
llama_kv_cache: size = 64.00 MiB (16384 cells, 1 layers, 4/1 seqs), K (f16): 32.00 MiB, V (f16): 32.00 MiB
```

The launcher supplied `--cache-type-k q8_0 --cache-type-v q8_0` and `--spec-type draft-mtp`; it did not supply draft cache overrides. The audited llama.cpp common/common.h initializes speculative draft K/V independently to GGML_TYPE_F16; common/arg.cpp exposes separate --spec-draft-type-k/v (aliases --cache-type-k/v-draft, -ctkd/-ctvd).

The parser already separated target and draft correctly. The defect was the subsequent precision validation, not the log format, Vision allocation, stale records or inability to load Q8. The earlier standalone 16K test called allocation parsing directly; it did not exercise this extra discovery-estimator validation, explaining why it passed.

## Narrow correction

Target formats remain checked against the selected precision. Draft formats are checked against their independent launch flags, default F16. Missing launch evidence for a speculative context is rejected. Incomplete allocation evidence and actual precision mismatches remain rejected. Both target and draft allocations still feed the estimator; no flags, memory calculation, reserves or candidate policy were relaxed.

The corrected validator accepts the exact log lines above. Runtime log contents are expected to remain identical after this adapter fix; the erroneous interpretation has changed, not the caches. Regression tests cover the real format, wrong target format, wrong explicit draft type and absent launch evidence.

## Real full discovery, bounded test

Host inventory found no app or llama-server active; free VRAM was 23127 MiB / total 24576 MiB. A copied Qwen27B-3.8 profile used its existing projector and Embedded MTP. FA was explicitly On in the temporary test profile. User files, overrides and registry were read-only.

The normal ManagedGguf.runContextDiscovery pipeline and mature algorithm executed with original reserves, real startup/health/inference/allocation probes, exclusive lease and restoration. A test-only metadata adapter capped the search at 65536 tokens; no model file or production algorithm was changed. The default existing search-probe bound remained in place.

Results:

| Precision | Confirmed context | Final free VRAM | Final available RAM | Boundary |
|---|---:|---:|---:|---|
| FP16 | 53248 (52K) | 722468864 bytes | 54886174720 bytes | budget guard |
| Q8 | 61440 (60K) | 1863319552 bytes | 54668533760 bytes | bounded search |

FP16 61440 was skipped *before launch* because predicted memory violated the existing budget/guard. Q8 completed real probes at 16384, 36864, 53248 and 61440; all startup/health/inference checks passed and no precision-mismatch rejection remained. No absolute Q8 maximum beyond the imposed test ceiling is claimed, and the previous 176128 non-equivalent result is not reused.

The full evidence JSON is `q8-discovery-cache-fix-evidence.json`. Both precision results were persisted under the temporary exact model/config identity and matched after reopening ManagedGguf/storage. Profile context remained manually set to 16384. Presentation from those real results was `16K, 32K, 52K FP16, 60K Q8, 64K`; no history was merged. Existing registry/grid replacement tests passed. This is presentation-function verification, not a new physical GUI-click test.

Only owned probe processes were stopped. No llama-server remained afterward. Temporary runtime data was removed. No user context, MTP, Vision, profile or discovery setting was written.

## Validation / delivery

- 13 targeted parser/discovery/storage/grid regression tests passed.
- Opt-in full real CUDA discovery test passed in about 50 seconds. Its initial combined command also included a fixture suite that failed to load due to Vitest URL resolution; the fixture path was fixed and all 13 unit tests subsequently passed. GPU work was not unnecessarily repeated.
- TypeScript and targeted ESLint passed; git diff --check passed.
- No translation strings/UI or provider/agent-loop changes were required.
- Forge packaging succeeded. Updated package installed at `ui/desktop/out/Local AI Desktop-linux-x64/`; host process checks confirmed no running app at installation. Previous package retained in `out-pre-q8-cache-fix`. Bundled Goose executable matches src/bin/goose.
- Launcher, AppArmor, sandbox, upstream/legacy repositories and model files unchanged. No commit/push/release.

Changed files: contextDiscovery/contextEstimate.ts; new contextDiscovery/cachePrecision.test.ts and fixtures/qwen35-q8-mtp-f16.log; new opt-in ggufQ8Discovery.gpu.integration.test.ts; this report and evidence JSON.
