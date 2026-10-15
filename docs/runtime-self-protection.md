# Agent runtime and workspace architecture

[Documentation](README.md) · [Security reference](apparmor-security-review.md) · [User guide](en/USER_GUIDE.md)

This is the maintained architecture reference for the current source. It consolidates the earlier runtime-protection and task-workspace investigations; it does not certify an unreleased binary.

## Identity, ownership and persistence

Conversation, message, generation, logical task, execution attempt and managed terminal handle are distinct identities. A stable `logicalTaskId` owns plan, deliverables, Task Memory, observations, verification and checkpoints. SQLite persists that state; continuation and regeneration create separate attempts rather than resurrecting a process or rewriting old snapshots.

Independent requests do not inherit another task's deliverables. Explicit continuation can restore a saved canonical workspace without selected UI projects. Missing/retargeted directories require a valid user selection; model text, repository content and tool output cannot confer scope. Legacy conversation plans are preserved without inventing missing historical task boundaries.

Workspace is an enforcement scope, not a generic trust badge. File tools validate canonical paths and protected metadata; terminal execution mounts its validated cwd writable with protected infrastructure overlays. The two access surfaces are not identical. All permission modes retain mandatory boundaries. Scoped run grants are revocable and not durable after restart; revocation changes authorization, not merely a UI indicator. It cannot undo already completed writes.

## Production execution and process protection

The Rust shell tool and legacy Electron terminal path both use the mandatory isolation executor. PID namespaces protect host process addressing independently of approval and token-based command diagnostics. Known lifecycle commands fail before spawn; arbitrary scripts remain confined rather than being declared safe by a parser. See the [security reference](apparmor-security-review.md) for the actual kernel/loader boundaries and their limits.

`ProtectedRuntimeRegistry` tracks PID with kernel start ticks, executable, role, PPID/PGID/session, lifecycle and listener endpoints for main, Rust workers, launcher and model infrastructure. Snapshot/event records are updated on transitions and periodically. Listener/socket discovery identifies infrastructure; it does not authorize cleanup.

Controller checks reject stale identities after restart/PID reuse. Namespace protection does not depend on registry polling freshness. A model-server exit clears ready state; bounded refused-connection retry occurs only before request bytes are sent. A provider error alone does not prove process death, CUDA OOM or a backend downgrade. Saved task state can survive that failure.

Dedicated user Stop Model/Restart/Quit controls stay in the trusted host control path and are not Agent shell commands.

## Managed development processes

Long-lived foreground servers use `run_terminal` task actions:

```json
{"task_action":"start","command":"npm run dev"}
{"task_action":"status","task_id":"<returned handle>","command":""}
{"task_action":"stop","task_id":"<returned handle>","command":""}
```

The handle belongs to a run/workspace and an owned child/group, not an arbitrary PID or port. Other-run, expired or mixed PID/handle targets are rejected. Live unreaped child ownership prevents PID reuse from becoming cleanup authority; persisted historical PIDs are never adopted. Stop, timeout, cancellation and run-end clean up owned namespace descendants. Tasks are not automatically restarted after application restart, and plain background shell processes are not a substitute for managed handles.

Pause is cooperative at safe boundaries; an in-flight operation may finish. Steering is applied at turn boundaries. Stop cancels owned work but does not roll back completed edits. Interrupted tools are not silently replayed.

## Evidence and loop recovery

Verification needs actual check output of the right kind, scope, task and revision. Restoring an old snapshot does not refresh evidence. A test in A does not prove B was unchanged; integrity claims need a trusted prior baseline/journal. Real changes invalidate checks; supported identical file writes avoid physical writes and preserve evidence. Arbitrary scripts remain conservatively classified even when one observed file is unchanged.

Stage A gives specific guidance about the repeated action and next task step. Continued repetition can trigger Stage B exclusion of a provable complete repetitive segment from the next model request. This is a model-input overlay, not deletion of persisted history, complete tool pairs, Task Memory or evidence. Ambiguous cleanup and exhausted bounded attempts pause safely. A queued repair or acknowledgement is not processed work; metadata-only changes, repeated model text and no-op rewrites are not operational progress.

Context compaction is lossy. Requested/effective context, KV precision, offload and measurement conditions must be evaluated together. Available RAM alone is not a GPU-fit signal; mocked GPU fixtures do not establish real capacity or recovery from total memory exhaustion.

## Validation references

Implementation and regression anchors are in the [v0.2.0 audit map](releases/v0.2.0.md#implementationtest-audit-map). Archived fixture/model results retain their original provenance in the [release evidence section](releases/v0.2.0.md#validation); fresh package, migration, model/GPU and lifecycle acceptance remain in the [release checklist](releases/v0.2.0-checklist.md).

The historical listener-kill incident was not conclusively diagnosed: terminated PIDs were not captured. Later isolation closes that class of unsafe host-process operation without retroactively proving causation; an intentional later project deletion is not a runtime defect.
