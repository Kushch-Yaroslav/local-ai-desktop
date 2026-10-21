# Persistent Model Profiles verification — 2026-10-21

Implementation: `76dab84`. Base: `eb4f28e`, work branch `fix/v0.3-model-profile-persistence`.

## Diagnosis and data flow

GGUF profiles are persisted in `runtime-settings.json`, not in a second SQLite registry. SQLite retains conversation model IDs. Normalization already preserves supported V2 advanced parameters, defaults, family/tool overrides and external draft identity. Both the model registry and runtime policy read that configuration. Save writes an atomic normalized JSON and the renderer explicitly refreshes settings/models afterward.

The renderer's startup list was a one-time availability snapshot. The 4-second health poll only updated backend state, not model files. A file unavailable during startup therefore remained disabled after remount/recovery. Save without changes appeared to repair persistence because its refresh reread those files. This failure is reproduced with a missing/restored split shard. Another conflation was the `installed` predicate requiring successful capability metadata parsing, rather than separating accessible files from metadata/launch validation.

At diagnosis, all five actual configured model files, including the two custom profiles, were readable and metadata inspection succeeded. No persisted profile loss was observed then. The historical startup timing/mount failure cannot be established from the user's description alone; no claim is made that every past occurrence had an identical cause.

A separate confirmed defect was fresh configuration seeding the three historical Qwen entries. They are now migration/compatibility templates, not automatically registered profiles on a fresh install.

## Changes

- Fresh configuration has an empty model array. Existing V2 arrays retain IDs and settings; legacy keyed maps retain historical identities for old chats. No startup migration writes occur. Explicit legacy Save preserves the exact original JSON in `.pre-v2.bak` before replacement.
- Backend listing uses one persisted configuration snapshot and a bounded active-server metadata request. It does not load model weights. File readiness checks readability of all conventional split shards and the first GGUF header; metadata inspection remains separately exposed. This is not a claim of complete tensor integrity. Full launch, draft compatibility/SHA and capability checks remain in force.
- Model availability refreshes every 10 seconds and on window focus. Draft availability uses the same cadence while the form is open, without overwriting drafts. Sidebar readiness follows the refreshed model list. Offline backend is independent of file availability.
- The selector uses Ready to load / Loaded / File unavailable / Needs setup labels. Profile cards retain paths and concrete filesystem errors, including missing secondary shards. Metadata diagnostics remain available in the editor/model inspection.
- Profile header buttons toggle the same editor, switch between editors, expose `aria-expanded`/`aria-controls`, and support native Enter/Space. Delete is a separate button. Draft values live in the parent configuration, surviving collapse and Simple/Advanced changes. Only Save persists edits; closing the settings window discards unsaved drafts as before.
- No profile schema, launcher, inference algorithm, model weights or database migration changed.

## Executed checks

| Check | Result / scope |
| --- | --- |
| `npm run test:model-profile-persistence` | PASS: full build including Rust agent build, TypeScript, ESLint, settings unit suite, filesystem/process tests, compatibility suites and real Electron UI |
| `runtime-settings.test` | PASS: empty fresh registry, explicit legacy templates, unchanged old IDs, idempotent save/migration backup, malformed settings backup, relative/absolute paths, XDG stability across bundle relocation |
| `model-profile-persistence.test.mjs` | PASS: full advanced/default/family/projector/external-MTP identity roundtrip across separate processes; missing/restored first and secondary shard; no hydration writes; metadata errors separate from file presence; invalid header rejected |
| `model-profile-compatibility.test.mjs` | PASS in separate processes using explicit temporary legacy templates: model capabilities, speculative launch config, runtime controller, backend HTTP/request regressions |
| `model-profile-persistence-electron.test.mjs` | PASS against actual built Electron main/renderer/preload/IPC/SQLite: clean empty install, save two synthetic Qwen/GPT profiles, renderer recreation, Electron restart, offline model availability, missing/restored split dependency, focus refresh without Save, advanced settings retention, chat model ID, Enter/Space/collapse/switch/delete and no incidental form writes |
| Existing `model-profiles-electron.test.mjs` | PASS: actual Electron/UI/SQLite with controlled backend; Simple/Advanced, RU/EN, reasoning, save without restart, simulated OOM rollback, pending/apply/unload/restart and no stale error |
| `gguf-artifacts.test` | PASS: split path validation, dependency readability and identity invalidation |
| Database regression | PASS (temporary SQLite) |
| `git diff --check` | PASS |

Final combined run: `/tmp/lad-profile-persistence-final.log`; final Electron runtime: `/tmp/lad-profile-persistence-Z6iepG`. Test images and generated legacy report artifacts are not included in this change. The build retains the existing Vite large-chunk advisory; no type/lint checks were disabled.

## Limits and data preservation

No heavy LLM inference, GPU benchmark, model download, installed package update, release or merge was performed. Synthetic GGUFs test file/persistence behavior, not inference correctness. Backend lifecycle/CUDA failures in the existing UI suite are controlled fixtures, not real CUDA evidence. Rust source was not changed; the mandatory application build compiled the Rust executable, but no full Rust test run was necessary for this UI/TypeScript change.

The first standalone execution of an older backend regression appended synthetic diagnostics to the default `runtime/logs/application.log`. This side effect was detected; the test now redirects its logger to its temporary fixture, and the final compatibility runner isolates every process. The existing user log was left intact rather than editing potentially interleaved user entries. User profile settings, chat database, checkpoints, GGUF files and NEXUS were not changed. `runtime/` remains untracked and is not included in commits.
