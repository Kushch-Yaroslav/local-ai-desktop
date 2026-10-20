# Visual Layout QA verification — 2026-10-20

Implementation starts from `7e7d640` (Responsive Browser QA), on `feature/v0.3-visual-layout-qa`.

## Implementation and scope

The existing `web_project` scenario runner now accepts `assertion.source=visual_layout` with coverage, backing or seams measurements. It uses the existing isolated ProjectBrowserSession and private captures/reports, source hashes, immutable criterion bindings and anti-loop guard. No second browser runtime, arbitrary JavaScript tool, new dependency or model download was introduced.

Coverage is an explicit fullscreen-target bounds requirement, not proof of painted contents. Backing dimensions are compared with CSS × DPR; a mismatch can be intentional and remains Suspected. Extended high-contrast pixel boundaries must persist in two samples; intentional separators never automatically fail. Coarse RGB signatures and boundary regions support historical comparison without pixel-perfect animation verdicts. Two samples also detect changing target bounds/backing rather than claiming a settled resize.

Matched baselines require route, viewport/DPR, transition sequence, assertion, preconditions/actions, state key, scroll, image dimensions and bounded form/dialog/details-state hash. Historical baseline observations cannot be minted as fresh evidence. A baseline must remain available in the session's existing capture directory; a missing/evicted baseline blocks comparison. Hidden application/game state and full browser-session equivalence are not inferred.

The Verification Gate accepts a deterministic visual measurement only for the registered coverage/backing property, selector, viewport sequence and DPR, with two referenced captures per size. A generic Vision response or seam diagnostic cannot certify it. Freshness still depends on current loaded source revisions. Qualified Vision is independent of measured results. The UI marks stale reports as historical rather than presenting their scenario results as current verification.

## Real browser checks

`node scripts/visual-layout-qa.test.mjs` uses actual Chromium, production ProjectBrowserSession/security loader, private temporary fixtures and PNG captures. It covers:

- Fullscreen Canvas with a 100 CSS-pixel bottom band despite zero Responsive DOM findings; correct fullscreen counterpart.
- Extended horizontal seam and intentionally separated background: Suspected, never automatic Failed.
- Animated particles without false persistent-seam failure.
- Before/after resolved coverage band; new seam after a fix; mismatched viewport and observed UI state block comparison.
- Six-frame resize series, width/height changes, actual DPR 1/2 and backing sizes; stale resize/backing candidates.
- Unchanged evidence reuse, changed source fingerprints, bounded scenario validation and rejected baseline traversal.
- Stop/Pause cleanup and preserved primary page identity, route, viewport, input and context count.
- Scrolled capture: actual blue-region pixels rather than red document-top pixels, with recorded scroll coordinates.

`node scripts/visual-layout-native-electron.test.mjs` uses an actual Electron WebContentsView/CDP and production renderer:

- Owning window content width 760 px; isolated QA still renders a real 1440 px CSS viewport, not an enlarged small view; right-edge pixel signatures beyond the owner view match the rendered Canvas colour.
- DPR 1/2, bounded 1280 px screenshot output, real backing dimensions and an 80 px band through height resize.
- Primary Native identity/navigation/input/size retained; temporary views removed after Stop/Pause; no security relaxation.
- Existing QA panel reports visual findings and DPR in EN/RU. No new settings screen.

Existing real-browser regressions: `scripts/native-browser-assets.test.mjs` (including zero surviving owned processes), `scripts/responsive-qa.test.mjs`, `scripts/responsive-native-electron.test.mjs`, `scripts/scenario-qa.test.mjs`. `scripts/scenario-gate-runtime.test.mjs` uses real Rust/Chromium/source files with a **scripted provider**, covering scoped proof, source freshness, repeated verify rejection, retest and next run.

## Vision evidence

The new Chromium script supplies a clearly labelled fixture analysis callback to check targeted routing, selection of the suspect viewport frame and separation from deterministic failure. Existing `browser-vision.test.js` checks provider capability handling with a local HTTP fixture. These are **not real multimodal inference**.

The existing endpoint `http://127.0.0.1:8081/v1/models` refused connection; process inspection found no running llama-server. No model was started and no user backend interrupted. Consequently a real Vision-model assessment remains untested. The production BrowserVisionProvider is reused unchanged, with targeted region/requirement/DOM context and a matched historical image where available; capture IDs record which images were submitted.

## Quality checks

- TypeScript (`npm run typecheck`, also part of build): PASS.
- ESLint (`npm run lint`): PASS.
- Full `npm run build`: PASS; existing Vite large-chunk advisory remains.
- Full Rust tests: 396 passed (294 library, 94 integration, 3 runtime protection, 5 security), one existing ignored integration test. After tightening visual property/viewport/capture validation, both affected `visual_layout` tests passed again.
- QA loop guard, tool security and Browser Vision provider regressions: PASS.

Initial browser/process tests inside the restricted execution sandbox could not create browser/process-isolation resources. The permitted real-browser/Rust runs outside that restriction passed; sandbox startup failure is not reported as an application failure.

Temporary logs, captures, reports and fixture runtimes live under `/tmp/lad-visual-*`; they are not committed. Fixtures are generated by committed scripts. User `runtime/`, NEXUS, GGUFs, installed package and app version were not changed. No merge or release was performed.

## Remaining limits

Pixel thresholds are heuristic and detect candidates, not intent/aesthetic quality. Thin, diagonal, low-contrast seams, canvas-internal semantic defects, delayed transitions beyond the bounded sample interval and hidden application state need targeted scenarios/manual review or real Vision. Coverage can pass while an independent seam remains suspected. Baselines do not guarantee deterministic animation state. Desktop Chromium emulation does not certify physical mobile browsers.
