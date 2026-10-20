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
