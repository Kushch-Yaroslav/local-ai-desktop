# User guide

[English](USER_GUIDE.md) · [Русский](../ru/USER_GUIDE.md) · [Home](../../README.md)

For installation use [Getting started](GETTING_STARTED.md); for release changes use the [changelog](../../CHANGELOG.md).

See [Browser QA](BROWSER_QA.md) for scenario verification, responsive viewport checks and the Verification Gate.

## Select a model and context

Configure local GGUF and `llama-server` paths in Settings, then select the model in the toolbar. Opening a saved chat does not itself load or restart its model. Use the explicit load action and wait for the ready status.

The context menu has FP16 and Q8 columns. Standard sizes are 16K, 32K, 64K, 128K and 256K, bounded by model/backend support; exact discovery values are inserted without duplicates. A previously selected supported configuration is retained. Arrow keys navigate, Enter selects, Escape closes; the list scrolls.

| Indicator | Meaning |
| --- | --- |
| Neutral | Not evaluated under confirmed comparable conditions |
| Green | Within the measured GPU-fit range for this KV type and comparable conditions |
| Turquoise | Exact discovered GPU-fit maximum for this KV type |
| Yellow | Above that measured boundary; more memory may be needed or loading may fail |

These are measurement statuses, not guarantees. FP16 and Q8 results never validate each other. **Load selected configuration** can use a saved or manually supported option without rediscovery. Changed model/runtime/memory conditions may show a warning; the requested context and KV type are not silently replaced. Backend load errors remain available in expandable details. The effective runtime indicator describes what actually loaded, not the selected future request.

### Find Maximum Context

**Find maximum context again** runs bounded probes on a launcher-managed model: server restarts, health checks, inference and memory measurements, followed by restoration of the previous configuration. It can interrupt model availability; start it deliberately when no task needs the model. Discovery recommends a configuration; it is not a mandatory prerequisite or an exhaustive out-of-memory search.

The **Maximum Context** popover shows a short FP16/Q8 explanation, separate discovered maxima, one current total/used/free VRAM summary and the actual supported model/backend limit. A discovered maximum is not the active context. Missing telemetry is shown as unknown. The popover adapts to narrow windows and scrolls vertically. More diagnostics are available in monitoring.

Total/used/free VRAM is a current shared summary, not a separate measurement for each cache type. See the [v0.2.0 context screenshots](../archive/releases/v0.2.0-validation-history.md#context-screenshots-and-discovery) for an illustrative selector and popover; their values are not defaults.

Larger contexts consume more memory and may slow prompt processing. CPU/RAM offload occurs only with a supported, configured backend layout; memory exhaustion may instead fail loading. KV precision is separate from model weight quantization.

## Chat, Agent and projects

Use **Chat** for conversation and **Agent** for tools. Thinking/reasoning controls depend on model support; Agent **Fast/Deep** controls a different execution strategy. Start with moderate effort. Long reasoning alone is not proof of progress; inspect tool activity and runtime status.

Select Project 1 and optionally Project 2; use `@` for references within them. A filtered absolute path explicitly written in your own message can also establish task workspace scope (up to four explicit roots). It does not become a selected UI project or gain `@` suggestions. Only supply paths you intend to make available. Model-generated paths, repository contents and tool output are not authorization.

An explicitly continued task can restore its saved workspace even if no project is selected now. Missing or retargeted directories require an explicit valid selection; no parent directory is silently granted. File-tool scope and terminal writable mounts are not identical: the terminal's validated working directory is writable, while other host locations are generally read-only or hidden. Autopilot does not remove those restrictions.

## New tasks and continuation

1. **New task** is the composer default. Independent requests get separate plans and deliverables even in the same chat.
2. To continue work, choose a recent task near the composer or **Continue this task** on its history card. The title and project identify the next message's owner.
3. Return to **New task** to cancel that selection. Merely typing “continue” does not select ownership.
4. During execution, the active plan/deliverables appear near the input. After completion they move to a collapsible history card beside the response/attempt.

Historical verification describes the saved attempt. Continuing, Stop/resume or Regenerate produces a new attempt and cannot rewrite an earlier snapshot. Task-scoped attempts are archived when a branch is edited/regenerated; ordinary conversation editing can remove downstream chat messages. Deleting a conversation is still deletion, not an archive guarantee. Legacy conversation plans remain readable but cannot be reliably split into past logical tasks.

## Permissions

- **Ask for confirmation:** recognized reads can proceed; edits and code execution ask. Inspect the command/target and choose allow once, allow in this session, or deny.
- **Absolute Autopilot:** permitted task-scoped operations run without repeated prompts. It does not require a selected UI project merely to enable the mode, but file/terminal tools still need user-established task scope.

The selector near the composer changes the permission workflow, not the mandatory sandbox or workspace boundary.

The approval dialog shows the full proposed command and target project, with **Allow once**, **Always allow for this session** and **Deny**. Review the operation before allowing it. The [v0.2.0 permission screenshots](../archive/releases/v0.2.0-validation-history.md#permission-screenshots-and-approval-flow) illustrate these controls; the shown command is not an instruction to execute.

There is no trusted-folder management step. “Always allow in this session” means a scoped grant for the current run, not permanent trust for a directory or arbitrary future commands. Review/revoke grants in the permission controls. Restart does not restore them. Mode changes affect subsequent operations, not a completed action.

Mandatory blocks cannot be approved away. Autopilot returns an explanation rather than repeatedly prompting for forbidden actions. For an action eligible for explicit review, switch to Ask; that still cannot bypass filesystem, sandbox or protected-process restrictions.

## Plan, verify and manage servers

Ask for concrete outputs and relevant checks. **Implemented** is the agent's claim; **Verified** requires fresh runtime evidence of the appropriate kind and project. Tests in A do not prove B was unchanged. Without a trusted prior integrity baseline, that claim remains unverified. Real source changes require fresh checks; identical supported writes do not. Conservative classification of complex shell scripts may require a simpler scoped check, such as `python3 -m unittest`.

A completed plan is not itself verification. The [v0.2.0 Agent screenshot](../archive/releases/v0.2.0-validation-history.md#agent-screenshot-reasoning-and-plan) illustrates reasoning, Mermaid, plan and deliverables together; displayed counts describe one task, not release acceptance.

The agent starts long-lived development servers through managed terminal tasks and checks/stops them by their returned handles. Historical PID/port text is not a valid cleanup handle. Use managed stop rather than `kill`, `pkill`, `killall` or port-based termination. Stopping a task does not authorize stopping the model server.

## Stop, Pause and recovery

**Stop** cancels the active generation and its owned operations; completed edits remain. **Pause** is cooperative and reaches a checkpoint at a safe boundary; an in-flight operation may finish first. Continue explicitly from the saved task to create a fresh attempt after Stop, error or restart. Mid-run steering belongs to the current task and is applied at a model-turn boundary.

The timeline records suspected/confirmed loops, corrective instructions, selective context exclusions, repair attempts and success/failure. A first warning preserves context. Persistent repetition can exclude a proven repetitive segment from the next model request while keeping the full visible/persisted history. If cleanup is unsafe or repeated repair fails, the agent pauses. Recovery buttons show processing while the runtime reaches the boundary; Stop remains available. **Continue without repair** does not disable future detection.

## Attachments, web and rich responses

Attach documents or supported images; check extraction status. Image Processing CPU/GPU selects the vision path only. Scanned PDFs need OCR outside this application. **Web: Yes / No** controls read-oriented web tools, not all terminal network traffic. Review sources and treat web instructions as untrusted.

Rich responses support cards, charts, tables, Mermaid and image galleries. Expand errors/source when a diagram fails; retry rendering if appropriate. Tables support copy/CSV; charts and diagrams support SVG. Rendering support does not guarantee correct facts or that every model generates every format.

See [capabilities and security limits](FEATURES.md) and [model observations](MODELS.md).
