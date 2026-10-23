# Scenario-aware Browser QA and responsive layouts

[Русский](../ru/BROWSER_QA.md) · [User guide](USER_GUIDE.md)

Browser QA extends the existing Native Browser / Playwright / CDP and Verification Gate. The agent selects checks against the task and acceptance criteria. A completed plan records actions; Verified records proof of a specific requirement.

## Choosing relevant checks

Explainable planning advice combines the user request, acceptance criteria, active plan, changed UI paths, actual edit spans and previous viewport findings. No extra classifier model is called. Explicit mobile requirements need corresponding scenarios. A landing page, layout edits, JSX navigation, forms or modals generally warrant a responsive checkpoint.

Backend APIs, migrations, Rust runtime repairs, server refactoring and type-only changes generally do not. A CSS extension alone is insufficient: changing a color variable does not require five viewports. JSX can break layout without a CSS edit. The agent evaluates the advice in context; it is not a universal completion gate. Group related UI edits before checking. Skipping irrelevant QA adds no unfinished plan, and there is no permanent “always test mobile” setting.

## Viewports and isolation

| Profile | Size |
| --- | --- |
| `small-mobile` | 320 × 640 |
| `mobile` | 390 × 844 |
| `large-mobile` | 430 × 932 |
| `tablet` | 768 × 1024 |
| `desktop` | 1440 × 900 |

Diagnostic checkpoints default to mobile + desktop. Choose 1–5 relevant sizes or custom `{width,height}`: width 280–1920, height 320–1600. The full set is optional.

Responsive checks use a temporary isolated Page in the existing Chromium. Electron uses a hidden Native Page through the same protected factory, without another Electron window; CLI uses a temporary context of the same browser. The visible page retains its URL, dimensions, forms, scroll and ownership. Temporary resources close in `finally`, including Stop/Pause. User input is not redirected to the QA page.

Checks start with clean state. User cookies/storage and unsent forms are not copied. Declare necessary state using preconditions and safe steps. HTTP 401/403 produces Auth Required; authentication is not bypassed. Origin, GET-only, popup, WebSocket, file and permission restrictions remain active. Real payments, messages and irreversible actions are outside automatic checks.

## Deterministic inspection

- Document/viewport widths are correlated with visible element geometry. An intentional carousel inside its own scroll container is not a document overflow failure.
- Important interactive regions are checked for horizontal accessibility. Hidden responsive variants and intentionally contained scroll/clipping are excluded.
- Hit-test occlusion, text clipping without ellipsis, oversized images and offscreen dialogs produce candidates. Intersecting rectangles alone do not establish defects.
- Established geometry violations produce Failed. Ambiguous candidates or exhausted inspection bounds produce Inconclusive / Not Verified.

Inspection is bounded to 2000 elements, 60 interactive hit tests and 40 findings. Findings are retained in scenario evidence. `layout equals 0` establishes only the absence of detected DOM boundary violations at that route and viewport. It does not establish Canvas/WebGL visual correctness or the quality of every page.

## Vision and interactions

`responsive.vision=auto` uses the existing Browser Vision for Canvas or ambiguous DOM candidates. `off` retains DOM QA; `on` requests visual analysis of selected viewports. Missing multimodal support leaves functional checks available. The screenshot and DOM candidates are correlated; Vision remains probabilistic and cannot automatically promote a candidate to a confirmed application bug.

Mobile menus, dropdowns, tabs, modals and safe forms use existing `steps` and concrete assertions. There is no separate click/type engine. Captures are limited to 2 MiB and downscaled when needed to 1280 × 900, preserving original viewport metadata; at most 8 captures and 12 MiB per QA operation.

## Acceptance criteria and evidence

The chain is deliverable → immutable acceptance criterion → scenario with viewport/route → observations/evidence → result. Each required size and route needs its own criterion. `scenario_refs` executes the original specification. Desktop evidence, a successful browser open or generic load cannot certify mobile behaviour.

For a responsive landing page:

1. Implement related sections/navigation to a meaningful checkpoint.
2. Register `mobile-bounds` (kind `runtime`) using the specification below, and separate `desktop-bounds` with viewport `desktop`.

```json
{
  "target": "/index.html",
  "viewport": "mobile",
  "preconditions": [],
  "required_state": [],
  "steps": [],
  "assertion": {"source": "layout", "operator": "equals", "expected": 0},
  "timeout_ms": 6000
}
```

3. Register a separate menu criterion (kind `interaction`): require its button to be visible, click it using the app's actual selector, assert menu visibility.
4. Execute `web_project` action `qa` with `scenario_refs`, repair established defects, and rerun affected scenarios.

For preliminary diagnostics without certifying arbitrary deliverables:

```json
{"action":"qa","path":"index.html","responsive":{"reason":"Responsive landing checkpoint is ready","viewports":["mobile","desktop"],"vision":"auto"}}
```

Global `viewports` cannot override bound scenarios: each criterion owns its viewport. The existing QA panel shows dimensions, checked count, findings, functional results and separate Vision state. Details retain observations and technical IDs; RU/EN and Compact/Expanded remain supported.

## Breakpoints, freshness and limits

Investigate an established problem with diagnostic `responsive.breakpoint={minWidth:320,maxWidth:430,attempts:4}`. Endpoints are tested first, followed by the midpoint of a neighbouring pass/fail pair. Total attempts are 2–5; search stops at a ≤16 px bracket, no contrast or inconclusive results. This reports observed reproduction bounds, not an inferred CSS breakpoint. Probes never alter or certify acceptance criteria.

Scenarios retain revisions of loaded source dependencies. An unchanged responsive checkpoint reuses evidence without minting a new verification record. Editing an independent static route does not invalidate another route's check; changing a loaded dependency requires a new check. Dev servers without source mapping do not use the responsive cache and use a conservative project revision. External runtime changes invisible to the browser/scenario are not guaranteed cache invalidators: declare state preconditions and appropriate scenarios.

Existing QA anti-loop protection remains active. Renaming scenarios, changing prose or reopening the browser is not progress. Per-operation limits remain: 6 scenarios, 5 viewports, 8 steps per scenario, 500–15000 ms scenario timeout, 30 s runner deadline and 90 s outer envelope. These are not lifetime limits on useful checks.

Desktop Chromium viewport emulation does not certify iOS Safari, Android Chrome, touch, virtual keyboards or physical mobile GPUs. Isolated QA does not reproduce a private user session. Verification applies only to the observed assertions, route, dimensions and source revisions.

## Visual Layout QA: coverage, seams and resize evidence

Visual Layout QA extends the same scenario runner, isolated QA Page, capture files, source-revision ledger and Verification Gate. It does not replace functional tests or create another browser runtime. A zero-overflow DOM result cannot establish that a fullscreen Canvas/background looks continuous.

At a meaningful checkpoint, consider it when the request, acceptance criteria, active work and actual edits concern fullscreen scenes, Canvas/WebGL, background continuity, clipped content, container heights or a reported visual defect. Existing viewport/visual findings are another reason to investigate. Backend/API/database/Rust-only changes do not require it. The existing contextual QA advice explains its recommendation; the agent decides without a separate classifier LLM. Do not run after every edit.

Supported assertion source `visual_layout` uses `equals`, `expected:0` and one property:

- `path:coverage`, with `selector`: measure whether an **explicitly required fullscreen target's bounds** cover the CSS viewport (2 px tolerance). Uncovered bands are Failed for this contract. This does not prove that every pixel inside the target was painted correctly.
- `path:backing`, with a Canvas selector: compare backing dimensions against CSS dimensions × actual DPR. A mismatch is Suspected because intentional low-resolution rendering is possible; equality verifies only this measured relationship.
- `path:seams`: find persistent extended horizontal/vertical high-contrast boundaries in two captured frames. Candidates are Suspected, including intentional section separators. No candidates is also inconclusive for a broad continuity/aesthetic claim, never absolute proof that the design is correct.

Pixel analysis uses bounded RGB/RGBA PNG decoding, sampled colour differences on both sides of a boundary (≥24/255 average contrast over ≥80% sampled cross-section), two-frame persistence, coarse 8×8 RGB background signatures and correlation with target bounds. Reports retain CSS coordinates, contrast, extent, confidence, capture IDs, actual image dimensions, DPR, scroll, source hashes and per-size DOM inspection. Confidence is heuristic, not a model probability. DOM measurements, pixel suspicions, functional checks and Vision opinions stay separate. A styled header, gradient stop or decorative geometry is not automatically an application failure.

Example: investigate an illustrative fullscreen Canvas with an 80 px bottom band and a horizontal dark/purple transition. Do not edit the project just to make it testable:

```json
{
  "action":"qa",
  "scenarios":[{
    "id":"scene-coverage",
    "goal":"The fullscreen scene covers the viewport; inspect the bottom band and background transition",
    "target":"/index.html#scene",
    "viewport":"desktop",
    "preconditions":[], "required_state":[], "steps":[],
    "assertion":{"source":"visual_layout","path":"coverage","selector":"canvas","operator":"equals","expected":0},
    "visual_layout":{"dpr":1,"resize":[{"width":1440,"height":700},{"width":390,"height":844}],"vision":"auto","state_key":"scene-ready"},
    "timeout_ms":14000
  }]
}
```

Use real preconditions/actions to establish the relevant application state. Register a `kind:visual` acceptance criterion with the same immutable scenario and use `scenario_refs` to obtain criterion-bound evidence; unbound diagnostics do not certify unrelated deliverables. Register separate criteria for different routes/viewports and functional behaviour. Only measured coverage/backing assertions can yield deterministic passing visual evidence; seam findings and general Vision descriptions remain qualified. A desktop capture cannot verify mobile layout or animation behaviour.

### Before/after and animations

First run the scenario diagnostically before the fix and retain its report ID and scenario ID. After a relevant edit, repeat it with `visual_layout.baseline:{report_id:"<saved UUID>",scenario_id:"scene-coverage"}`. If required for an acceptance check, register that exact baseline reference in its immutable criterion before executing it. Baselines are read only from the existing private capture directory, checked for bounded size/project identity and never treated as fresh passing evidence.

Comparison requires identical route, initial viewport, DPR, transition sequence, assertion, preconditions/actions, declared `state_key`, captured scroll/image dimensions and a hash of bounded form/dialog/details state. It reports resolved, persisting and new candidate regions plus coarse background shift. A mismatch/missing baseline blocks the comparison. Changing `state_key` cannot manufacture a match or renew source freshness. State not exposed in DOM/preconditions (for example a private game camera) cannot be guaranteed identical; declare stable state explicitly. A restored browser session is not inferred.

Two frames per size (180 ms apart after a 180 ms settling interval) distinguish persistent boundaries from moving particles; no animation code is injected or user project modified. Coarse differences are observations, not pixel-perfect regression verdicts. New seams can remain Suspected even when the specific coverage fix passes. Long/cyclic animations and subtle thin/diagonal defects may be missed.

### Targeted Vision, isolation and limits

With an already available compatible Vision backend, `vision:auto` requests one analysis when candidates exist; `on` forces the targeted inspection, `off` retains DOM/pixel diagnostics. The existing real provider receives the captured image, matched baseline image if present, route, CSS viewport, actual image resolution, DPR, suspect regions, bounds/backing/background context and scenario requirement, including a specific bottom-20%/boundary question. Images are not artificially enlarged. An unavailable backend leaves deterministic results usable. Fixture Vision responses in tests prove routing only, not model accuracy. Vision cannot erase a measured coverage failure or certify a broad criterion by saying “looks good”.

There is one visual scenario per checkpoint, at most two resize transitions and six analysis frames; existing 8-capture/12 MiB returned-image budget, ≤2 MiB/image and ≤1280×900 image bounds apply. Rendering still uses the requested independent CSS viewport (named profiles or 280–1920 × 320–1600 custom sizes); capture may downsample it. DPR 1/2 is emulated, with CSS pixels distinguished from backing and image pixels. Fixed commands address only the owned Native target; browser-wide CDP remains forbidden. Stop/Pause/error closes the temporary QA Page/context and input state without resizing/navigating the visible user page. Source freshness and unchanged-check reuse/anti-loop continue to apply. This is desktop Chromium emulation, not physical-device testing or a general aesthetic judge.

The existing RU/EN QA panel shows Visual Layout QA, route/viewport, suspected/failed observations, frame regions, before/after counts, separate Vision state and blocked reasons. Technical details retain complete measurements/captures and evidence IDs. Run focused real-browser regressions with `npm run test:visual-layout-qa`.

## Preview permission lifetime and consecutive chat runs

**Allow once** permits the current browser-tool call and its bounded page requests. A subsequent separate operation asks again unless a session grant exists. Internal isolated Responsive/Visual QA pages reuse the approved origin without per-viewport dialogs.

**Always allow for this session** covers this chat in this Electron window across Agent Runs, Pause/Resume and user ownership. Grants bind `browser_preview`, registered project/root, exact origin, security context and chat/window. Command grants still bind an exact command/root: preview permission never authorizes shell execution. Explicit revocation, actual scope/mode changes and application/window closure invalidate grants. View/revoke them in Agent Security even between runs. Saving an unchanged directory or mode neither revokes permissions nor closes the browser.

**Absolute Autopilot** automatically permits read-only preview of the currently registered project: the virtual `project-preview.invalid` origin or supported HTTP localhost/127.0.0.1 with an explicit port. This is not a global localhost grant: project/origin locks remain and the dispatcher rejects another project. GET-only, allowed-file/symlink, external-network, redirect, WebSocket, cookie/auth and resource checks stay active. Loopback forwarding pins connections to 127.0.0.1 without DNS/proxy inheritance. Automatic approval is logged. Starting a server remains a separate command under the regular execution policy; dangerous commands gain no preview permission.

A completed run hands a live Page to the user. The next run uses a current observer and fresh cancellation/QA options and takes control for an approved operation; it does not reuse an aborted run signal. A matching chat grant avoids another dialog. The existing panel distinguishes agent/user control, pause, closed, recovering and policy-blocked states.

`open(path:"index.html#scene")` uses the existing Page's approved origin, including localhost. A fresh session uses virtual preview. An explicit different-origin URL is rejected without poisoning the working Page. To change origins, close preview and open it in a new authorized task; project identity does not make arbitrary origins interchangeable.

After technical Page/CDP loss, an explicit `open` can recreate the Page once per run through the existing Native factory. Old resources/callbacks remain bound to the old Page. Explicit user close never triggers hidden reopen in the same run; a new user task may open it again. Stop does not restart the browser; a new task/Resume uses fresh signals. Pause retains checkpoint/history through the existing runtime.

A stopped preview server/`ERR_FAILED` is not user-close. Watchers stop on Page/transport closure; a failed final refresh no longer destroys an otherwise live session. Explicitly reopen the approved URL after server recovery. Identical unchanged failures remain blocked; a confirmed Page recreation releases only browser-failure records for that project slot. Reopen does not reset QA evidence or its anti-loop guard.

Focused checks: `npm run test:browser-session`. The Native/Rust E2E uses a scripted provider, not real Qwen/Vision inference.

## Independent Browser Tools and Vision

The chat model **Vision** control governs multimodal inference only. All `responsive.vision` / `visual_layout.vision` requests remain subject to it: a local `on` cannot bypass Vision Off. With Off/Unsupported, screenshots, DOM, functional QA and pixel diagnostics remain available; `visual.analyzed` stays false. Auto uses scoped visual criteria/targeted candidates; a plain `screenshot` does not request inference without `analyze:true`. On never creates screenshots automatically. A single capture or generic successful browser open does not verify a visual requirement. Evidence route/viewport/DPR, freshness and Verification Gate are unchanged.

## Visual debugging: selection to verification

Open the selected project's browser, choose **New area**, and draw around a defect. One area can contain several rectangles for the same problem. Its card exposes preview, transfer and deletion; name, color and manual status expand separately.

**Send to agent** adds structured references to the composer. Describe the task and send the message to start the run. Chips retain their own route, original viewport and grounding even after the browser navigates elsewhere.

**Check page** finds DOM/layout candidates on the current page and viewport, without an LLM or Vision. **Recheck fix** measures supported text clipping/overflow cases at the original URL and CSS viewport, then restores your viewport, Fit/Fixed, display scale and pan. A missing selector or failed QA cannot confirm a fix.

Work status and verification result are separate. A manual **Unresolved** decision survives passing QA. Details retain technical data and evidence. Narrow windows switch between browser and chat so the site remains usable. [Technical report and limitations](../visual-debugging-ux-workflow.md).
