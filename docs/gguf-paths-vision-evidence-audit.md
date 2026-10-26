# v0.3.0 — Individual GGUF paths and screenshot/Vision evidence audit

Base: `2cb7c3e254863bb0cb1b90f7d577d4aa1a09d047`. Branch: `fix/v0.3-gguf-paths-vision-evidence-audit`.

## Scope and evidence limits

This audit preserves the preceding Workspace/runtime/Verification work. User GGUF bytes, profiles, history, projects and `runtime/` were not changed. No disk was mounted/unmounted, no model weights were loaded, and no real Qwen multimodal inference was performed. Read-only inspection and `--version`/`--help` of the configured server were used; help confirms `--mmproj`, `--image-max-tokens`, `--no-mmproj-offload`, and `--ctx-size`.

At the observed baseline the reported NTFS volume was **already mounted** (`ntfs3`), `stat`/read access succeeded, `realpath` matched, the saved path matched byte-for-byte, and the production file validator returned `ready`. No relative GGUF paths were found in the inspected settings snapshots. There was no whitespace/Unicode/path-normalization discrepancy at that time. The legacy default directory also existed.

**The exact historical cause of the user's earlier cold-start failure is not established.** In particular, this baseline cannot prove that opening the old native picker auto-mounted the disk. Unmounting the user's disk to reconstruct that event was outside scope. The fixture explicitly simulates volume availability with temporary directory renames; it is not evidence of a real OS auto-mount. Old aggregate `fetch failed` model-list log entries were found, but were not attributed to this particular incident.

## Confirmed path-contract defects and fixes

The same displayed path can regain availability without its string changing: selecting/saving causes fresh checks and publishes state. It is not evidence that the path itself was repaired. Confirmed defects were:

- A same-path selection did not change `modelsKey`, so the form's path-dependent validation effect was not immediately rerun. Native focus/poll timing or Save could make the recovery appear dependent on resaving. Selecting a file now explicitly rechecks the form and refreshes the saved model selector **before Save**.
- Draft checks for the same key could resolve out of order. A request sequence now rejects late snapshots; successful checks also clear old errors. Existing renderer model-list ordering guards are retained and regression-tested.
- Model-list refresh was coupled to runtime synchronization, and a removed/stale active model alias could abort listing otherwise valid configured files. Runtime synchronization failure no longer prevents fresh filesystem listing; stale aliases do not hide other models. No inference-readiness checks were relaxed.
- Save and form readiness unnecessarily required the shared directory even when all model paths were absolute. Those dependencies were removed.

### A–E pipeline

| Operation | Current behavior |
| --- | --- |
| A. Cold validation | Registry normalization preserves each profile's absolute target; file readiness checks that target and required split siblings. Backend health is separate. |
| B. Refresh | Calls the filesystem validator again and publishes the newest model-list response. Does not save settings or reload weights. |
| C. Picker selection | Uses native picker, then explicitly triggers form and selector refresh even for the same path. No application mount command is used. |
| D. Save | Validates selected files; unavailable unchanged paths remain preserved. A missing unrelated default directory does not block Save. |
| E. Renderer | Latest-response guards protect the selector and form; stale unavailable results cannot overwrite a newer available result. |

The user-facing default GGUF folder field was removed. Internal `modelsPath` remains for backward compatibility and existing relative-path normalization; no automatic user-profile migration or cleanup was performed. The picker uses its last successfully selected directory in process memory, or the system default after cold start. Absolute profiles are not restricted to that directory.

The previous 10-second model/form scanning intervals were removed. Focus can trigger a bounded availability refresh for unavailable models, with an in-flight guard and a two-second cooldown. Manual Refresh is unconditional. No recursive disk scanning or mounting was added.

`ggufFileAvailability` continues to use fresh `stat`, read access, and GGUF v2/v3 header checks. Conventional split GGUF requires the first file and all declared neighboring shards. Metadata caches are keyed by filesystem identity and do not establish file availability by themselves. Refresh never rewrites a path.

### Three picker stages

The real Electron/SQLite fixture records separately:

1. Before picker: the simulated volume is unavailable and the saved absolute path is unchanged.
2. After selection, before Save: the fixture volume becomes available, the same path is returned, the card updates within three seconds, and settings bytes are unchanged.
3. After Save: availability remains valid; model paths and the internal legacy base are preserved.

The fixture additionally tests Refresh in both directions without Save, two independent directories, Unicode/spaces, missing default folder, cold process restart, last-used picker directory, delayed unavailable response, and RU/EN. Separate real-filesystem checks cover split shards, actual access denial/recovery and mount-like disappearance/reappearance. They never load multi-GB tensors.

## Screenshot pipeline and what Qwen receives

The application has two different inference paths:

```text
Browser Tool → privacy-masked bounded PNG → capture storage/hash
  ├─ main task: tool metadata/path + optional analysis text → Rust context → text tool result
  └─ separate BrowserVisionProvider request, when allowed:
       live capability → PNG integrity/budget → image_url data URL → backend response
```

A screenshot path is not converted into an image attachment for the main task model. `pixels_available_to_task_model` remains `false`. Thus the main Qwen agent does not receive screenshot pixels through this tool-result path. A separate request can use the same loaded Qwen model for image analysis and return text to the agent. Whether that secondary request occurred in the exact earlier grayscale run cannot be established from the supplied narrative or the PNG file alone.

Explicit user-image attachments use the pre-existing authorized attachment pipeline; they are not the browser-screenshot tool path. Those attachments are tested separately, including Off suppression, Auto with actual current image input, and exclusion of unrelated historical images.

### Honest tool provenance

Screenshot output now exposes `vision_input` and `visual.imageInput` when the provider runs:

- `not-sent`: Off, Auto without a scoped question, unsupported backend/model, unavailable or incompatible projector, invalid capture, or analysis not requested.
- `response-received`: a separate multimodal request returned a valid analysis response. The main task still receives text, not those pixels.
- `failed`: a request was attempted but no valid analysis was established; transport/response/cancellation stage is recorded.
- `reused: true`: a scoped cached analysis was reused; this is not a new inference request.

Cancellation is checked before cached success is returned. PNG signature, byte length, hash and dimensions are checked before encoding. Backend error bodies and malformed response contents are not echoed into diagnostics; failed response bodies are cancelled. No Base64 image payloads or absolute user-model paths are stored in the committed audit summaries.

Stable guidance forbids claiming direct pixel observation from a path or computed CSS. A screenshot-only final result gets a runtime-generated disclosure that distinguishes saved PNG, separate analysis text and image pixels. Free-form LLM prose is not proof and cannot promote Ledger status.

### Existing multimodal contract

Vision Off suppresses image analysis while retaining capture/DOM tools. Auto retains passive captures without inferring that anything was seen; a scoped/explicit question can use an available initialized capability. On requests analysis but cannot create a missing visual encoder/projector. Actual initialized backend capability is checked against the selected alias; another model's declaration cannot authorize image input.

The separate request uses `image_url` parts containing `data:image/png;base64,...`, at most two bounded frames, minimum 64×64, at most 1280×900 and 2 MiB per frame, plus a bounded question and a 768-token output cap. Primary attachment/context budgeting is unchanged. Capture privacy masks are applied before inference, and capture files are hash-checked before reading. Browser origin/security restrictions and the persisted screenshot budget remain in place.

The inspected local llama.cpp source revision was `d1d3c33`; this is not asserted to identify the configured binary. The configured binary's help flags were probed separately. The protocol is documented by [llama.cpp server](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md) and [multimodal documentation](https://github.com/ggml-org/llama.cpp/blob/master/docs/multimodal.md). The audit did not add model support or a new Vision Mode.

## Adaptive Verification ON/OFF comparison

Four temporary projects use the same deterministic tool sequence and original viewport. Vision is fixed Off so the QA policy is the only changed variable. The grayscale property is removed, rather than merely inferred from the source.

| Scenario | QA | Extra policy | Computed CSS | Screenshot calls | Main image parts | Extra reviews | Deliverable |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `#fd03b9` → `#fff` | ON | present | `rgb(255, 255, 255)` | 1 | 0 | 0 | Verified CSS criterion |
| same | OFF | absent | same | 1 | 0 | 0 | Verified CSS criterion |
| grayscale → property removed | ON | present | `filter: none` | 1 | 0 | 0 | Verified CSS criterion |
| same | OFF | absent | same | 1 | 0 | 0 | Verified CSS criterion |

The scripted provider intentionally makes no artificial tool-count difference. Each PNG capture itself stays `Not Verified`. An immutable computed-style criterion is executed through real Browser QA and its fresh evidence is then passed to `deliverables.verify`. No repeated terminal check is required.

The `filter` scalar was missing from bounded inspection and the Rust criterion whitelist. Both are now aligned; computed filter values can be inspected and formally asserted without arbitrary JavaScript. URL-containing computed values are omitted from DOM/selection diagnostics.

The UI toggle preserves the current Vision preference. `verificationEnabled` adds/removes adaptive guidance; it does not remove Browser Tools, disable optional checks, bypass security, attach images, or cancel explicit criteria. Scripted results establish policy/transport correctness, not how a real Qwen will choose tools in every natural-language task.

## Evidence levels and Gate

| Evidence | What it can establish |
| --- | --- |
| CSS source read | Source contents, not live rendered behavior. |
| Fresh computed CSS | Current measured scalar at the scoped route/viewport; can suffice for a small CSS-only completion under existing rules, without inventing formal Verified. |
| DOM geometry | Measured bounds/overflow; formal coverage requires the registered assertion and matching conditions. |
| PNG without image analysis | A capture exists with provenance; no visual observation or deliverable proof follows from existence. |
| Actual separate Vision response | An image-analysis assessment with uncertainty; a single image does not prove interaction or all aesthetics. Qualified visual opinions do not automatically verify a requirement. |

Removing grayscale is proven by computed `filter: none`. Saying the image visibly has correct colors requires actual image analysis or an explicit statement that this is an inference from CSS. Existing required criteria, source revision checks, URL/viewport/anchor matching and formal `deliverables.verify` remain mandatory where applicable. Unverified results retain concrete explanations from the prior v0.3 work.

## Results and reproduction

[Sanitized acceptance summary](test-results/gguf-paths-vision-audit/acceptance.json) contains test results, four policy traces, source revision hashes, masked pixel samples and transport metadata. Full temporary logs remain under `/tmp`; raw image payloads are not committed.

Relevant commands:

```sh
npm run typecheck
npm run lint
npm run build
cargo test --locked --manifest-path rust-agent/Cargo.toml
node scripts/gguf-storage-availability.test.mjs
node scripts/renderer-runtime-status.test.mjs
node scripts/gguf-path-reliability-electron.test.mjs
node scripts/model-profile-persistence-electron.test.mjs
node scripts/vision-browser-policy.test.mjs
node scripts/vision-image-routing-electron.test.mjs
node scripts/css-qa-policy-matrix.test.mjs
node scripts/adaptive-verification-electron.test.mjs
node scripts/fresh-browser-evidence-electron.test.mjs --resume
LOCAL_AI_TEST_RESULTS_DIR=/tmp/lad-path-vision-scenario-gate node scripts/scenario-gate-runtime.test.mjs
node scripts/qa-validation-diagnostics.test.mjs
node scripts/adaptive-verification-policy.test.mjs
node scripts/visual-region-feedback-electron.test.mjs --dpr2
node scripts/native-browser-shutdown-electron.test.mjs
```

Electron scenarios run sequentially on one DISPLAY. TypeScript, ESLint, build, Rust, capability/projector tests, model persistence, actual renderer races, Browser Ownership, screenshot budget, privacy, Stop/Continue, compaction, fresh evidence and RU/EN passed. Full Rust: 421 passed, 0 failed, 1 pre-existing ignored. The final sequential rerun passed all seven Electron scenarios. The scenario Gate regression also rejected unknown criteria, absent/unknown evidence and stale relevant revisions, blocked repeated invalid verification calls, and accepted fresh scoped retesting across runs. The existing Vite large-chunk warning remains.

No merge, release, `.deb`, user disk mount or user-data changes were performed. Real multimodal Qwen inference and the earlier OS picker auto-mount event are explicitly **not claimed**.
