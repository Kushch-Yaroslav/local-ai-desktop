# Integrated MoE runtime migration — work in progress

This historical implementation checkpoint is superseded by [INTEGRATED_MOE_VALIDATION.md](INTEGRATED_MOE_VALIDATION.md). The integrated runtime/editor/cache workflow is now built, validated and installed within the documented scope.

## Source evidence

- Existing external runtime source: `/media/yaroslav/DATA/llama.cpp`, revision
  `d1d3c3396aa13a5f239109a822666c4870490ad5`. Source inspection found no expert-cache
  implementation. This external installation is untouched.
- Final donor `resources/llama-runtime.json` pins upstream
  `5047748f114564fcf271e6a648f60e2d2eae6264`, `unified-runtime-v1`, CUDA SM86.
  It explicitly describes **official upstream MoE cache, no local scheduler patches**.
  Earlier `runtime/experimental-llama-moe` artifacts are not the canonical donor runtime.
- The donor `runtime/main-llama/source` is a source snapshot without its own Git checkout.
  Running `git -C` there resolves the enclosing application repository and must not be
  used as evidence of the llama.cpp revision. The declared pin and selected source
  file SHA256 hashes are recorded in `runtime/integrated-llama/provenance.json`.
- CUDA staging uses this complete unified snapshot; no cache-only transplant into
  unrelated d1d3c33 APIs and no second application backend selector are introduced.
  Integration/installation is gated on runtime tests.

## Donor boundaries to preserve

- `src/shared/model-memory.ts`: actual tensor-byte accounting, expert exclusion from
  ordinary GPU weight placement, Qwen3next attention/recurrent accounting; 1536 MiB
  compute headroom, 2048 MiB GPU reserve; auto cache rounded down in 1024 MiB units,
  capped at 16384 MiB. These constants are donor policy, not measured universal costs.
- The same module separates mmap file-backed weights from mandatory anonymous RAM;
  2048 MiB runtime overhead, 7168 MiB host reserve, cgroup checks. Full mmap working-set
  pressure remains diagnostic even when mandatory allocations fit.
- `src/main/models/advanced-placement.ts`: CPU overrides precede selective CUDA
  overrides; CUDA block regex excludes expert tensors when CPU MoE/cache is active.
  Cache requires `--cpu-moe`, `--no-host`, `--no-repack`, `--lazy-mode off`, bounded
  batch/ubatch. These are independent from numeric GPU layers.
- `src/main/services/model-placement.ts`: validated cache model restriction is
  Qwen3next / 48 blocks / 512 experts / Q4_K_M, with metadata and CUDA checks.
  Donor experimental memory preflight rejects projector combinations it cannot
  account for. It must not be copied as an unconditional Vision restriction for
  all ordinary inference.
- Existing v0.4.0 already passes CPU MoE, tensor overrides and manual cache MiB via
  the shared ManagedGguf supervisor. It lacks the donor tensor inventory, Auto mode,
  layer grid and full placement preflight. These remain unfinished.

## Current changes

- New external profile GPU Layers default 999; only missing legacy values are
  resolved in memory. Explicit zero and existing numeric preferences are retained.
  No real profile file is rewritten on initialization.
- GPU label/helper updated in EN/RU.
- App-owned generated source/build under `runtime/integrated-llama`; ignored build
  artifacts, recorded source hashes, reproducible staging build script. No installed
  runtime or launcher is changed by that script.

## Validation/install gate (still required)

Complete CUDA compilation; verify devices, normal dense inference, Vision, embedded
MTP, cache allocation/activity, Qwen80B placement and bounded paired benchmarks.
Then integrate a single canonical app-owned executable into ManagedGguf with compatible
profile migration and rollback. Do not migrate real profiles before validation.
No new Qwen80B performance measurements or acceleration claims yet.

## Observed host / model audit

Host CUDA query: RTX 3090, 24576 MiB total / 23053 MiB free at audit;
MemAvailable 53512 MiB. Bounded read of the actual target GGUF found architecture
`qwen3next`, 48 blocks, 512 experts, 843 tensors, 144 expert tensors.
No weights copied or mapped. The existing speculative metadata reader does not
retain `general.file_type`; donor quantization qualification must be restored
before claiming this profile passes the donor verified-cache predicate.

Checks: TypeScript passed. Host-side isolated lifecycle/Vision/default tests:
26 passed. Same lifecycle suite in restricted sandbox failed credential/spec
capability probes on its mock executable; host rerun passed without changes.
Targeted ESLint and Russian locale validation (1825 messages) passed.
