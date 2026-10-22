# Visual Debugging integration

Branch: feature/v0.3-visual-debugging-grounding. The untracked user runtime is excluded.

A. Extend RustAgentRuntime's existing preview pool for manual opening. Use ProjectBrowserSession and its origin/asset policies, LiveBrowserHub and the existing native WebContentsView. An explicit manual open approves only that user operation; agent operations still use ApprovalBroker. Selection runs inside the actual page because native views cover renderer DOM. Persist document geometry and candidate anchors, not screen pixels. Clear interaction overlays on ownership changes/navigation/pause.

B. Store bounded visual documents in the existing SQLite database, scoped to conversation and immutable project identity. Store immutable region snapshots separately from message text. Use #region-ID chips (the @ syntax remains Project References). Ground bounded intersections with confidence and diagnostics, redact editable controls from crops and text. Retain screenshot-only Canvas regions. Never imply that a selector proves a source component.

C. Resolve message region IDs in main, add bounded evidence to the owning turn, and reuse Project Tools, Task Memory and Verification Ledger for source discovery, component scope analysis, edits and acceptance checks. Vision uses existing BrowserVisionProvider and capability policy; text-only remains supported. Do not create a second verification ledger.

D. Bounded current-page geometry candidates, no crawling and no automatic confirmation or writes. Reuse the same regions/issues. Complex Vision-driven defect discovery is deferred.

Validation: temporary runtime/project only; Electron real native page and Chromium, persistence, geometry, security, ownership and Runtime protocol; typecheck, lint, Rust tests, build. Report actual checks and limitations rather than infer a real-model fix from a deterministic protocol test.
