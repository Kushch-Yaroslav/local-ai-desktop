# Browser session reliability — verification, 2026-10-21

Implementation commit: `e1aa53e`. Base: `b5ba36f`, branch `fix/v0.3-browser-session-reliability`. User `runtime/` was already untracked at entry and is excluded from the changes. NEXUS/GGUF/installed package were not changed. All browser/inference-provider fixtures use temporary runtimes.

## Confirmed causes and changes

These are independently reproduced code paths. The original user's full historical run log was not available; the observed error strings are not treated as proof that every failure had one cause.

| Area | Previous behaviour | Correction |
|---|---|---|
| Session approval | Broker stored grants by Agent Run ID and `endRun` revoked them. “Session” actually meant one run. | Memory-only chat/window grants survive runs and Pause/Resume. Pending decisions remain run/sender bound and are cancelled at run end. |
| Scope | Preview approval used generic `system_command`; project/mode revocation callers passed conversation IDs to a run-keyed map. | Dedicated `browser_preview` capability plus project ID, root, exact origin and security context. Revocation/listing uses chat identity; listing is filtered by owning window. |
| Allow once | An approved browser operation set an authorization flag for the rest of the run. | Each public call consumes its own once approval, including queued concurrent calls. Previously approved Page lifetime is separate, so refusing another operation does not destroy the user's preview at finish. |
| Autopilot | Browser host always requested confirmation independently of the active security mode. | Only a validated dispatch to the selected registered project can auto-approve its bounded local preview. Current mode reaches the host immediately on control changes; automatic approval is logged. Generic command policy is unchanged. |
| Origin | Every `open(path)` constructed `project-preview.invalid`, even when a reused Page was approved for localhost. | Project-relative navigation keeps the approved origin. Explicit different origins are refused without poisoning the Page. Recovery reconstructs localhost arguments before creating the replacement Page. |
| Closed runtime | The dispatcher checked only whether its local browser object existed, not whether Page/CDP remained usable. A closed object retained its lifetime abort/origin lock. | Actual Page/browser state is checked; explicit `open` can recreate technical loss once per run through the existing factory. No permanent abort controller is reset/reused. |
| Closure reason | Hub cleanup classified technical Page/CDP closure as user-close. | Close reasons propagate between Hub and session. User-close, operation cancellation, transport loss, Page loss, crash and policy closure are distinct from ordinary completed-run handover. |
| Ownership/callbacks | Previous observer callbacks could still target a reused entry. Reusing an ended observer for a replacement Page failed creation. | Generation fencing for old callbacks; a fresh observer for replacement resources. Normal next-run reuse retains the same Native Page and installs fresh run/QA options. |
| Settings | Merely including the unchanged working-directory field in an active conversation patch closed preview. | Compare actual roots/web-mode values. Actual project/mode changes revoke grants; no-op saves do not. |
| Auto-reload | Failed approved navigation could close the whole browser; a failed finish refresh also caused runtime cleanup to close it. | One bounded navigation restoration per operation/edit, no reload of an invalid error origin, and nonfatal finish refresh errors. Page/transport closure stops watchers. Server failure can be followed by explicit reopening after recovery. |
| Duplicate failure | A previously failed read could remain rejected even after a real browser state change. | A trusted host `recovered` result from successful `open` releases browser failures only for that project slot. Other tool/project/denial failures and the QA guard remain intact. |

Grants are not written to SQLite. Window/application closure discards them. Exact commands remain exact command/root grants; a preview grant never grants shell execution. Scope/mode changes and explicit revocation cancel pending approvals as well.

## Real Electron/Chromium tests

`npm run test:browser-session` builds/types checks, lints and executes the broker tests plus:

- `scripts/browser-session-reliability.test.mjs`: production Chromium session/loader/Broker/Hub; QA and screenshot across runs; old run signal aborted after finish; session reuse and once per queued operation; Pause/Resume ownership; live source refresh; invalid origin refused while preserving Page through finish; explicit user-close.
- The same script checks real loopback preview, project-relative URL reuse, autopilot without a confirmation callback, external-origin rejection, separately checked project and actual server shutdown/restart without permanently closing the Page.
- `scripts/browser-session-native-electron.test.mjs`: real Electron WebContentsView/CDP, real Rust Runtime and production ApprovalBroker with a **scripted HTTP provider**. Run A opens/QA/captures, finishes to user ownership; Run B reuses the same Native ID with no extra session prompt. A forced transport loss makes an identical failed read block, then successful bounded Page recreation permits that same read. Further cases cover real Pause/Resume, Stop/continuation, a user-closed Page followed by a newly authorized run, unselected project rejection before host approval, scoped autopilot and localhost origin preservation through replacement.

The Native fixture's file-command channel injects controls and explicit scripted approval decisions. It does not simulate browser observations or produce fake screenshots. A preliminary test-driver failure tried to detach an already destroyed cached target; the fixture now tracks the active target and fails control errors explicitly. This was not reported as a successful application recovery.

## Regressions and quality

- Full Rust: **397 passed, 1 existing ignored** (295 library, 94 integration, 3 runtime protection, 5 tool security).
- TypeScript, ESLint and full `npm run build`: PASS. Existing Vite large-chunk advisory remains.
- `scripts/agent-approval-electron.test.mjs --permissions-only`: real Electron/preload/renderer/Broker/Rust; Ask/Autopilot, pending-mode controls, scoped reuse, allow/deny/cancel/revocation and theme/keyboard controls: PASS. The former run-expiry assertion now tests the required chat-session persistence.
- Existing real Chromium Scenario QA (keyboard/Canvas/preconditions/auth), ownership/input isolation and auto-reload suites: PASS, including burst save debounce, CSS/JS/HTML refresh, symlinks, hidden/chat-switch state, finish/Stop cleanup and HMR handling.
- Existing Native asset refresh (no surviving owned processes), Responsive and Visual Layout suites: PASS, including per-operation approval without per-viewport prompts, independent 1440px rendering, DPR 1/2, preserved visible page, Stop/Pause and RU/EN panel.
- Visual Layout Chromium, QA anti-loop and tool-security regressions: PASS. No Visual Layout algorithm was changed.

Logs/results/captures live under `/tmp/lad-session-*`; no screenshots/runtime data are committed. Committed scripts regenerate the fixtures. RU/EN user and Browser QA guides describe the new lifetime and recovery rules.

## Limits and security

The local `127.0.0.1:8081/v1/models` endpoint refused connection; no running llama-server was found. No real Qwen or Vision inference was performed or claimed, and no user backend was loaded/stopped.

Recovery is explicit and bounded, not a silent restart loop. It preserves approved origin, cannot override Stop, and does not reopen a user-closed Page within the same run. A new user task may create a new authorized session. Changing origin deliberately requires closing the preview and opening a new session; project-relative paths alone are not an origin-switch instruction.

Project scope, exact origin, GET-only, pinned loopback IP/no DNS, no inherited proxy/cookies/auth, external network/WebSocket/popup restrictions, symlink/file bounds and resource limits remain. Autopilot does not start a server or approve a forbidden command through browser permission. A loopback URL still refers to a user-supplied local service; the browser does not attest that service's code or replace server authorization.
