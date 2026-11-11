# Model filters, context choices and Flash Attention validation — 2026-11-04

## Delivered behavior

The existing Goose model menu now has Local / API / All filters. Managed profiles
and Goose's native `local` provider are local. Other providers remain API unless
hosting is positively identifiable: OpenAI compatibility or an Ollama provider
name does not establish that its host is local. The current managed/native
selection defaults to Local; other selections default to API. Explicit filter
selection survives menu closure and ordinary component/chat navigation in the
renderer. Search operates within the category. Existing model rows, identifiers,
selection/loading indicators and lifecycle actions are retained.

The session popover now says Context and KV Cache Precision (RU: Контекст and
Точность контекста (KV)). Exact discovered values from the existing registry are
sorted among standard presets. Separate FP16/Q8 identities are retained at the
same numeric context, while duplicate ordinary presets are removed. Selection
updates both pending context and KV; Apply remains explicit. Blue selection and
green maximum indication coexist. Saved/revalidation and changed-condition
results are distinguished in exact-token tooltips. Unsupported Q8 choices are
disabled with a capability/Flash Attention explanation. The selectable Custom KV
preset is gone; a disabled neutral placeholder represents existing mixed/advanced
K/V settings without mutating them. Manual numeric context remains available.

The existing Radix Portal, discovery animation, calculation core, safety policy,
registry, runtime lease, session-mode/effort behavior and agent loop are unchanged.

## Flash Attention audit and safe default

The inspected existing Qwen profile had no flashAttention field. The donor schema
also allows an absent value, its editor calls that Profile default, and its launch
argument builder omits --flash-attn when absent. Migration preserves this optional
field. No evidence of a lost explicit Off preference was found. The selected CUDA
binary advertises --flash-attn [on|off|auto], default auto. Therefore absent did NOT
prove actual Flash Attention Off. The application conservatively rejected
quantized V-cache unless the profile explicitly resolved to on.

A separate pure compatibility policy now resolves an implicit default to on only
for the audited qwen35 GGUF architecture, CUDA devices, GPU offload, advertised
--flash-attn and llama.cpp build d1d3c33. Embedded MTP is included after real smoke
verification. Native inference, unknown builds/architectures, generic drafts,
explicit CPU/MoE/tensor/expert-cache placement remain unchanged. Explicit on, off
and auto always win. Newly saved compatible profiles persist on. Existing unset
profiles resolve it for validation/catalog/activation without rewriting their
stored choice; effective arguments participate in discovery identity, making
older incompatible results stale. Missing flags/devices do not produce a false
compatible default. For excluded configurations users can select Flash Attention
On explicitly in the existing advanced profile editor; validation still checks
runtime flags, Q8 and MTP/MoE restrictions. No blanket claim of MoE/FA compatibility
or performance acceleration is made.

## Real RTX 3090 validation

Model: qwen3.8-27b-q4_K_M.gguf, already installed, architecture qwen35.
Runtime: /media/yaroslav/DATA/llama.cpp/build-cuda/bin/llama-server, d1d3c33.
Temporary isolated profiles only; existing user profiles/results were not edited.
One owned server at a time; no pre-existing llama-server; >22,500 MiB free VRAM
required before starting. GPU layers 999, threads 8, batch 256, ubatch 128.

- 8K FP16 and 8K Q8 K/V: inference succeeded through the managed gateway.
- Arguments contained --flash-attn on. Actual runtime logs said flash_attn = enabled.
- Embedded MTP + Q8, --spec-type draft-mtp, draft token maximum 2: short inference
  succeeded. This is compatibility evidence, not a speed/acceptance benchmark.
- Packaged Goose CLI → OpenAI provider → managed gateway → CUDA llama-server:
  a synthetic read-only MCP read_marker call completed. Structural audit observed
  tools, response tool_calls and a following tool result; the isolated MCP server
  recorded tools/call. No private user text or API key was retained in evidence.
- Genuine startup/health/inference discovery probes produced FP16 **102400 (100K)**
  and Q8 **176128 (172K)**. Final device headroom was respectively **916455424** and
  **775946240 bytes** in the last run. These values depend on current allocations
  and this exact non-MTP discovery configuration, not a guarantee for user profiles
  with different placement/MTP/MoE. The existing reserve policy was used unchanged,
  not a full-context correctness benchmark. Failed candidate startups remained
  failures; no Q8 fallback result was fabricated.
- Shutdown left no llama-server and GPU free memory returned to 23303 MiB at the
  final process check. No existing model, GGUF file, driver or system CUDA changed.

The initial test harness failed because it replied incorrectly to unsupported
MCP server/discover; returning JSON-RPC -32601 correctly exercised legacy fallback.
A subsequent audit assertion failed because it used a direct endpoint; routing
through prepare() fixed the harness. Final host test passed without product
agent/protocol changes. Sanitized evidence: model-filter-evidence/.

## Tests and packaging

Focused unit/integration checks cover filters/search, native/cloud selection,
action isolation, mixed KV preservation, exact discovered tokens and sorting,
unsupported Q8, migration preserving off/auto/unset, FA capability/default policy,
MTP validation, protocol summaries, leases/cancellation/storage and new-chat settings.
66 focused tests passed across 11 files; the additional hosting-classification test
passed separately, and the final 20 UI tests passed again after layout changes.
The separate real CUDA integration test passed. TypeScript and focused ESLint passed; extracted EN resources and RU placeholder/key
validation passed (1790 messages), other locales retained.

Chromium fixture interactions passed dark/light at 360 and 1280px: actual Radix
Portal geometry/hit testing, viewport bounds, Escape/focus restoration, outside
click, filtered long-list scrolling and Q8 selection. Screenshots explicitly named
fixture are NOT Electron. They use the measured 100K/172K values as fixture data.
A reduced-motion CSS transition required waiting for the next rendered frames to
observe the selected blue border; a computed-style assertion now checks it rather
than only class names.

Electron Forge Linux x64 package built with Node 24.19.0. Installed at the existing
ui/desktop/out/Local AI Desktop-linux-x64 path, after checking no dev application
was active. The prior package was retained as a timestamped sibling backup.
The bundled executable resources/bin/goose exists, is executable and has the same
SHA256 as src/bin/goose:
5813500c2a5fe0bb340b3dba34dca3c493d1752a5f9975177a28b0c552b48a9d.
ASAR contains the new category and KV labels. Both existing desktop entries passed
validation; their shared launcher, identity and installed AppArmor rule are unchanged.

## Real desktop observations and limits

Cold start through the registered local-ai-desktop-goose-dev GNOME desktop ID,
using gtk-launch from the real user session manager, created Electron PID 68389,
backend PID 68653 and mapped X11 window 0x4600004. WM_CLASS is
local-ai-desktop-goose-dev. Backend startup and React-ready were logged at 18:24:15.
The initiating unit used RemainAfterExit=yes and KillMode=process: an earlier
plain test unit killed detached children when gtk-launch exited, and was not
counted as launch success. Stopping the corrected initiating unit left the app
and backend alive. No launcher changes were needed.

Observed programmatic X11 clicks opened Local, API/Cloud and the real session
popover. Target-window screenshots show their actual rendered content. This is
not a human click on the GNOME Applications icon. CUA has no usable app surface;
no claim of CUA or human mouse verification is made. The actual user-profile
popover displays its older stale result, not the temporary smoke-test registry;
new results were deliberately not injected into user data. Context Apply/reload
and live cloud API calls were not repeated in this UI task. The owned test app is
left open; no model is loaded. Existing user processes were not terminated.

Screenshots:
- Real Electron: ../screenshots/model-filter-local-electron.png
- Real Electron: ../screenshots/model-filter-api-electron.png
- Real Electron: ../screenshots/context-popover-electron.png
- Real Electron KV control: ../screenshots/kv-precision-electron.png
- Chromium fixture with measured-value grid: ../screenshots/session-popover-fixture-dark-360.png
- Dark/light, 360/1280 fixture variants are alongside these.

## Files changed for this task

- ui/desktop/src/components/settings/models/bottom_bar/ModelsBottomBar.tsx and test
- ui/desktop/src/components/settings/models/bottom_bar/modelCategories.ts and test
- ui/desktop/src/components/SessionSettingsPopover.tsx and test
- ui/desktop/src/contextDiscovery/contextChoices.ts and test
- ui/desktop/src/ggufFlashAttention.ts and test
- ui/desktop/src/ggufFlashAttention.gpu.integration.test.ts
- ui/desktop/src/ggufConfig.ts
- ui/desktop/src/ggufTypes.ts
- ui/desktop/src/managedGguf.ts and test
- ui/desktop/src/i18n/messages/en.json and ru.json
- ui/desktop/tests/ui/model-controls-layout.tsx
- ui/desktop/tests/ui/check-model-controls-layout.mjs
- This report, sanitized evidence and screenshots.

All prior uncommitted work was preserved. No commits, pushes, tags or releases.
