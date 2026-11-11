# Session controls and context discovery port notes

## Current implementation state

This work began on branch `migration/v0.4.0-goose`, HEAD
`3f71f18d9b783730fc4b45bb9f73a85f0d61e78d`. Existing uncommitted model-manager,
MTP, compact-runtime, launcher and localization changes were present and remain
untouched. No concurrent model runtime was stopped. The active llama-server
reported by the prior task is not used for discovery.

The chat composer now has a small gear popover after the cost indicator. Agent
mode selection uses Goose's ACP `session.setMode` values (`auto`, `approve`,
`smart_approve`, `chat`) and refreshes the session snapshot after applying. This
is a **current-session** choice; Settings → Chat's `GOOSE_MODE` is a global
default for new sessions and remains distinct. The UI does not label the
session value as global. Chat Only restrictions remain enforced by Goose.
Thinking effort uses Goose's session `thinking_effort` config option. The
selector is hidden for models Goose marks non-reasoning and mirrors Goose's
fallback effort list and its GLM/Kimi restrictions; provider-specific dynamic
effort lists are not yet surfaced to this popover. No hard token budget is
implied. RU/EN messages use Goose's existing i18n.

The mature donor calculation core was ported with its conservative evidence
requirements and candidate algorithm intact:

- `contextDiscovery/vramBudget.ts`: 1550 MiB absolute non-LLM background GPU
  budget; 384 MiB estimator margin; 256 MiB tolerance for changing GPU
  conditions; 150 MiB minimum probe guard. The 1550 MiB budget is not added on
  top of observed background use.
- `contextDiscovery/contextDiscovery.ts`: 4K candidate buckets, 8K stopping
  granularity, at most 8 search probes per cache type, 16K-or-lower base
  context, 4 GiB emergency host reserve, and 256 MiB prediction uncertainty.
  Candidates are predicted from measured allocation evidence and must pass an
  exact-context startup, health and inference probe. The final decision applies
  the supplied host reserve (donor default 8 GiB) and device reserve (donor
  default 384 MiB), then runs/validates a final candidate. Failed probes are
  retained as failure evidence; unsafe predicted candidates are skipped before
  launch. The original configuration is restored in `finally`.
- `contextDiscovery/contextEstimator.ts`: linear KV/compute allocation budget,
  including separately measured speculative weights, buffers, KV and slots.
  Any missing field or `unknown` speculative mode returns no hardware-safe
  estimate. It never assumes unknown MTP/draft/MoE allocation is zero.
- Model hard limit in the donor comes from the lower of the configured/runtime
  maximum and GGUF architecture training context. The discovery caller also
  probes both FP16 and Q8 K/V, measuring current free memory and launch
  allocation evidence. Q8 is only retained if it verifies at least an 8K
  improvement over FP16.

The new calculation-core tests exercise deterministic donor-derived measured
fixtures, reserve behavior, skipped unsafe candidates, restore-on-failure and
unknown speculative allocations. During this task, the read-only donor function
and port were also invoked side by side on identical synthetic measurements.
Recommended context/cache pairs and every probe record (candidate, phase,
startup, reason) matched. That one-off comparison was not retained as a test
dependency, so the development repository remains independent of the old
checkout.

## ManagedGguf integration

The donor calculation now runs through an adapter on top of the current
ManagedGguf supervisor. ManagedGguf owns **one child llama-server at a time**;
saved profiles each have a loopback gateway, but choosing multiple profiles
does not create multiple model processes. The adapter probes the requested
profile, captures the actual effective profile if loaded, starts candidate
contexts with FP16/Q8, performs `/health` plus a short real completion, reads
the latest llama allocation log and current RAM/VRAM telemetry, then restores
the previously loaded process in `finally`. If no managed model was loaded,
the adapter leaves it unloaded. It never signals unrelated external
llama-server processes.

The chat popover checks Goose ACP activity snapshots for every session routed
to a managed external profile. It refuses discovery while any such session is
active. After that check, the main process atomically grants an exclusive
runtime lease; provider requests arriving during discovery wait at the
loopback gateway. The renderer checks session activity again after obtaining
the lease. Cloud and native providers do not use the managed gateway and are
not included in that lock. Cancellation aborts the probe, but restoration uses
a fresh signal and completes before the lease is released. A request that was
already active prevents lease acquisition.

Context/KV values in the popover are a pending session override. Discovery
results are saved under the donor-compatible configuration hash and separate
FP16/Q8 rows. The key includes model/projector/draft file fingerprints, runtime
path/version/fingerprint, stable launch arguments, MTP/MoE placement, model
context limit, GPU identity/total VRAM and memory-reserve policy. Exact-key
history is labeled as saved/unconfirmed; different-key history is marked
changed. Neither is represented as a live guarantee. Manual context is checked
against model and launcher bounds but is not clamped to the automatic memory
reserve. Apply obtains the same exclusive lease; when loaded, it reloads and
waits for readiness without resending a chat message; when unloaded, it saves
a separate override for the next activation. Profile defaults remain intact.

The estimator requires complete logs and measurable telemetry for its result.
If `nvidia-smi`, process RSS, allocation records or a compatible cache flag are
unavailable, the corresponding cache result is rejected rather than guessed.
`q8_0` is exposed only when the selected executable advertises it; a
quantized V cache still requires the profile's existing flash-attention
validation. The adapter has not been run against a real 3090/model in this
environment, so host-side GPU discovery and memory-fit claims remain
unverified. The tested integration uses local HTTP fixture servers and
synthetic donor-derived allocation evidence.

One runtime-level limitation remains: while discovery owns the shared runtime,
new managed-provider requests are held at the gateway rather than rejected.
This preserves their Goose session/history, but the app does not show a
per-session queued badge yet. Closing the window that owns a discovery cancels
the probe and completes restoration before releasing the lease.

## Donor source audit

The principal sources inspected in the read-only v0.3.2.0 tree were:

- `src/main/services/context-discovery.ts`
- `src/shared/context-estimator.ts`
- `src/main/services/context-estimate.ts`
- `src/shared/vram-budget.ts`
- `src/main/services/host-memory-guard.ts`
- `src/main/services/hardware.ts`
- `src/main/models/llama-launch-config.ts`
- `src/main/services/context-discovery.test.ts`
- `src/main/services/context-discovery-conditions.ts`

Host guard separately requires at least the configured host reserve before CPU
weight allocation and fails closed if host free-memory data is unavailable.
Discovery's 4 GiB emergency reserve is an intermediate probe floor; the final
selection uses the configured 8 GiB default reserve. GPU assessment tracks
currently free memory and existing LLM/background allocations; it does not
assume a 24 GiB card has 24 GiB available. GPU layer count affects residency
measured by the llama.cpp allocation log. K/V quantization is measured for both
caches from the actual probe. CPU/GPU placement is taken from allocation tiers,
not inferred from a large context label.

The previous app's strategy is separately researched in
[`AGENT_STRATEGY_FEASIBILITY.md`](../migration/goose/AGENT_STRATEGY_FEASIBILITY.md).
