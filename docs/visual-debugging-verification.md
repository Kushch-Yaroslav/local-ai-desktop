# Visual Debugging v0.3 foundation

Historical foundation report. Current UX/lifecycle changes and real Qwen evidence: [Visual Debugging usability verification](visual-debugging-usability-verification.md).

Implementation branch: `feature/v0.3-visual-debugging-grounding`.
Integration plan: [visual-debugging-plan.md](implementation/visual-debugging-plan.md).

## Delivered behavior

**A — Browser + Selection:** implemented. The chat's **Open browser · Visual Debugging** button and the compact Browser & QA settings entry open the registered primary project's existing preview. The existing `RustAgentRuntime.previews` pool, `ProjectBrowserSession`, `LiveBrowserHub`, CDP transport and native Electron `WebContentsView` are reused. Reopening reuses the Page. A project-relative path or explicit loopback preview URL can be entered next to the address. An explicit origin change closes the old session before opening the new authorized local preview. External URLs remain forbidden. Manual opening gives user ownership and creates no Agent Security grant. Agent Browser Tools retain their own approvals; after the run, ownership returns to the user. A paused preview can be returned using Take control after the active run has ended.

Selection is rendered in a closed shadow root inside the native page, because application renderer HTML cannot overlay a native child view. Drag to create rectangles; wheel scrolls; Escape cancels a drag or exits. Multiple numbered regions have textual IDs and group colors. Group selected regions into an existing group, or give a subset another group ID to split it. Delete and exit are supported. Overlays are removed on agent operations, pause, close, application renderer navigation and chat switches. Browser dimensions follow the existing native layout mechanism.

**B — Grounding + Chat:** implemented. `visual_documents` in the existing SQLite database stores bounded chat/project-local regions and issue groups. Message `region_references` stores immutable snapshots separately from message text. No new long-term memory, Legacy Project Knowledge or `.ai-framework` is introduced. Regions retain project identity/root, URL/route, timestamp, CSS document rectangle, viewport, DPR, scroll, navigation snapshot identity and up to four intersecting DOM candidates. Candidates include selectors, classes, direct text, styles, confidence and ambiguity diagnostics. Served asset revisions provide source search hints, not proof of component identity. Canvas/SVG supports screenshot-only evidence.

Reprojection uses a unique DOM anchor and relative offsets/scales where available. Screenshot-only selections are not projected onto a changed viewport as if they were still reliable. Native crop capture converts CSS coordinates to DIP, including WebContents zoom, and waits for privacy masks to paint. Inputs, textareas, selects, editable and explicitly private/sensitive elements are masked. No form values, cookies or storage are inspected by grounding. Crops are local files, never textarea JSON/base64. URL query/hash data is omitted from model grounding context.

Select regions and choose **To chat → agent**, then add the instruction and send. Chips use `#region-<id>`; typed region IDs are also resolved at submission. The existing `@` Project References syntax is preserved. Main resolves IDs from SQLite and checks the current project/chat; renderer-supplied evidence and image paths are discarded. Clicking a history chip shows the browser and attempts to reveal its current anchor/route. Changing a project never retargets old references to a different project.

**C — Agent Fix Loop:** implemented through existing Runtime V2 tools. Scoped grounding context is placed next to its owning turn. The agent is instructed to search selector/class/text with existing Project Tools, read and confirm the source, check shared CSS/components and a reasonable set of sibling instances, fix the cause and register scoped acceptance criteria. There is no automatic claim that DOM proves a source component. Group IDs bind to task-local deliverable IDs. The issue registry reads the existing Task Memory/Verification Ledger: current passing, unqualified criterion evidence and the gate's verified deliverable state can display Verified. Suspicions and a manually set Fixed status do not produce verification. Evidence IDs are linked, not copied into a new ledger.

Visual Selection, Grounding and deterministic QA work with Vision Off or text-only models. Existing image capability/policy checks govern crop hydration into the owning user turn. Auto/On can attach actual crops when the active backend supports Vision. Image bytes are not stored in SQLite or inserted into the system text. There is no hidden second model and no independent external image service.

**D — Initial Auto:** bounded DOM mode implemented. One explicit current-page check invokes the existing `inspectResponsive` diagnostic; up to 12 visible candidates become normal regions/issues. Suspects with the same finding kind/tag/classes are grouped as possible shared-component issues. These are Detected, not Confirmed. There is no crawler, automatic write, unlimited screenshot loop or Vision-driven aesthetic audit. The same Manual reference/fix/verification path handles confirmed scope.

## Validation

All runtime/project paths used by the new tests are temporary. The fix-loop project is outside the protected temporary runtime. An initial attempt inside runtime was correctly rejected by runtime protection. No user runtime, user project, NEXUS, real GGUF, package installation, release or main merge was used.

Passed:

- `npm run typecheck`, `npm run lint`, `npm run build` (the existing Vite large-chunk advisory remains).
- `cargo test --locked --manifest-path rust-agent/Cargo.toml`: 408 passed, one ignored. The sandbox-restricted first run hit network/process PermissionDenied; the unrestricted rerun passed.
- `node scripts/visual-debugging-pipeline.test.mjs`: persistent references, scoped context, actual crop hydration, Vision policy matrix, foreign-chat mutation rejection, fresh Ledger projection and rejection of stale/caveated evidence.
- `node scripts/visual-debugging-electron.test.mjs`: actual Native Electron/Chromium and Rust Runtime V2. Manual open, same Page on repeat, single/multiple selection, grouping/splitting/deletion, correct button anchors, Canvas, scroll, viewport resize, zoom/DPR 1.25, password-mask PNG pixel check, local crops, UI draft chips, separate SQLite message references, renderer restart/history, external-origin and foreign-chat rejection, forged metadata/path rejection, bounded Auto and zero image payloads with Vision Off. The local scripted SSE provider drives real source read, common CSS `replace_text`, Browser QA retest, Verification Gate, issue Ledger link and return of the same Page to user ownership.
- Existing `scripts/browser-session-native-electron.test.mjs`: actual Electron/Rust session reuse, approvals, transport recovery, close, Pause/Resume, Stop/continuation, project and origin restrictions.
- Existing `scripts/responsive-native-electron.test.mjs`: isolated viewports, active Page preservation, QA cache, Stop/Pause cleanup and QA panel.
- Existing attachment pipeline regression (isolated temporary runtime), browser Vision capability test, QA loop guard test and `scripts/vision-browser-policy.test.mjs` (actual Chromium capture and local fixture Vision HTTP).

The scripted provider verifies the real execution path; it is not evidence that a real LLM independently diagnosed the defect. No real model or real multimodal inference was run. Native startup and local fixture servers require running outside this tool sandbox.

## Remaining limits

- Resize/move handles on existing selections are deferred; delete and redraw instead.
- DOM candidates are bounded and fallible. There is no framework/source-map component resolver; source locations must be confirmed with Project Tools. Dynamic/ambiguous anchors and changed screenshot-only layouts need reselection.
- The snapshot identifier is navigation identity plus element count, not a full DOM mutation version or DOM dump.
- History references survive renderer and application persistence, but reopening requires the same currently registered project and a valid preview. Deleted live regions cannot be revealed from a removed registry entry; their immutable message evidence remains retained.
- The first version handles the primary project browser. It does not automatically inspect all routes, infer every visual defect or automatically approve a fix scope. Auto Vision discovery and full autonomous audits are deferred.
- Verification projection is conservative about the current run/epoch; no new independent proof policy replaces the Rust gate.
