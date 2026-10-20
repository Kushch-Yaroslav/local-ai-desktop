# Responsive Browser QA verification — 2026-10-20

Implemented on top of the existing scenario runner, protected project resource loader, Native Page factory and verification ledger. No model files, application version, installed package or user runtime data were changed.

## Actual browser execution

- `scripts/responsive-qa.test.mjs`: real Chromium and production `ProjectBrowserSession`. Detects the 360 px document overflow, accepts an intentional scroll carousel, runs mobile-menu and modal scenarios through existing steps, and records captures tied to each viewport. The bounded search observes 320 fail, 430 pass, 375 pass, 347 fail (an observed bracket, not an inferred CSS rule). Tests independent-route freshness, the dependencies of every route in a combined report, meaningful retest after source changes, unchanged-evidence reuse and ID normalization. Stop/Pause dispose the temporary context while retaining the original page's URL, identity, input, scroll, size and ownership.
- The same script checks real Canvas captures with an explicitly controlled Vision callback. This proves image routing and functional/visual independence; **it is not model inference**.
- `scripts/responsive-native-electron.test.mjs`: actual Electron WebContentsView/CDP with a temporary hidden QA Page through the protected Native factory. Two viewports, no extra BrowserWindow, one unchanged primary Page/native ID, no extra approval or widened origin, no residual QA views, state preservation, cache and Stop/Pause cleanup. The actual report is displayed in the QA panel in RU/EN. No screenshots/runtime artifacts are committed.

The native tests caught two platform-specific defects during implementation: a hidden Page's initial viewport could be zero before emulation, and same-document hash navigation could leave an empty source-dependency map after it was cleared. The final path establishes viewport metrics before capture and reloads when navigation supplies no document response.

## Automated checks and regressions

- `npm run typecheck`, `npm run lint`, `npm run build`: passed. Build includes Rust compilation and Electron TypeScript. Existing Vite large-chunk warnings remain.
- `cargo test --locked --manifest-path rust-agent/Cargo.toml`: 394 passed, one existing ignored. Includes contextual relevance, edit-span narrowing, viewport validation, immutable contract/viewport proof binding, cached evidence not minting fresh records, inconclusive diagnostics not becoming generic passing proof, runtime/security/protection and agent-loop tests.
- After the final Inconclusive/Failed handling refinement, all 292 Rust library tests were rerun successfully; these include the viewport/evidence gate assertions. The final Chromium/Native/gate tests also passed against the rebuilt application.
- `node dist/main/web/qa-loop-guard.test.js`: passed.
- `node dist/main/tools/tool-security.test.js`: passed.
- `node dist/main/services/browser-vision.test.js`: passed with a controlled loopback provider, not real Vision inference.
- Existing `scripts/scenario-qa.test.mjs`: real Chromium regression passed (preconditions, keyboard hold, temporal motion, forms, modal, broken controls/errors, target route and authentication).
- Existing `scripts/scenario-gate-runtime.test.mjs`: scripted provider plus real Rust/Chromium/filesystem passed (scoped proof, source freshness, verify-loop prevention, fresh retest and next run).
- Existing `scripts/native-browser-assets.test.mjs`: real Native Electron external HTML/CSS/JS, file-watcher reload, animated Canvas, no global debug port, and no owned processes remaining after quit passed.

Test roots, captures and logs are temporary fixtures. Some loopback/browser tests require execution outside the restricted filesystem/network sandbox; all use controlled local origins and temporary data.

## Scope and limitations

The planning recommendation does not force responsive checks for backend tasks. Actual relevance is decided by the agent using its task context; no separate classifier LLM is called. The Rust test covers landing creation, CSS layout, JSX navigation without CSS, backend integration, Rust runtime repairs, color-only CSS and explicit mobile criteria.

DOM geometry establishes scoped bounds only. Clipping, overlap and root overflow intent can remain candidates and produce Inconclusive. Canvas appearance is not certified by DOM bounds. Viewport emulation does not test physical iOS/Android browsers, touch or virtual keyboards. The isolated Page does not copy a private authenticated user session. Dynamic dev-server responses without static source mapping do not use the responsive evidence cache; existing revision/state-aware anti-loop protection still applies.

The normal Vision endpoint (`127.0.0.1:8081`) was unavailable during verification. No large model was loaded and no real Vision/LLM inference is claimed. Existing MTP and model lifecycle code were not changed.

See the [Russian guide](ru/BROWSER_QA.md) and [English guide](en/BROWSER_QA.md) for the API, checkpoint policy, capture/viewport/probe limits and a responsive landing-page example. Run `npm run test:responsive-qa` to reproduce the targeted suite.
