# Native browser and progress-aware QA

Branch: `feature/v0.3-native-browser-qa`, based on P2 `cfa3237`. The existing untracked `runtime/` is preserved. No release/version/installed application changes.

## Research and implementation plan

The previous display is a separate Chromium Playwright Page, CDP JPEG screencast, frame IPC, renderer decode and canvas paint. User input is synthesized back through Playwright. This cannot provide a native embedded browsing surface.

Use an Electron 39 WebContentsView with an ephemeral isolated session, no Node/preload, sandbox/contextIsolation/webSecurity enabled, and devtools/popups/downloads/permissions denied. Playwright 1.63 exposes the public `chromium.connectOverCDP(ConnectOverCDPTransport)` overload. An in-process transport adapts the view-scoped Electron debugger to one CDP page target. No browser debug TCP port, privileged application target, second browser, or URL/state mirroring is needed. Unsupported browser-wide CDP operations fail closed.

Main enforces origin/method/scheme restrictions independently of Playwright routing. Native delivery uses isolated Electron session protocol handlers backed by the same bounded static-asset/loopback GET validator as the CLI Playwright route. It opens no extra HTTP server. Native input is gated by ownership; Playwright remains the automation interface. The view's visible bounds follow the trusted renderer placeholder and are hidden for inactive conversations/panels and modal dialogs. The same Page supplies DOM, QA and selective Vision screenshots. View destruction explicitly closes webContents and detaches the transport.

QA currently has three separate run ceilings: three QA operations, eight screenshots, and four Vision requests, plus a three-review Rust completion reminder. Remove task-wide ceilings while keeping operation timeout, serialized operations, bounded interaction steps/images and payloads. A persistent session-independent QA guard fingerprints project source, normalized scenario, page state, authorization/runtime conditions and stable outcomes. It suppresses repeated no-progress checks, retains prior evidence and returns structured recovery guidance. Actual edits, meaningful scenario/state/outcome changes and explicit user continuation allow fresh checks. Rust completion reminders are tied to revision/evidence rather than lifetime run count; blocked QA must not pause unrelated task work.

Keyboard scenarios use Playwright down/up/hold/press with finally-release; fill stays limited to editable controls. Tests must exercise a native WebContentsView, actual input ownership, same target identity, origin/network denial, repeated edited revisions, unchanged cycles, screenshot/Vision compatibility, teardown, Canvas application assertions and real Qwen where the environment permits.

References: [Electron WebContentsView](https://www.electronjs.org/docs/latest/api/web-contents-view), [Electron debugger](https://www.electronjs.org/docs/latest/api/debugger), [Playwright connectOverCDP](https://playwright.dev/docs/api/class-browsertype#browser-type-connect-over-cdp). The installed public TypeScript declarations confirm the transport overload; the installed Chromium initialization requests are checked during integration.

## Implemented lifecycle

There is one project Page, shared by Playwright, native user input, screenshots and QA. A second transparent, isolated static WebContentsView is only an input shield while agent/paused ownership is active; it never loads the project or mirrors its state. A shield is necessary because cancelling Electron `before-mouse-event` also cancels Playwright CDP mouse actions. Keyboard gating does not require that workaround. Held user keys/buttons are released on handover/hide; ownership changes do not change permissions. A background page cannot steal focus from a different visible page.

Completion and idle Stop retain the page for the user. Pause retains the page under a shield. A new approved operation returns ownership to the agent. Closing destroys both native webContents, waits for actual destruction, clears the ephemeral session, and closes connections. Loss of the CDP connection immediately denies all network, reports Error and tears down the page. The production path opens no remote debugging endpoint; Electron E2E's inspector is test infrastructure only.

Native children are hidden for renderer dialogs/popovers/tooltips that overlap their bounds. This avoids native surfaces covering HTML dialogs; it does not destroy the Page. Viewport follows the actual view bounds rather than scaling a fixed screencast. The public web-search browser remains a separate read-only tool and is not this project preview.

## QA progress and bounded resources

There is no per-task QA or Vision-count allowance. Explicit model screenshot calls retain their independent eight-per-run cap. Each QA operation still has bounded steps (8), hold duration (2 seconds), repeat count (8), images, dimensions and a 90-second operation timeout. Vision is serialized, spaced at least 1.5 seconds, and has a 60-second request timeout. Network accounting is per operation/time window rather than a lifetime browser quota.

The source revision scan is symlink-free and bounded to 50,000 entries, 32 MiB total and 4 MiB per file. Unsupported oversized scans fail honestly rather than hashing an incomplete snapshot. Runtime metadata and QA's own captures/evidence are excluded. Known pre/post-QA page states retain identity across reload/reopen. Repeated outcomes are tracked across alternating visual assessments, not just consecutive identical text. Two observations of the same outcome in the same unchanged scenario cause a subsequent no-progress call to return local `QA_NO_PROGRESS`, evidence references and recovery guidance. This is an observation-window rule, not a task allowance: edits, changed expectations/state/runtime/permissions or explicit accepted user steering permit fresh checks. The generic Rust failed-call cache does not prevent those checks.

QA rejection emits a single local corrective notice, not a global agent pause. It cannot force an uncooperative model to finish; cancellation/Stop remains available. Vision findings remain probabilistic and can disagree between identical frames; functional assertions and image-analysis evidence are recorded separately.


## External script delivery regression found during completion

Real Electron regressed on `<script src>` when this Page's responses were fulfilled through CDP Fetch. External CSS and inline JS worked; external classic JS crashed the renderer. This also reproduced in an ordinary Electron process without the E2E inspector, with both software and hardware rendering. Enabling cache and disabling V8 code cache did not resolve it and those experiments were reverted. This is a demonstrated integration boundary, not a claim about a symbolized Chromium C++ root cause.

Native pages now delegate HTTP(S) resource delivery to `isolated.protocol.handle`. The callback calls the existing project validator/reader or pinned loopback GET proxy. The Main request/origin/method guard is independent and remains active. Both protocol schemes are denied outside the approved origin; no unfiltered `net.fetch` or filesystem URL is provided. Stronger upstream CSP, body/request budgets, no redirects in the Node proxy, cancellation and file/symlink checks are preserved. Non-body response statuses (204/205/304) are handled explicitly. Protocol callbacks are removed during close, after network is denied and requests aborted. The headless CLI browser keeps CDP routing with the same shared validation. Playwright still owns the same native Page and is used for DOM, input, screenshots and QA.

The new no-inspector asset test validates real external JS/CSS, native Canvas animation and automatic HTML/CSS/JS reload. The original full Electron UI reload test also passes after this fix. Browser-wide debugging remains absent from production.

Accepted permission changes advance the QA authorization identity; resending an unchanged permission set does not. Explicit user recovery actions/steering open a new observation window. Reasoning configuration enters the QA runtime identity only on the actual `reasoning_applied` event, not when an update merely becomes pending. These transitions do not relax a denied browser approval.
