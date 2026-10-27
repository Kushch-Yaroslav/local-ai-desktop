# v0.3 — Cold start, cross-route verification, edit backups and Browser UX

Branch: `fix/v0.3-coldstart-crossroute-backups-browser-ux`, base `9528195`.

## Confirmed live diagnosis, 2026-10-27

Read-only host checks were collected before opening a picker, changing a profile, mounting storage or restarting the user's application. The model volume is present as an NTFS block device but has no mount. Its Ubuntu media mount directory does not exist. `findmnt`, the host mount table, Node `stat/access/realpath` and the application's actual `ggufFileAvailability` agree. The UDisks journal for this boot says the mount point was cleaned up because the device was not mounted.

The persisted paths for Qwen Coder 80B and HyperNova are absolute, have no trailing whitespace and refer to that same volume. Their actual availability results are `unavailable / disk-unavailable`. The three models stored on the mounted DATA filesystem return `ready`. This confirms the user's current storage cause, rather than only reproducing an artificial missing file. A connected physical disk is not a mounted filesystem.

Refresh already performed fresh per-profile checks. It cannot make an absent filesystem path exist. There was no evidence that a global model directory or stale availability cache caused this live failure. The historical same-path picker recovery is consistent with desktop mounting, but no real picker auto-mount was observed in this investigation. No mount action, privilege request, OS automount change, model load or user-profile save was performed.

The user's running Electron/model-server processes and existing log were inspected read-only. The live renderer's IPC was not remotely instrumented; the real Refresh button/IPC and renderer synchronization were exercised in a separate production-app fixture. No forced Ubuntu reboot or restart of the user's instance was performed.

## GGUF recovery contract

Absolute paths remain independent of the legacy base directory. Split shards, access errors, metadata validation, renderer request ordering and loaded-runtime readiness retain their existing behavior.

- Missing media roots are distinguished from missing files under a mounted media root. On Linux the validator also checks the mount table when an empty media directory exists before the filesystem is mounted.
- Model settings and the selector explain unavailable storage and offer **Open file manager**. The IPC accepts a configured model ID, derives an existing directory from its saved path and uses `shell.openPath`. It does not run a mount command. The user connects the volume through normal desktop controls.
- A watcher is attached only to the parent of an unavailable media root. A filesystem event causes at most three settling checks, at 350/1500/4000 ms. Watchers and pending checks are removed when storage is available. There is no permanent polling or scan of every disk.
- Focus revalidation and explicit Refresh remain available and retain their stale-response protection. They update availability without saving paths or restarting a model server.

## Current Qwen failure: correct implementation, blocked secondary route

The [anonymized saved trace](test-results/coldstart-crossroute-backups-browser-ux/historical-run.json) was obtained by copying the live database and WAL as ordinary read-only files, checking that their sizes/timestamps stayed stable, then opening only the temporary copy with SQLite. The original database was never opened for writing. It is a different run from the earlier spatial-grounding audit.

This run had one attached Region reference. Its plan completed the creation of `LoremBlock`, styles, and insertion between `Explainer` and `Reviews`; step 4, checking products 1/2/3, remained in progress. No acceptance criteria were registered. Saved Browser observations show text on products 1/2, absence on product 3, and `Georgia, serif` measured on product 1. The failure is not attributed to misunderstanding the requested component.

The model opened Product 2 successfully but omitted `supplementary_reason` from every inspection. Navigation and Region verification were separate operations: the following inspect still ran against the original Product 1 Region guard. Reopening Product 2 did not restore the original route and therefore did not invalidate the cached failed inspect. The same selector then produced `DUPLICATE_FAILED_OPERATION`. The existing detector paused after four equivalent rejected Browser attempts. Thresholds and checkpoint persistence were not disabled or increased.

The public schema technically already had `supplementary_reason`, but a long description and the mismatch guidance overemphasized returning to the original route. The corrected contract supports both paths:

1. A bounded diagnostic on an explicitly requested route can supply a short `supplementary_reason`. The leading tool description, always-present runtime guidance and returned correction template now explain the valid action. The user needs no technical syntax.
2. A separate registered criterion with project source paths, target URL and viewport becomes an automatic supplementary scope for that task. `verification_scope: {deliverable_id, criterion_id}` can identify it explicitly for inspect/read/screenshot; `scenario_refs` executes its immutable formal QA specification. Current task memory supplies these scopes, including after Continue/compaction.

Scope is constrained to the current project, exact URL and viewport and the already approved origin. Original Region group IDs cannot become supplementary scopes. Unknown, dropped, foreign-project and unscoped criteria do not authorize checks. Supplementary observations retain `matches_current: false` for the old Region. Each formal criterion requires its own fresh source-bound evidence; the existing Ledger/Gate still validates URL, viewport, source revision and criterion identity.

A successful navigation to a registered supplementary route releases only cached read/inspect failures for that project. Other projects, screenshot limitations, security-denial records and Loop Detector counters remain intact. Repeating an unchanged rejected operation remains bounded.

## Selector diagnosis

The saved zero-match inspections reported `freshness: updated`; a stale HMR document is not established as their cause. The model guessed `.inner`, a CSS Modules hash and direct-child structure. Inspecting `#loremBlock` correctly measured the wrapper's Inter font; the later descendant selector measured Georgia.

The tool already returned 24 candidate elements, but they came from the beginning of the long page: the target `#loremBlock` was absent from that list. For a failed selector whose leading ID still exists, diagnostics now prioritize that live ancestor and its descendants, with real classes and checked unique selector hints. Nested nodes without a unique class receive a bounded ID-relative path. This fixes the relevance problem without adding arbitrary JavaScript execution or inferring React component identity.

## External edit backups and recovery

Both generic mutation implementations previously wrote sibling `.local-ai-backups`: Rust file tools and the TypeScript fallback editor/downloader. New preimages use the application's `app-data/edit-backups` store. Canonical project identity and logical-task identity are hashed into separate directories; every snapshot has a unique directory. The TypeScript legacy editor uses a separate `legacy` bucket. Standalone Rust callers without desktop configuration use a private temporary store outside their project.

Before source modification, the writer records original bytes or an absence marker, source mode, target/project identity, format/application marker and SHA-256. Preimage, manifest and containing directory entries are synchronized to disk. Storage paths containing symlinks are refused; recovery storage remains protected from generic project tools. If the configured application storage lies inside the selected project, the edit is refused rather than creating service backups in source. Use a separate app-data root for that configuration.

Atomic source staging/rename remains in place. Multi-file patch rollback retains its original byte preimages and now also restores modes after rolling back an earlier deletion. New-file rollback preserves absence. Stop and a worker crash do not remove already durable preimages; restarting the worker preserves separate generations. This is recovery data, not an automatic Git commit or a new undo UI.

Legacy `.local-ai-backups` directories are still protected/ignored. They are neither migrated nor deleted automatically: their old manifests lack the new application/version/integrity marker, so ownership cannot safely be assumed. An owner may inspect a known manifest and its target/preimage, move those known generated records outside the project, and remove them manually after deciding they are no longer needed. Unrecognized backup directories are retained.

## Visible Browser Workspace changes

- Compact header with a clear Browser title, readable layout choice, active Tools toggle, expand/split and Hide actions. Icon buttons keep tooltips and larger click targets.
- **Page address** label, readable URL, explicit **Go** button with a navigation arrow, Enter submission, loading indicator and navigation-error explanation. The text stays visible on a narrow panel. Navigating preserves the chosen expanded/split mode; agent navigation updates the same address field.
- Viewport, Page zoom, presentation mode and Preview scale are grouped. Auto fit and Fixed scale keep their existing semantics and Native Surface geometry. Disabled fields explain ownership or Auto fit.
- A fixed-height footer shows connection state and user/agent ownership through icon, text and color, including when tools are collapsed. Ownership changes do not resize the Page.
- The user section is **Regions**; descriptions ask what needs to be done, with **Mark complete** and **Check result**. Manual/automatic provenance remains visible, including combined sources. SQLite/protocol names remain unchanged.
- Ordinary model controls use **Add model** and **Model file**. Format-specific GGUF/split/projector terminology remains where technically needed.

Screenshot fixtures contain only temporary demo content. Electron renderer screenshots and corresponding Native WebContents captures are recorded separately because the Native Page is a separate compositor surface. Both were inspected; a renderer-only screenshot is not presented as capture of the native pixels.

## Acceptance

The [acceptance manifest](test-results/coldstart-crossroute-backups-browser-ux/acceptance.json) records commands, results and limits. Selected fixture screenshots are recorded alongside it: [horizontal, 10 Regions](test-results/coldstart-crossroute-backups-browser-ux/dpr1-horizontal-10.png), [narrow](test-results/coldstart-crossroute-backups-browser-ux/dpr1-narrow-10.png), [agent ownership, DPR 2](test-results/coldstart-crossroute-backups-browser-ux/dpr2-agent-ownership.png), [Russian UI](test-results/coldstart-crossroute-backups-browser-ux/dpr2-ru.png). Each has a separate `-native.png` companion containing the actual Native Page pixels. Tests use temporary projects and app-data. Scripted providers drive real Rust, Electron, React/Vite, Chromium, SQLite and HTTP; they are not real Qwen semantic inference.

The controlled workflow verifies the text section and Georgia/Courier New on routes 1/2, complete DOM absence without extra gap/cards on routes 3/4, separate fresh criterion evidence and final Verified. Negative route/scope/viewport/original-Region tests remain denied. Actual compaction retains the original request, Region ID and the real invalid-QA diagnostic, even when that diagnostic is folded into durable evidence instead of remaining in a raw tool message. A missing Vite import blocks fresh QA; restoring the file remounts React in the same Native Page.

Backup regressions use real mutations and a deliberately hard-killed owned Rust worker, then a new worker. The original and later preimages remain readable with matching hashes, both projects contain no `.local-ai-backups`, concurrent snapshots are distinct, and a real read-only-directory patch failure rolls back bytes and permissions.

The final workspace geometry runs cover both layouts, Auto/fixed viewports and DPR 1/2. For a fixed CSS viewport of 1440×900, Native bounds are 720×450, 1080×675, 1440×900 and 1800×1125 at presentation scales 50/75/100/125%. DPR changes physical pixel density; these bounds remain device-independent. Tools collapse, ownership changes, hiding/reopening and renderer reload preserve the same Page and settings.

The adaptive-policy acceptance confirms ON adds the policy and OFF removes it while keeping voluntary inspect available. It does not require different tool counts. Eight captures persist across Stop/Continue and an application restart; the ninth is refused, while CSS inspection and a new independent task remain usable. Capture-only output reports no visual analysis. The separate Vision transport fixture decodes real PNG bytes, checks their hash and privacy mask, and records `response-received` for its explicit test response; task inference still receives analysis text/metadata rather than screenshot pixels. No real vision-model inference is claimed.

Acceptance maintenance preserved product contracts: the layout fixture clears automatically attached draft references before testing a separate two-area transfer; invalid-QA evidence may be retained in a durable compaction envelope rather than a raw tool message. The adaptive fixture now uses a 28,672-token continuation context, because its former 24,576-token allocation cannot fit the current full public schema. The fresh-evidence fixture validates bounded Ledger facts in actual task payloads as well as the complete observation on disk. It distinguishes an arbitrary missing selector (`ELEMENT_NOT_FOUND`) from a saved ambiguous anchor (`STALE_DOM_ANCHOR`). When Vite binds JSX but supplies no exact CSS revision, the unchanged Gate can make one bounded review; no source coverage is invented to force an exact request count.

The complete Rust suite was run outside the Codex filesystem namespace with the installed root-owned `bwrap` helper and all isolation policies active: **428 passed, 0 failed, 1 pre-existing ignored** (`live_scoped_browser_acceptance_with_project_warning_and_inverse`, opt-in installed-Chrome integration). Separate real Electron/Chromium acceptance covers the browser workflows. Earlier namespace-dependent helper-owner failures are not reported as application failures or bypassed by disabling sandboxing.

## Remaining limits

The user's NTFS filesystem remains unmounted. Reading or loading its actual weights cannot be validated until the user connects it. Historical picker auto-mount remains unproven. No new real Qwen inference was run; scripted success establishes transport, scope, recovery and verification contracts. Full historical HTTP inference payloads were not persisted. Existing old backups remain untouched. The production build retains its existing large-chunk warning. No merge, release or `.deb` build/install was performed.

## Git scope

Branch: `fix/v0.3-coldstart-crossroute-backups-browser-ux`, based on `9528195`. Implementation commits: `7ad3d0b` (GGUF recovery), `1b63d1f` (supplementary routes), `57cfcae` (external backups), `a0d4493` (Browser UX). Acceptance/documentation are committed separately. Pre-existing untracked `runtime/` is excluded. User projects, weights, profiles, chat history and old backups were not modified.
