# Unified model controls and portaled session settings — 2026-11-04

## Implementation

ChatInput no longer imports or mounts ManagedLocalRuntime. Its bottom-bar
ModelsBottomBar is the single chat model selection/control entry. The existing
Radix dropdown now contains managed profiles and all configured native/cloud
provider models, plus predefined models. It deduplicates provider/model pairs and
suppresses the generic `local-gguf` records represented by saved profile rows.
Recent and Current Model sections are not rendered; their upstream translation
entries remain preserved.

Managed rows distinguish selected (purple border/check) from loaded (green
border/readiness dot); both indicators can coexist. Saved names are used; duplicate
names have short profile IDs. Load/Unload/Cancel are separate Radix menu items and
prevent selection/menu dismissal. Settings closes the menu then navigates with
`ggufProfileId`; the existing model editor selects that exact profile. Native
Goose models retain their native settings editor unless a saved native profile
matches. Cloud rows have no inference-process controls.

Runtime state comes from the existing supervisor event stream. UI actions check
managed session activity; the backend now refuses explicit load/unload under a
runtime lease and refuses unloading during an admitted inference request.
Shutdown retains its owned-process cleanup. Missing executable permissions are
checked in lightweight profile availability listing. No GGUF files are copied or
deleted; profile/model settings and the agent loop are not rewritten.

SessionSettingsPopover uses Radix Popover Portal, normal z-50 layering,
collisionPadding=12 and available-height constraints. It is outside the composer's
clipping/stacking ancestors. The old document-level dismissal handler was removed
so interacting with portaled content does not look like an outside click.

## Validation

- TypeScript and focused ESLint: passed.
- English extraction/check and Russian locale validation: passed (1781 messages).
- Focused regression suite: 66 tests in 10 files passed. Covers real Radix menu
  interactions, per-profile actions/settings identity, independent loaded/selected
  state, native/cloud selection, search, keyboard focus, missing profiles/errors,
  pending load cancellation, session controls/first-message settings, runtime
  request/lease protection, model switching/cleanup, context discovery,
  speculation compatibility and OpenAI tool/reasoning protocol fidelity.
- Chromium layout test: passed at widths 360 and 1280, both light/dark and reduced
  motion. It renders the actual controls and built Goose CSS/theme tokens while
  stubbing service boundaries. A transformed overflow:hidden ancestor and an
  overlapping conversation layer intentionally exercise clipping. Bounding boxes
  remain inside the viewport; the popover crosses the clipping ancestor boundary;
  elementFromPoint and actual control interactions confirm it is not obscured.
  Escape, focus restoration, outside click, Russian controls and scroll bounds are
  exercised. These tests do not run model weights or access user profiles.
- Electron Forge Linux x64 package: passed. Bundled resources/bin/goose is
  executable, version 1.57.0. The final package is under the existing
  ui/desktop/out/Local AI Desktop-linux-x64 path used by both unchanged launchers.

Reproduce browser layout checks from ui/desktop after packaging:

```sh
node tests/ui/check-model-controls-layout.mjs
```

## Real desktop evidence and limitations

No existing dev application or llama-server was running at the package checks;
no user process was stopped. The final package was cold-started through the exact
registered GNOME ID from the user session manager, outside the IDE Snap profile.
Electron PID 53331 and Goose backend PID 53595 started; the backend health trace
confirmed readiness at 17:34:43. Window 0x4600004 has the expected
local-ai-desktop-goose-dev WM_CLASS. The actual X11 screenshot shows the clean
composer, bottom human-readable model selector and session settings trigger.

Repeat activation exited its secondary instance cleanly. Stopping only the
completed initiating test units left one Electron instance and one backend running.
The existing launcher and AppArmor rule were not changed.

CUA lists no app surfaces and cannot bind the known window. Therefore menu/popover
mouse interaction in the user's actual Electron window is NOT VERIFIED. The menu
and opened-popover screenshots named *fixture* are isolated Chromium integration
fixtures, not screenshots of user interaction with Electron. No new real CUDA
load/unload, MTP benchmark, live MCP/Skills or cloud API call was performed in this
UI task. Runtime/protocol regression tests passed; those do not establish live
provider availability. The newly started dev application is left open for review.

Screenshots:
- Actual Electron: docs/screenshots/unified-selector-electron-composer.png
- Browser fixtures: docs/screenshots/model-selector-fixture-{dark,light}-{360,1280}.png
- Browser fixtures: docs/screenshots/session-popover-fixture-{dark,light}-{360,1280}.png

## Changed source/test files for this task

- ui/desktop/src/components/ChatInput.tsx
- ui/desktop/src/components/settings/models/bottom_bar/ModelsBottomBar.tsx
- ui/desktop/src/components/settings/models/bottom_bar/ModelsBottomBar.test.tsx
- ui/desktop/src/components/SessionSettingsPopover.tsx
- ui/desktop/src/components/SessionSettingsPopover.test.tsx
- ui/desktop/src/components/onboarding/AdvancedLocalInference.tsx
- ui/desktop/src/components/settings/localInference/LocalInferenceSection.tsx
- ui/desktop/src/utils/navigationUtils.ts
- ui/desktop/src/managedGguf.ts
- ui/desktop/src/managedGguf.test.ts
- ui/desktop/src/i18n/messages/en.json and ru.json
- ui/desktop/tests/ui/model-controls-fixtures.tsx
- ui/desktop/tests/ui/model-controls-layout.tsx
- ui/desktop/tests/ui/check-model-controls-layout.mjs
- This report and the screenshots above.

Pre-existing repository changes were preserved. No commits, pushes or releases.
