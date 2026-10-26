# v0.3 — Managed preview switching and task fidelity audit

## Scope and evidence boundary

This follow-up covers a later failed agent attempt involving a local Vite preview, repeated terminal starts, a duplicate conditional section, DOM inspection failures and a repetition-loop stop. It is distinct from the earlier saved run documented in `spatial-grounding-qa-loop-audit.md`.

The earlier anonymized SQLite snapshot records zero Region references on the saved message and in Browser results. The later attempt described for this investigation had a saved Region with neighboring-section anchors. No complete raw HTTP inference request for that later attempt was available, so this report does not claim an exact wire capture or use the model's “I cannot see the selection” reasoning as proof that references were absent. The later run's reported facts and the earlier durable snapshot are kept separate.

No user project, chat history, model profile, GGUF or `runtime/` data was read or modified for the controlled acceptance. Fixtures use temporary React/Vite projects.

## Reconstructed failure sequence

1. The starting preview used port 5173. Vite reported that it was occupied and started on 5174.
2. The later run's Region context described the approximate area between the expert and reviews sections, with DOM anchors. The hints establish surrounding DOM and geometry, not a React component identity or certain insertion point.
3. The project already contained a mistaken `LoremSection` from an earlier attempt. The model treated that implementation as a pattern, planned a second section, and selected a location after the existing Lorem section and before `Explainer`. This does not match the requested gap between the expert and reviews sections.
4. It changed “the section must not exist on other product pages” into “other products should use the default font.” That is the first semantic failure in the described later attempt. It makes section existence unconditional or insufficiently route-guarded, so ID 3 can still render the section.
5. The attempt repeatedly started or probed terminal work instead of asking the managed-task registry for a ready task and reusing its actual URL. The trace reports eight tasks before the next start was refused. One observed Vite launch used Node 18.19.1, below that Vite version's requirement; this explains a failed launch, not every task start.
6. The attempted DOM checks guessed selectors and IDs, including CSS Modules classes. A zero-match response did not give a bounded list of live candidate IDs/classes or enough context to distinguish a wrong selector from a changed page.
7. The runtime stopped the run after a repeated reasoning block. The repetition guard did its job; its threshold was not raised.

## Browser QA evidence

The earlier saved trace contains seven rejected QA calls. They used `source: "style"` but omitted selectors; some also omitted a viewport, omitted `path`, or supplied `sample_ms` to a scalar assertion. Several calls targeted product 1 even when their goal described product 2 or 3. None established a font value or absence of the whole section. The saved validation result used `INVALID_QA_ARGUMENTS` and `retrySameArguments: false`.

In that earlier trace, `border-top-left-radius` was the Runtime's generic example in its error guidance; it was not the raw model assertion or a UI serialization substitution. That example was misleading for a font check. The earlier audit added property-preserving QA diagnostics; the current change keeps those validation and loop protections in place. The current Browser selector diagnostic now returns live candidate tags, IDs, CSS Modules classes, `data-testid` values and unique selector hints with current URL/HMR state.

A bounded Electron/Rust/Chromium fixture deliberately sends a malformed style assertion and confirms that validation names missing `selector`/invalid temporal sampling. It then uses real selectors and separate route criteria. This is scripted API coverage, not proof of how a real Qwen will respond to guidance.

## Changes in this follow-up

- A port switch now requires an explicit URL on `localhost` or `127.0.0.1`, a current-run managed task whose exact project root and working directory match, a Vite command, a ready startup URL with the same port, and a fresh `list`/`status` result. The target is then checked for the Vite client at `/@vite/client`.
- Autonomous same-project switching is permitted only after those checks and the existing project policy. Strict mode uses the normal exact-origin Browser approval. Unknown loopback services still require approval; arbitrary external origins, credentials, redirects and non-GET access remain blocked.
- Electron's session-level request guard advances with the authorized preview origin. Failed or cancelled navigation rolls back the internal and Native Browser origin to the existing Page. The same Page, Browser ownership, viewport, zoom, scale and pan remain in use.
- A root URL on the new port carries the current path, query and HashRouter fragment. Region references remain saved and are marked as old-origin, route-related hints that cannot verify the new origin. Browser QA runs against fresh current-origin observations.
- `run_terminal` now exposes `list`, handle-only `status`/`stop`, structured process state and bounded completed-task history. The eight-active-task limit remains unchanged. Completed tasks are reaped from active slots. No process is adopted by PID/port, and stopping is limited to the exact task handle from the current run.
- Vite readiness comes from its ready banner and explicit loopback `Local:` URL, not a listener scan. A recognized Node/Vite compatibility error is returned as `UNSUPPORTED_NODE_VERSION`; no system Node is updated.
- Structural-edit guidance now checks the requested entity, route conditions for existence, route-specific styling, placement and forbidden changes against the user's original wording. Existing code is evidence to inspect, not permission to duplicate an earlier attempt. Simple CSS edits do not require an extra planning cycle.
- Missing-selector DOM diagnostics include bounded live candidates. DOM-only visibility checks no longer wait for a screenshot; visual/pixel assertions still capture pixels. Repetition stopping and Verification Gate thresholds remain unchanged.

## Controlled acceptance

The scripted Electron fixtures use a real visible Native Page, two real temporary Vite services, React routes, Browser QA and SQLite. The port-switch fixture supplies a current-run task record to the Browser session; it does **not** launch the servers through Rust's managed-task process sandbox. It verifies:

- One Native Page switches from the first Vite origin to the second and carries query/hash route state.
- Address/status updates; viewport, zoom, scale and pan are retained.
- An unconfirmed local service requires approval. A prior-run task handle cannot authorize a switch.
- A cancelled switch after Electron's origin guard advances returns to the prior origin and route.
- Old Region evidence is retained but is not current evidence at the new origin; fresh Browser QA runs there.
- The temporary React fixture has one text section between the two neighboring sections for routes 1 and 2, Georgia/Courier New respectively, and no section, cards or added gap on routes 3 and 4.
- Stop/Continue and actual scripted compaction retain the original Russian absence condition and Region ID. The scripted provider completes formal per-route verification.
- A deliberately missing React import cannot pass fresh QA; restoring the file lets HMR remount React in the same Native Page.

These checks establish Browser/runtime contracts and fixture behavior. They do not establish that a real Qwen will interpret every approximate region correctly.

## Validation and limitations

- TypeScript, ESLint and production build passed after the final navigation rollback change. Vite still reports the repository's existing large-chunk warning.
- `scripts/project-browser.test.mjs`, `scripts/dev-preview-recovery-electron.test.mjs`, `scripts/spatial-grounding-electron.test.mjs` and `scripts/scenario-qa.test.mjs` passed with real Chromium/Electron and temporary fixtures. The spatial test uses a scripted provider, not Qwen.
- Managed-preview provenance tests passed. Relevant Rust task-readiness tests (2), preview-guidance test (1) and tracked-source-on-server-stop test (1) passed.
- The full Rust library suite ran 321 tests: 311 passed, 10 failed. The failures were process-spawn/sandbox environment failures: the installed `bwrap` helper did not meet Runtime's required root-owned, non-setuid, non-group/world-writable policy, and restricted launches returned `Operation not permitted`. Security checks were not bypassed and the helper was not changed.
- Because the managed-task Electron fixture injects a verified task record, end-to-end Rust `run_terminal` → Browser authorization with a real sandbox-launched Vite process remains unverified in this environment. Rust unit tests cover parsing and task guidance; the process isolation boundary remains active.
- No real Qwen inference was run. The original full inference wire body for the later attempt was not available. The Node compatibility handling recognizes the Vite diagnostic but does not install or select a different system Node automatically.

## Local implementation commits

- `9f74e82` — Native Browser switch to a verified managed preview port.
- `3ad14f4` — Owned terminal task lifecycle and structural task-fidelity guidance.
- `8595c11` — DOM selector diagnostics and DOM-only QA behavior.

No merge, release or `.deb` build/install was performed.
