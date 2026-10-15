# Current capabilities

[English](FEATURES.md) · [Русский](../ru/FEATURES.md) · [Home](../../README.md)

This is the current source capability reference. Release-specific changes and validation belong in the [release history](../../CHANGELOG.md).

## Inference, Chat and presentation

- Launcher-managed external `llama-server`, local GGUF profiles and custom model paths; context, KV cache, GPU layer placement and optional model/backend-dependent MTP.
- Streaming Chat, model-supported thinking/reasoning controls, cancellation, message editing and regeneration. Agent Fast/Deep strategy is a separate setting.
- SQLite conversations, attachments, run history, logical tasks, checkpoints and context-discovery records. Active Agent execution can continue while another chat is displayed.
- Local extraction of text/code, PDF, DOCX, XLS/XLSX and CSV/TSV; bounded structured table reads. No OCR or spreadsheet formula evaluation. Images require a compatible model/projector; image CPU/GPU selection does not move the whole LLM.
- Rich Responses: KPI cards, charts, tables, restricted Mermaid, sourced image galleries and combined reports; CSV/table copy and SVG chart/diagram export. Schema validation does not establish factual accuracy. Mermaid retains source and actionable render errors.
- Optional web search/image search and read-oriented page navigation; no general browser automation or form submission. Web content remains untrusted.

## Agent tasks and continuity

Rust Agent Runtime V2 orchestrates model and tool turns. A stable logical task owns its plan, deliverables, Task Memory, observations, verification state and checkpoint, separately from conversation, message, execution attempt and managed-process IDs.

New independent requests start new tasks. Explicit continuation, regeneration and follow-up steering retain the appropriate ownership. Finished attempts have immutable snapshots next to their responses; the active panel appears only during execution. The recent-task selector avoids scrolling back through reasoning traces. SQLite preserves state across restarts; resumption starts a new execution attempt, not a resurrected process.

Task Memory records findings, decisions, blockers and next steps with observation references. It supports continuity through compaction; it is not general experience shared automatically across unrelated tasks. Legacy conversation plans are retained without inventing missing task ownership or historical evidence.

## Files, commands and verification

Two selected UI projects support `@` references. Filtered absolute paths explicitly supplied by the user can also establish task scope; model output, files and tool results cannot grant it. Explicit continuation can restore its saved canonical scope without a currently selected UI project. File tools reject traversal, symlink escapes and protected metadata writes.

File reads/searches, Git inspection, writes, replacements, patches and deletion are supported subject to policy. Supported writes retain recovery copies and use atomic replacement; multi-file rollback is best effort, with no general Undo UI. Identical `write_file` and no-op patches avoid rewriting files or invalidating evidence. Controlled public HTTP(S) downloads include bounds, cancellation, checksums and atomic placement; they do not bypass gated access, resume downloads or install models.

Terminal commands run in mandatory isolation. Managed task handles support development-server start/status/stop; host PIDs and listening ports do not confer cleanup authority. Stop/shutdown clean up owned activity. Unsupported process-management commands are blocked; use managed handles for cleanup.

Verification distinguishes readback, static checks, builds, tests, runtime checks, browser checks and integrity claims. Evidence must have an appropriate kind, scope, task and fresh revisions; a passing test is not universal proof of every selected deliverable. Recognized scoped wrappers and standard observed Python unittest drivers can supply test evidence. Real changes invalidate relevant checks; arbitrary scripts remain conservatively classified. Non-modification claims remain unverified when no trusted pre-operation integrity baseline/journal exists. Historical verification is a snapshot of that attempt, not a current filesystem guarantee.

## Permissions and lifecycle

Only **Ask for confirmation** and **Absolute Autopilot** are offered. Ask automatically permits recognized reads and requests approval for edits/execution. Autopilot permits routine operations within established task scope without repeated prompts; mandatory or out-of-scope actions return a blocked explanation. It does not add filesystem access. Legacy mode values are accepted; trusted-folder management is no longer a user workflow.

Approval may be one-off or scoped to the current run; grants can be revoked and are not durable authorization after restart. Mode changes apply to subsequent operations. Stop cancels owned work without rolling back completed edits. Pause records a checkpoint at a safe runtime boundary; steering is delivered at turn boundaries. Server-exit diagnostics and bounded pre-send connection retries preserve saved work without replaying partially submitted inference.

## Loop recovery and context

Repetition detection considers tool arguments/results and observable progress, not reasoning text alone. Stage A injects specific corrective guidance. If the same unproductive loop returns, Stage B excludes only a provable repetitive segment from the next model request. Complete tool pairs and productive context are preserved; persisted history, Task Memory and verification evidence are not deleted. Ambiguous boundaries or exhausted recovery attempts pause execution. Continue without repair re-arms detection; recovery processing is visible in the timeline.

Context options use separate FP16/Q8 columns: 16K, 32K, 64K, 128K and 256K, bounded by actual model/backend support, plus exact discovered values. Discovery records are separate by model, KV configuration and measurement conditions. Saved/manual selections can load without a new search; changed conditions warn rather than silently downgrade the request. Requested and effective settings remain distinct. Discovery runs bounded real probes and restores the previous configuration; it is not an exhaustive hardware maximum. The compact information popover shows two measured maxima, shared current VRAM telemetry and the supported limit.

<a id="security-boundaries"></a>
## Security boundaries

On the validated Ubuntu deployment, a dedicated, root-owned non-setuid Bubblewrap helper uses enforcing setup and stacked child AppArmor profiles. Terminal execution has separate user/PID/mount/IPC/UTS namespaces, private `/proc`, `/run` and `/tmp`, dropped capabilities, NoNewPrivs and seccomp. The setup environment is an explicit allowlist; payload environment is transported separately and applied after confinement. Direct helper execution from the child is denied. Isolation failure does not fall back to a host shell.

The host root is largely read-only inside the terminal; the validated working directory is writable, with protected application/model paths overlaid read-only. This is not a confidentiality sandbox: readable host files may remain visible. The network namespace is shared for development HTTP; arbitrary TCP control APIs and resource exhaustion are not fully contained. Some socket/namespace-dependent developer tools will not work. File tools enforce their own canonical path scope outside Bubblewrap.

A process registry tracks PID plus start time/executable, roles, groups, parentage, lifecycle and endpoints. PID isolation and kernel restrictions protect against indirect signal attempts independently of command classification. Dedicated application Stop Model/Restart/Quit paths retain their authority. This does not establish protection against malicious unconfined programs of the same user, root or kernel flaws. Group-scoped helper access is not authentication of Electron as its sole caller.

Only Linux x86_64 has the implemented seccomp bootstrap. Other hosts need validation; successful parsing or fixture execution alone is not security certification. See [installation prerequisites](GETTING_STARTED.md) and [release limitations](../releases/v0.2.0.md#limitations).
