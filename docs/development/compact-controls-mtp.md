# Compact model controls and speculative decoding / MTP

Local AI Desktop v0.4.0 follow-up. No Goose agent/runtime, provider serializer,
MCP or Skills implementation was replaced. Donor/reference checkouts, existing
runtime binaries, drivers and real user profiles were not modified. No downloads,
backend rebuilds, releases, tags or pushes were performed.

## Compact chat controls

Collapsed by default: one quiet row containing profile name, a small readiness dot
and chevron. No Load/Unload buttons, Stop explanation or diagnostics paragraphs
occupy the collapsed composer. This complements the existing generic `local-gguf`
model-selector alias rather than reproducing its provider/model menu.

Expansion reveals readiness, Load/Unload/Cancel loading as applicable, actual
context/GPU layer arguments, a direct link to Settings → Local Inference and a
separate collapsed diagnostics disclosure. Disclosure uses native keyboard buttons,
aria-expanded/controls and status/error announcements. Provider-keyed session state
survives chat/settings navigation; app restart starts collapsed. Actionable errors
expand the relevant panel. Hiding it never calls unload. Non-managed/native/cloud
providers do not gain this panel, and Goose's Stop generation remains separate.

## Audit: binaries and donor

| Runtime | Version/build identifier | Advertised speculative features | Adapter policy |
| --- | --- | --- | --- |
| Standard CUDA `/media/yaroslav/DATA/llama.cpp/build-cuda/bin/llama-server` | 0.4.1-dev, d1d3c33 | draft-simple, draft-mtp, draft-eagle3 and others; draft path, n-max/n-min, draft GPU layers | Embedded Qwen MTP allowed after metadata validation; external drafts blocked for this audited revision |
| Donor `runtime/llama/llama-server` | 0.8.0-dev, 5047748 | Same principal speculative modes/flags; additional draft microbatch option | Embedded/external MTP and classic draft configuration exposed where flags/metadata allow; external real-file generation remains untested |

The standard source at **git object d1d3c33** contains an external-draft loading bug
in `common/speculative.cpp`: the branch records the draft path but calls
`llama_model_load_from_file(params.model.path...)`, loading the target instead.
The version gate handles short/full commit identifiers and refuses external modes
for this known build; selecting generic draft is not a workaround.

Nearby donor source (`runtime/main-llama/source/common/speculative.cpp`) uses
`model_path` correctly and contains extended MTP scheduling/shared-memory/multihead
logic. Its current source HEAD is 4f17ccf43bfd2cb912ebbb56054291cd8991af3b;
object 5047748 is not present in that checkout. Therefore exact binary/patch
provenance is not certified by its location. No binary was patched or overwritten.
Flags alone are not treated as model compatibility or performance evidence.

Inspected donor modules: `mtp-capability.ts`, `gguf-speculative.ts`,
`mtp-diagnostics.ts`, `models/llama-launch-config.ts`, launch policy/profile types,
capability probes and placement guards. Portable concepts adapted: explicit modes,
metadata/tensor and tokenizer preflight, capability gating, disabled-setting
persistence, separate target/draft treatment and acceptance counters. No old UI,
agent loop or wholesale process supervisor was copied.

## Profile and backend implementation

New optional fields: `speculativeMode` (`off`, `mtp-embedded`, `mtp-external`,
`draft-simple`), `draft`, `draftTokens`, `draftMinTokens`, `draftGpuLayers`.
Absent mode means Off for existing profiles. A legacy draft path without explicit
mode is rejected with an actionable message. Absolute external paths are retained
without copying or modifying GGUF files. Disabled draft settings remain saved but
are not passed to the runtime or loaded; a disconnected inactive draft does not
make the normal target unavailable. Active missing drafts remain visible as missing
profiles, never automatically deleted.

- Embedded MTP: no external path; audited qwen35/qwen35moe, exactly one nextn head,
  full target presence, compatible embedding/context and valid projection/norm
  tensor dimensions/extents. Uses `--spec-type draft-mtp --spec-draft-n-max N`.
- External MTP: explicit selected backend support, distinct draft file, audited
  qwen35/qwen35moe/qwen3next architecture match, matching input/output dimensions,
  configured context, nextn head/tensor layout and tokenizer identity. Also passes
  `--spec-draft-model`; optional min tokens and draft GPU layers require flags.
- Classic draft: separate non-MTP llama/qwen2/qwen3 model with identical tokenizer
  and valid model structure/context; never substituted for Qwen-specific MTP.
- Token limits 1–16 (min 0–max), GPU layer ranges and GPU visibility are validated.
  Draft GPU settings cannot be silently ignored in embedded mode. The unverified
  expert-cache/MTP combination and unsupported native adapter activation fail.
- Off is enforced with `--spec-type none` when the selected executable advertises
  it. An inherited external draft path is cleared for Off/embedded launches.
- Save performs bounded metadata/probe validation without loading weights. Changes
  apply on activation; runtime arguments participate in the existing reuse/switch
  fingerprint. Ordinary chat still uses Goose → provider → gateway → llama-server.
  Diagnostics expose effective argv and log path without API credentials.

Metadata inspection reads a bounded GGUF directory, hashes tokenizer fields without
retaining vocabulary text, checks tensor shapes/known storage extents and caches by
real path plus inode/size/nanosecond modification identity. No tensor weights are
mapped or copied. Unsupported/truncated/oversized metadata fails conservatively.
Structural preflight does not prove training provenance, generation quality or speed;
backend initialization and actual generation must also succeed.

The Advanced Settings **Speculative Decoding / MTP** section uses existing Goose
inputs/buttons, capability-filtered modes, a draft picker, parameter fields, explicit
enable/disable, validation feedback and memory/compute caveats. Unsupported saved
modes can always be disabled. English/Russian catalogs are reused. No speculative
configuration controls are added to the composer.

## Local files and bounded GPU comparison

No separate draft/MTP-named GGUF was found in the local inventory. However, both
existing targets contain a complete embedded single MTP head:

- Qwen3.6-35B-A3B UD Q4_K_M: qwen35moe, 41 blocks, embedding 2048,
  nextn_predict_layers=1, valid block-40 projection [4096,2048] and norms.
- Qwen3.8-27B Q4_K_M: qwen35, 65 blocks, embedding 5120,
  nextn_predict_layers=1, valid block-64 projection [10240,5120] and norms.

Thus the real smoke comparison used embedded weights already in the same target,
not a downloaded or assumed generic draft. The initial 40-layer attempt exited
before generation while an existing user llama-server occupied 16652 MiB and only
about 6294 MiB was free. That user process was not stopped. The bounded plan was reduced
identically for both modes to eight GPU layers, context 8192, eight CPU threads,
batch 256, microbatch 128, flash attention On, K q8_0 and V f16.

RTX 3090 / driver 580.196.07 / standard d1d3c33. Same existing Qwen3.8 target,
synthetic prompt (30 tokens), temperature 0, seed 42, thinking disabled and prompt
cache disabled. One 4-token warmup and **two 32-token runs** per mode. Only timing,
memory and equality results were retained, not generated text.

| Observation | Off | Embedded MTP, n-max 2 |
| --- | --- | --- |
| Generation tokens/s, runs 1/2 | 2.61 / 2.62 | 4.36 / 4.70 |
| Prompt tokens/s, runs 1/2 | 11.01 / 11.10 | 9.26 / 10.92 |
| Observed process VRAM | 2962 MiB | 3388 MiB (+426) |
| RSS snapshots, runs 1/2 | 14877 / 15179 MiB | 16083 / 16388 MiB |
| Draft accepted/proposed, each run | N/A | 15 / 29 (51.7%) |
| Greedy output equality | baseline | matched baseline, both runs |

RAM figures are process RSS snapshots, with lifetime high-water marks in raw JSON;
VRAM is sampled, not a measured peak. Other user model residency and the tiny sample
limit generalization. Prompt processing did not improve. The observed generation
improvement applies only to this short partial-offload smoke test, not a universal
speedup, long-context result or full-GPU performance claim. Baseline measurement
used the runtime's None default; final adapter code explicitly enforces the same
None mode where the flag exists.

## Goose tool calling, UI and lifecycle verification

Real isolated Goose chat with embedded Qwen3.8 MTP executed one harmless Developer/
MCP printf. Structural audit showed the Goose system instructions, 17 tools,
`tool_calls`, a following assistant/tool-result pair and final `stop`. The first
reasoning-enabled partial-offload attempt was cancelled for latency; the successful
bounded test used max output 128 and thinking disabled. User chats/profiles and
existing model processes were untouched. No inference identity/system-prompt rewrite
was made. Protocol fidelity tests from the preceding gateway audit still pass.

Live UI checks verified collapsed default, Enter expansion, retained disclosure
across Settings/back navigation, direct Local Inference settings link, no unload on
hide, and a ready runtime remaining ready after collapse. Russian MTP mode labels
and invalid-token feedback were tested; validation stayed idle without weights.
Unit tests verify failure auto-expansion and unaffected native/provider behavior.

61 ordinary tests pass across eight files; one additional opt-in real GPU comparison
passed. Coverage includes schema roundtrip, disabled/missing draft paths, CLI gates,
architecture/tokenizer/dimension/context/head mismatches, tensor bounds, argv,
startup failure cleanup, normal/draft switching, cancellation, existing protocol/
chat/model-selector behavior and compact/advanced settings. TypeScript, targeted
ESLint and locale compilation pass. Local staging packaging and real GPU/tool
checks completed. No expensive benchmark or large download was performed.

## Limitations and modified files

External-draft and classic-draft GPU generation have no local compatible separate
pair to validate; those paths are covered with synthetic metadata/process fixtures.
The standard external-draft bug is blocked, not repaired by rebuilding llama.cpp.
Only the audited embedded Qwen single-head family is enabled; EAGLE, DFlash,
shared-KV and multihead/other architectures are not exposed as validated modes.
Patched MoE cache plus speculation remains rejected. Full Russian coverage/native
menus remain outside this change.

New files under `ui/desktop/src`: `ggufSpeculation.ts`,
`ggufSpeculativeMetadata.ts`, `ggufSpeculation.test.ts`,
`ggufMtp.gpu.integration.test.ts`, `test/ggufFixtures.ts`,
`components/ManagedLocalRuntime.test.tsx`,
`components/onboarding/SpeculativeSettings.tsx` and its test.
Modified: `ggufTypes.ts`, `ggufConfig.ts`, `ggufMessages.ts`, `managedGguf.ts`,
`managedGguf.test.ts`, `ggufMetadata.test.ts`, English/Russian catalogs,
`components/ManagedLocalRuntime.tsx`, `components/ChatInput.tsx`,
`components/onboarding/AdvancedLocalInference.tsx`, `utils/navigationUtils.ts`,
this report and historical-report cross-link. Rust files remain unchanged.

Evidence: `mtp-evidence/gpu-comparison.json`, test output, structural MCP summary,
metadata inventory and compact/expanded/Russian UI screenshots. Diagnostic records
contain no private request text or API keys. Temporary test data is removed after
validation. The updated local app resources apply on next restart; the running
user process is left intact.
