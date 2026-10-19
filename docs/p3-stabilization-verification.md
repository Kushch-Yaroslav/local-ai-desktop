# P3 stabilization — verification and limits

Branch: `fix/v0.3-p3-stabilization`, based on `e03527d` (`feature/v0.3-native-browser-qa`). See [initial state/data map](p3-stabilization-state-map.md). Tests use `/tmp/lad-*` runtimes, dedicated ports and owned processes. User `runtime/`, installed `local-ai-desktop 0.2.0` package, main and releases are outside the mutation scope.

## MTP diagnosis

The user launch log at 2026-10-19 15:48–15:57 records Electron repeatedly rejecting MTP through `conversations:update`/`mtp:apply`, while the same supervisor successfully started Qwen3.6 at 77824 context with `speculative.confirmed mode=mtp`. This disproves a general model/backend incompatibility. No private conversation content is copied into this report.

The original probe combined every `execFile` error (3-second timeout, output limit, execution failure) and an unsuccessful flag match into `false`, then cached that result for the executable's entire unchanged lifetime. It discarded stderr and the exception. Main's long-lived cache and launch helper's fresh process could consequently disagree indefinitely. Its parser also required the supported enum on the first help line; null override disagreed with the launcher's PATH fallback.

**Limit of historical attribution:** the original probe erased its exception. A specific original timeout/OS error cannot now be proven. Current real Electron and Node probes both succeed with the original flag matcher. The captured installed help does not wrap `draft-mtp`, so wrapping is a regression risk fixed by tests, not an asserted cause of this particular incident.

Now the probe distinguishes supported/unsupported/error, retains executable path and actual failure, shares in-flight probes, retries failures, expires successful/negative cache entries within a minute, follows symlinks and fingerprints the executable. It inspects the complete `--spec-type` block. Missing configuration uses the same PATH fallback as runtime setup. No fake support and no removal of model or backend validation.

Actual backend: `/media/yaroslav/DATA/llama.cpp/build-cuda/bin/llama-server`, `0.4.1-dev`, build 1, commit `d1d3c33`. It advertises `--spec-type ...draft-mtp...`, `--spec-draft-n-max`, metrics and multimodal projector flags. Real device: NVIDIA RTX 3090. [Help](test-results/p3/llama-help.txt), [version](test-results/p3/llama-version.txt).

Both GGUFs pass NextN metadata, target/head tensor dimensions and payload inspection:

- Qwen3.8-27B: `qwen35`, one head, projection `[10240,5120]`.
- Qwen3.6-35B-A3B: `qwen35moe`, one head, projection `[4096,2048]`.

[Real Qwen matrix](test-results/p3/qwen-matrix.json) records actual process identity, context, MTP mode, metrics and image-inference results. For each model: On+Vision On, Auto+Vision On, Off+Vision On, On+Vision Off, Off+Vision Off with context change. On/Auto accept real drafted tokens. Both On+Vision On runs analyze a real Chromium PNG. Vision Off is a policy setting; the compatible projector may stay loaded, while image transmission is disabled by the policy. This does not claim a performance improvement on arbitrary prompts.

## Reload transactions

- Model/MTP/required-projector preflight runs before stopping a healthy process. A rejected configuration preserves its PID and settings.
- The production supervisor still owns stop/start, health/model/context/MTP checks and bounded rollback. Invalid projector bytes exercise a real failed initialization and restoration of the previous model, context, KV, projector placement and MTP mode; a subsequent valid load succeeds.
- Conversation model/context/KV commit occurs after successful activation. The old error handler's write of rejected settings was removed. Renderer drafts and failed activation diagnostics remain separate from the last committed settings.
- Strategy/Effort requests no longer acquire KV launch fields. A test changes one chat's strategy while another context is active and proves no backend restart.
- MTP Unloaded, Checking, Available, Active, Disabled, Missing Weights, Unsupported, Probe Error and Reload Required are distinct in the UI/data flow. Auto fallback reports ordinary disabled speculation with its cause, rather than requiring endless reload.
- Reload details show active and target model, old/new context and MTP, compatibility and the operation error. New model defaults and selected context use the same initial-context policy as Main. Reselecting an unchanged context clears its draft. Details are initially expanded.

## QA diagnosis and semantics

`QA budget exhausted without fresh evidence for the final changes` was emitted by the **old fixed three-review Verification Gate**, added in `821678f` and removed in `3042d3f`. The exact string survives in a user's persisted task-memory evidence. It is not a new QaLoopGuard quota. Current code has no producer of this message.

Legacy reports are displayed as stale evidence, with the original reason retained in expandable diagnostics. On restoration into a new run, previous browser evidence is explicitly stale. Final edits invalidate functional and visual verification at the current mutation epoch; confirmed task-memory observations and evidence files remain retained. A new run requires fresh functional proof because external edits may have occurred. Auto QA asks at most once per revision; later real mutations reopen that review. Bounded completion reminders are not tool-execution quotas.

Existing VerificationStatus remains authoritative (Verified/Partially Verified/Failed/Blocked/Not Verified). Optional reason codes add cause, not a parallel status machine: `QA_NO_PROGRESS`, `QA_TIMEOUT`, `QA_TOOL_ERROR`, `EVIDENCE_STALE`, `PERMISSION_REQUIRED`, with UI support for incomplete verification and authentication. A timed-out action is Blocked, an infrastructure error is unverified, a demonstrated assertion/runtime defect is Failed. Only functional proof establishes functional Verified; unavailable Vision cannot invalidate that proof. Vision findings remain qualified evidence and can make the combined result partial, rather than fabricate a factual application failure.

No task-wide useful-QA count limit. Actual operation limits remain:

- Functional QA deadline 30 seconds; combined browser QA abort signal 90 seconds; individual interactions generally 3 seconds.
- Vision HTTP request 60 seconds, one concurrent analysis, 1.5-second spacing, at most two frames, each at most 2 MiB and 1280×900 pixels; 768 output tokens. JSON-schema-constrained output is still validated before acceptance.
- Eight **explicit screenshots per run**; internal QA captures are independent.
- Approved project/origin, permissions, browser/network/file protections unchanged.
- Revision hashing: bounded 50000 entries, 4 MiB/file, 32 MiB total; approved regular files, no symlink traversal or hidden paths. Vue/Svelte/style/config sources now participate.
- Loop observation storage is bounded (128 scenarios, 32 outcomes each); recurring unchanged outcomes block that QA locally with retained evidence. Two repeated outcomes, A/B/A and recurring three-status cycles are tested. New source, scenario, external state, runtime or accepted permission changes allow retesting. Browser reopen cannot reset the guard. Explicit user continuation can reopen an observation window; other tools continue after a guard block.

Real Qwen3.6 initially produced schema-invalid Vision JSON. A server-enforced response schema fixes the observed problem without inventing evidence; malformed responses still remain unverified with diagnostics. Earlier failed matrix runs are retained as diagnostic artifacts and are not counted as passing tests.

## Runtime and UI

Paused is no longer cleared only from the literal Resuming string. Authoritative model-state clears stale pause; terminal events carry an explicit confirmed pause flag; Stop/error/completion clear it. Reopened chats restore Paused only from the latest interrupted run's persisted pause checkpoint. Toolbar reads its active conversation view. Text deltas never establish Running.

Dark theme now sets native `color-scheme`, explicit project-button surfaces, shared disabled text and select-option colors. Hover/focus/selected states retain the v0.3 design and common tokens. Contrast is measured in real Electron for Unloaded/Ready; running/paused controls use the same tokens and are exercised by runtime control tests.

Decorative `⟳` removed from MTP, Context, Browser Vision, configuration badge and the unconditional model-group heading. Decorative live `↻` removed from Strategy/Effort labels and heading. Functional refresh/reload buttons remain. Reasoning changes show next-request/pending text.

Browser QA's collapsed row now includes the short status, actual localized reason and separate image evidence indicator. Detail preserves checks, errors, paths, original diagnostics and finite timing only. RU/EN and Compact/Expanded are covered. Model-generated visual summaries remain unchanged.

## Test evidence

Final results: **386 Rust tests passed**, 32 controlled/Chromium/Electron/security suites passed, TypeScript/ESLint/build/localization passed. [Machine-readable summary](test-results/p3/summary.json). Real Qwen Native Browser: Pause 1205 ms, Stop 504 ms, same native view and task memory on Resume; actual functional and image QA Verified. Real production-launcher checkpoint test: Pause 389 ms, successful Resume after MTP reload without repeated edit.

See [regression results](test-results/p3/regressions.json), [real matrix](test-results/p3/qwen-matrix.json) and final summary in this directory. Scripted providers/controlled launchers are explicitly identified; no scripted Vision response is counted as real image inference.

The installed package is 0.2.0 and lacks this v0.3 MTP controller; the reported stack paths point into this source checkout's `dist/`. No installed package modification was needed.

Reproduction commands: `npm run test:p3` for build/lint/Rust and controlled/Chromium/Electron suites; `npm run test:p3:qwen` for sequential real GPU acceptance. Tests involving native OS input must be sequential; concurrent native windows compete for focus.

The additional normally ignored Rust `live_scoped_browser_acceptance_with_project_warning_and_inverse` was explicitly attempted. It launches Chrome through sandboxed `run_terminal`; Chrome fails with `socket() failed: Operation not permitted` under the terminal security policy. The check correctly remains unverified. No sandbox weakening or browser workaround was introduced. Supported host/Native Browser regression and real Qwen acceptance exercise the current browser architecture separately.

Local implementation commits: `79ce607` (MTP/reload), `e8b1c89` (QA/evidence/Vision), `e6b6764` (runtime/UI). A separate test/evidence commit records this report and reproducible P3 commands. Ready for user testing on the verified local backend/models; the historical probe trigger and legacy ignored terminal-browser scenario remain explicitly bounded limitations.
