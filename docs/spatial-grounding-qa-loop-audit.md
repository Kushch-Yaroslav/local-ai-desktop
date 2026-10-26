# v0.3 — Spatial grounding, conditional requirements and QA loops

Base: `a8244ed`. Branch: `fix/v0.3-spatial-grounding-qa-loop`.

## Historical diagnosis

The failing 2026-10-26 run was recovered from a temporary copy of the saved SQLite database. The original database, profiles, GGUF, projects and pre-existing `runtime/` were not modified. The investigation used saved messages, region documents, raw tool arguments/results, the reasoning timeline and task checkpoint. Full historical HTTP inference payloads were not found; reconstructed context is not presented as an exact wire capture.

[Sanitized historical trace](test-results/spatial-grounding-qa-loop/historical-run.json) includes the seven rejected JSON calls, saved region geometry/anchor selectors, changed-file list and loop notices. Project origins/paths and run identifiers are omitted or anonymized.

The saved user message has **zero region references**. A region had been saved about two minutes earlier, with a crop, viewport 1800×1125 and four DOM candidates, including `#expert > figure` and review descendants. Subsequent Browser Tool results also report `region_context.references: []`. Thus the existing message/reference pipeline did not provide this saved selection to the agent. Selection storage and the explicit transfer-to-composer action were separate. The surviving records cannot establish whether the user omitted that action or whether another UI event failed; they do establish that saved selection ≠ attached reference. No absent reference is inferred merely from the model's remark about not seeing a highlight.

### Decision timeline

| Point | Saved evidence and implication |
| --- | --- |
| First reasoning, before any compaction | The model paraphrases complete absence of the section on other product pages as absence of a custom font on other products. This is the first semantic error. |
| Project exploration | `OtherItems`/Home structure becomes the template for a new product carousel. No supplied spatial reference anchors this choice. |
| Edits 29–37 | Creates `LoremSection.tsx` and its CSS with product IDs 1–5; adds an unconditional wrapper and component in `Home.tsx`, after `OtherItems`, before `Explainer`; updates navigation IDs/scroll sections. |
| Build | Vite fails on nonexistent `RaitingBlocks/Rating/Rating`. The recorded Node 18/Vite 7 compatibility warning is a separate issue. |
| Edit 53 and later DOM reads | Changes the import to `RaitingBlocks/Raiting/Rating`; live DOM then contains the new section. A product-3 DOM read also contains it. No successful production rebuild after this correction is recorded. |
| Compaction | One compaction occurs after the initial misinterpretation and implementation. Task Memory has no factual entries. It cannot explain the first semantic error. |
| QA calls 73–79 | All seven style assertions omit selector. Calls also vary missing viewport/path and prohibited temporal sampling. None measures a font. |
| Loop notices | First three failures belong to one scenario set; another four belong to the later set. Warnings at count 3, pause at count 4; checkpoint stop reason `repeated_tool_failure`, run status `interrupted`. No formal successful requirement verification. |

The section appeared on ID 3 because its existence was unconditional in the shared layout. Fonts were chosen for catalog items inside it; route-dependent section existence was never implemented. The temporary import fix restored observed rendering, which does not establish a successful full build or correct behavior.

### Why the rejected checks could not work

`font-family` was missing from both the TypeScript scalar whitelist and Rust immutable-criterion whitelist, and from bounded CSS inspection. Even after adding the path, the calls still lacked a selector. Some calls supplied `sample_ms`, which scalar style assertions reject. The first call had no explicit viewport. `equals` and expected `Georgia, serif` were present; that string was a model expectation, not a measured value.

The recurring `border-top-left-radius` was the Runtime's generic error example, **not** the raw Qwen assertion and not a serialization/UI substitution. The error mixed multiple causes into a generic selector/path message, then recommended copying an unrelated example. The loop warning reinforced “use the exact example.” This was counterproductive. The detector itself correctly stopped equivalent failures and retained counters in the checkpoint; its limits were not increased.

## Changes

### Reference delivery and spatial context

A newly saved manual selection in the current conversation/project now adds a visible, removable composer reference. It never sends a message automatically. Completed old areas are not silently attached on startup or chat switching, and automatic DOM candidates still use explicit selection/transfer. Existing manual multi-select transfer remains available.

Grounding adds optional `surroundings` to newly captured regions:

- Above/below semantic DOM sections, bounded non-private text, selectors when unique, document-CSS rectangles and an optional common container.
- `between-siblings` only for a geometrically consistent adjacent semantic pair with a shared parent and no competing column candidates; confidence is moderate (0.7).
- `ambiguous` for uncertain structure, multiple subtrees or competing candidates; confidence is low (0.2), with explicit further-inspection/clarification advice.

No React source/component identity is inferred from geometry. Historical surroundings become stale like the original anchors; the agent must inspect current DOM and confirm source composition. No absolute-position insertion is recommended. Old region records remain readable and are not rewritten to invent new historical hints.

Visual context now treats a selection as task context for adding, removing, moving, replacing or styling content. The fallback composer request asks what change is wanted rather than assuming an existing defect. The historical marker `ORIGINAL ISSUE EVIDENCE` is retained for compatibility, while its instructions explicitly say the selection need not describe a defect.

### Constraints and continuation

A compact planning rule distinguishes where a component belongs, when it exists, which properties vary, and when it is absent; it asks for a check against original wording without requiring a long plan for CSS edits.

SQLite-owned task history now restores trusted `logicalTaskId` metadata onto request objects; renderer-local messages may not yet have it. Continue embeds the original user wording from that same task into the current request. A different task does not inherit it. Current user corrections remain authoritative. Rust projection also preserves the original RunUser across compaction in a durable multi-turn transcript. Reprojected old image parts are excluded; retaining text does not authorize historical image input.

This fixes a general loss-of-constraints risk demonstrated by the controlled continuation. It does **not** retroactively attribute the historical first error to compaction: that error occurred in the first reasoning step.

### QA diagnostics and source-backed proof

`font-family` is now an allowed bounded read-only scalar in DOM inspection, selection styles and Rust criteria. This uses the existing style assertion API, with explicit original viewport, inspected selector, `path: "font-family"`, `operator: "equals"` and the actual computed CSS string. Temporal sampling/tolerance remain disallowed for style.

Invalid calls retain `INVALID_QA_ARGUMENTS`, `retrySameArguments: false` and validation stage. Diagnostics identify the failing scenario and missing fields, list supported properties, preserve the original supported property/expected value/route/viewport in templates, and mark examples as templates rather than evidence. Missing or unsupported properties offer inspect as an alternative instead of inventing a replacement property. The guidance does not tell the model to change its task into a radius assertion. Rust formal-criterion errors also preserve the requested property instead of substituting a radius example.

A further confirmed integration defect appeared in the React fixture: successful Vite Browser QA had no `source_path`/source revisions, so Rust correctly refused to record formal evidence. The bridge now recognizes a bounded inline v3 source map only when its original bytes exactly match the requested file inside the approved project. Hidden files, symlinks, traversal and virtual/outside modules remain excluded. Uncompiled JSX/TS reads are enabled only for internal evidence snapshots; static browser delivery does not enable them. No source-map URL is followed.

Source hashes pass through the existing revision/freshness/Gate checks. A missing or stale map does not establish proof; tool metadata explains `source_binding: unavailable`. This is a conservative partial binding, not a general Vite source resolver. Origin approval and Browser Ownership remain independent requirements.

Additional user-requested routes use separately scoped deliverables and `supplementary_reason`; they do not certify the original region on another URL. This preserves the existing route guard.

## Controlled reproduction

The new Electron fixture runs real React/Vite, Native Browser Workspace, selection storage, SQLite, Rust Agent Runtime, tool transport and Chromium QA. Its deterministic provider implements the requested conditional component and deliberately submits one malformed font check before correcting it.

Assertions cover:

1. An approximate rectangle crossing the end of A, the empty gap and the beginning of B produces historical sibling hints and a composer chip without a transfer click.
2. Actual inference payload contains region UUID, original route/viewport, neighbor text and a task-neutral contract.
3. Stop, renderer reload, Continue and actual compaction retain the original Russian absence requirement and region hints.
4. Separate route criteria measure Georgia, Courier New, and an application-exposed DOM count of zero. Each criterion has its own passing evidence and formal verification.
5. Independent DOM inspection on routes 1–4 checks order, exact absence, zero product cards, unchanged neighbor text, and no extra gap when absent. A hidden element would fail the DOM count/order checks.
6. A deliberately missing import cannot produce Verified QA. Restoring the source recovers React in the same Native Page without restarting Vite.

A separate Chromium fixture covers empty-gap-only/large/crossing selections, private text, competing columns, different subtrees, exact/stale/missing source maps, and hidden/symlink/static-source guards. Runtime transport unit tests cover task ownership and original wording isolation. An additional real Rust/Chromium test submits four equivalent invalid QA calls, observes the loop pause, then continues: the first equivalent retry pauses again. No passing criterion evidence is fabricated and the item remains implemented. Existing Rust tests also cover guard serialization and continuation persistence.

Scripted success establishes contracts, transport and checks; it does not establish that a real Qwen will correctly understand every approximate selection. No real Qwen run was performed and no user weights/profile were loaded or changed.

## Validation and limits

[Acceptance results](test-results/spatial-grounding-qa-loop/acceptance.json) records the final runs. TypeScript, ESLint, build, full Rust and targeted Electron/Chromium regressions were run. Full Rust: 422 passed, 0 failed, 1 pre-existing ignored. The legacy fresh-evidence fixture now uses a 36K window and an explicit temporary-notes read after Continue: 24K no longer fits the schema/reference envelope, while excessive capacity does not induce compaction. Its full CSS observation, actual compaction and same-Page assertions remain intact. The existing Vite large-chunk build warning remains.

Targeted reproduction: `node scripts/spatial-grounding.test.mjs`, `node scripts/spatial-grounding-electron.test.mjs`, `node scripts/invalid-qa-continuation.test.mjs`, and `node scripts/fresh-browser-evidence-electron.test.mjs --resume` after `npm run build`. Electron scenarios run sequentially on one DISPLAY. All 16 final targeted suites passed; the acceptance JSON lists them individually.

No merge, release, `.deb`, user-project edit or user-history mutation was performed. Main remaining limits are absent exact historical HTTP requests, no recorded final historical production build, optional new hints only on newly captured selections, conservative source-map support, and no real-model semantic reproduction. Source inspection or a concise clarification remains necessary for genuinely ambiguous selections.
