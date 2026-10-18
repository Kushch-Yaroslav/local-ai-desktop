# Native browser and progress-aware QA

Branch: `feature/v0.3-native-browser-qa`, based on P2 `cfa3237`. The existing untracked `runtime/` is preserved. No release/version/installed application changes.

## Research and implementation plan

The previous display is a separate Chromium Playwright Page, CDP JPEG screencast, frame IPC, renderer decode and canvas paint. User input is synthesized back through Playwright. This cannot provide a native embedded browsing surface.

Use an Electron 39 WebContentsView with an ephemeral isolated session, no Node/preload, sandbox/contextIsolation/webSecurity enabled, and devtools/popups/downloads/permissions denied. Playwright 1.63 exposes the public `chromium.connectOverCDP(ConnectOverCDPTransport)` overload. An in-process transport adapts the view-scoped Electron debugger to one CDP page target. No browser debug TCP port, privileged application target, second browser, or URL/state mirroring is needed. Unsupported browser-wide CDP operations fail closed.

Main enforces origin/method/scheme restrictions independently of Playwright routing. Existing route fulfillment continues to validate static assets and proxy approved loopback GET requests. Native input is gated by ownership; Playwright remains the automation interface. The view's visible bounds follow the trusted renderer placeholder and are hidden for inactive conversations/panels and modal dialogs. The same Page supplies DOM, QA and selective Vision screenshots. View destruction explicitly closes webContents and detaches the transport.

QA currently has three separate run ceilings: three QA operations, eight screenshots, and four Vision requests, plus a three-review Rust completion reminder. Remove task-wide ceilings while keeping operation timeout, serialized operations, bounded interaction steps/images and payloads. A persistent session-independent QA guard fingerprints project source, normalized scenario, page state, authorization/runtime conditions and stable outcomes. It suppresses repeated no-progress checks, retains prior evidence and returns structured recovery guidance. Actual edits, meaningful scenario/state/outcome changes and explicit user continuation allow fresh checks. Rust completion reminders are tied to revision/evidence rather than lifetime run count; blocked QA must not pause unrelated task work.

Keyboard scenarios use Playwright down/up/hold/press with finally-release; fill stays limited to editable controls. Tests must exercise a native WebContentsView, actual input ownership, same target identity, origin/network denial, repeated edited revisions, unchanged cycles, screenshot/Vision compatibility, teardown, Canvas application assertions and real Qwen where the environment permits.

References: [Electron WebContentsView](https://www.electronjs.org/docs/latest/api/web-contents-view), [Electron debugger](https://www.electronjs.org/docs/latest/api/debugger), [Playwright connectOverCDP](https://playwright.dev/docs/api/class-browsertype#browser-type-connect-over-cdp). The installed public TypeScript declarations confirm the transport overload; the installed Chromium initialization requests are checked during integration.
