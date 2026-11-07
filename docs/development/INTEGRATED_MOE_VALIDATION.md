# Integrated MoE: installed implementation and validation

The application now resolves ManagedGguf profiles to one application-owned runtime:
`resources/llama/llama-server` in `ui/desktop/out/Local AI Desktop-linux-x64/`.
Source development uses `runtime/llama`. There is no experimental backend selector or
hidden binary fallback. Existing stored executable paths are preserved on disk until
explicit profile edits; production resolves them to the canonical path. External d1d3c33,
legacy app, upstream Goose, drivers and model files are untouched.

The donor final runtime pins upstream5047748, not its earlier experimental tree.
The complete unified snapshot was built for CUDA sm86 with source hashes recorded;
no cache-only transplant or second agent/process architecture was introduced.

## Implemented

- Ported donor `model-memory.ts` formulas/reserves and original-versus-port parity tests.
- Actual GGUF tensor bytes, block indices, file type and expert classification via the
  existing bounded metadata reader. Qwen80B: qwen3next,48blocks,512experts,Q4_K_M,843tensors.
- Standard/Auto/Manual2/4/8/12/16GiB; safe sizes use free VRAM and donor reserves.
- Goose-styled block grid, per-block/shift range toggles, numeric ranges, all GPU/CPU/reset.
- Expert exclusion from selective CUDA regex; CPU expert placement remains independent.
- Profile settings persist with file identity; changed files require explicit confirmation.
- GPU layers999 default preserves explicit0. No profile writes merely on initialization.
- VRAM preflight:1536MiB compute headroom +2048MiB reserve. Host:2048MiB overhead,
  7168MiB reserve, mandatory anonymous memory separated from mmap working set.
- User systemd scope attached to the existing owned child; actual MemoryMax55GiB and
  MemorySwapMax0 confirmed. No global swap changes. A1s watcher retains the donor7GiB
  MemAvailable stop policy; only the owned process is stopped on unsafe/unavailable RAM.
  Scope creation is asynchronous; actual PID cgroup confirmation polls before readiness.
- Existing shared runtime lease/activity protection remains authoritative for load/reload.

Two actual integration corrections: unified CLI requires `--load-mode mmap` instead of
`--mmap`; donor placement also requires `--parallel 1`. With four default slots actual
recurrent state was301.50MiB vs donor75.384MiB estimate. Parallel1 restores measured75.38MiB
without changing the calculation core. These options apply only to bounded placement/cache.

## Bounded host benchmark

RTX3090; runtime5047748; existing Qwen3-Coder-Next Q4_K_M; context4096; Q8 K/V;
FA on; CPU MoE all; all48 ordinary blocks GPU, non-block tensors CPU; parallel1;
threads8; batch512/ubatch128; seed42/temperature0. Same25-token synthetic Python prompt;
16-token warmup then two64-token measurements per mode. Fresh owned process per mode.
Vision/MTP disabled for these measurements. Real cgroup max59055800320bytes, swap.max0.

| Cache GiB | Decode samples tok/s | Median (2) | Prompt samples tok/s | VRAM MiB | System RAM GiB |
|---|---|---|---|---|---|
| 0 | 26.77 / 26.76 | 26.76 | 61.88 / 64.82 | 3729 | 8.42 / 8.56 |
| 8 | 32.20 / 32.80 | 32.50 | 59.44 / 41.60 | 11953 | 8.46 / 8.58 |
| 12 | 41.85 / 43.20 | 42.53 | 153.18 / 53.60 | 15997 | 8.85 / 9.08 |
| 16 | 47.62 / 67.28 | 57.45 | 142.66 / 110.09 | 20093 | 8.30 / 8.36 |

RAM means MemTotal-MemAvailable, not process RSS; reclaimable mmap pages are treated
by OS MemAvailable. VRAM is whole-device usage. Two short samples do not establish
sustained throughput;16GiB shows strong warm-cache variation. Historical donor medians
29.07/36.96/46.82/56.25tok/s used different workloads. This approaches that range but
is not a controlled reproduction of the historical benchmark.

Logs confirm8191.99/12286.17/16383.98MiB cache allocations and actual hit/miss activity.
A separate selective test confirms blk.3 tensors overridden CPU and blk.4 ordinary
tensors CUDA0. Auto activation/inference also passed. See JSON evidence in
`integrated-moe-evidence/` for arguments, allocations, statistics, preflight and timing.

## Regression and desktop checks

- Core/UI tests6 passed: donor parity, ranges, expert exclusion, grid synchronization,
  unrelated settings preservation, exact7GiB runtime reserve.
- Focused metadata/speculation/FA/protocol/session/context suite42 passed.
- Host supervisor/Vision/first-message lifecycle suite29 passed.
- TypeScript, targeted ESLint, EN extraction check and RU validation1842messages passed.
- Actual Qwen27B CUDA A/B/C/D text/Vision/MTP matrix passed with image-dependent red/blue
  answers, direct and gateway. FP16/Q8/FA/MTP and real read-only Goose MCP read_marker passed.
- Real isolated Electron operated via DevTools:48blocks,8GiB cache, CPU block3; successful
  validation/save without weight loading confirmed in isolated JSON. Screenshot
  `integrated-moe-evidence/editor-ru-electron.png` is actual Electron, not Chromium fixture.
- Forge final package installed at the established path. Bundled Goose SHA matches
  src/bin/goose; runtime files match runtime-manifest.json.
- Existing GNOME entry was activated programmatically (gtk-launch, not mouse click).
  Main PID90407, backend90677; X11 WM_CLASS local-ai-desktop-goose-dev; mapped IsViewable
  window observed. No inference autoload. Launcher/AppArmor/sandbox unchanged.
- User profiles, context overrides and discovery JSON SHA256 remained unchanged.

## Explicit remaining limits

- Cache qualified only for donor-verified qwen3next48/512/Q4_K_M and pinned CUDA revision.
  Selective placement retains donor qwen3next/llama support. Multi-GPU preflight is blocked
  without unambiguous device mapping; unrelated devices are not summed.
- Experimental cache/selective placement with Vision/MTP/draft or mixed KV is rejected
  because donor memory estimates do not account for those combinations. Ordinary
  Vision+MTP remains tested and supported.
- Auto-cache Maximum Context Discovery is blocked: select a fixed Manual budget so
  candidate probes cannot change cache allocation policy. The mature discovery core,
  reserves and probes remain unchanged; a full MoE discovery run was not repeated.
  Fingerprints include selected blocks/cache mode/file identity.
- Preview does not reclaim-credit a loaded model; some sizes may require unloading first.
- Qwen35B/external draft pairs and long Qwen80B tool workflows were not separately run.
  MCP verification used27B. RU Electron interaction verified; English resources/checks
  passed. Some backend diagnostic detail strings remain English.
- GPU cache2/4GiB paths use the same validated size handling but were not benchmarked.

These are supported-scope limits, not claims of universal feature completeness.
