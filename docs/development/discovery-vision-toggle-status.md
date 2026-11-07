# Discovery results and Vision quick toggle — 2026-11-05

## Confirmed fixes

The selector called contextChoices with both catalog.options and catalog.previous. Its implementation merged both collections, so historical configuration fingerprints appeared beside current recommendations even after exact-config storage replacement. The selector now excludes previous history and keeps the latest option per precision. Historical persistence remains bounded, outside the normal grid. Manual pending context is retained across runtime/catalog refresh for the same profile; changing profiles resets it to the selected profile's values.

Vision adds an optional visionEnabled profile field. Undefined preserves legacy projector-enabled behavior. False preserves the path while excluding --mmproj and --no-mmproj-offload, projector file validation for activation and active projector fingerprinting. The new Eye action uses target architecture, projector metadata/dimension and selected runtime flag checks. Invalid projector configuration is reported rather than declared ready. Saved and active states differ; explicit reload uses the existing lease/activity guard. Provider registration is refreshed using effective capability state. Vision capability follows active args while the same profile is ready, or requested configuration while unloaded.

Discovery still uses the existing calculation core. Vision and MTP flags are present in the actual launch and configuration identity. Allocation reads are now restricted to the current owned launch log segment. Incomplete evidence is returned as its concrete unknownReasons instead of only a generic no-measurements error. No memory formulas or reserves were changed.

## Real bounded Q8 observation

No llama-server or user app was active at the host inventory; free VRAM was 22920 MiB. An opt-in test copied the saved Qwen27B-3.8 configuration into temporary application storage, set 16384 context and Q8 K/V, and explicitly requested Flash Attention On. Projector and Embedded MTP remained enabled. Startup reached Ready, health and a two-token synthetic inference passed. Effective args included --mmproj, --cache-type-k q8_0, --cache-type-v q8_0, --flash-attn on, --spec-type draft-mtp and draft count 2.

Allocation parsing reported context 16384 and no unknownReasons. Target KV was 570425344 bytes (544 MiB), MTP KV 67108864 bytes (64 MiB). Full safe evidence is in q8-vision-mtp-16k-evidence.json. Test-owned model was shut down and temporary state removed.

The saved user's Flash Attention setting is unspecified, not explicit Off. Existing log evidence shows FA enabled and Q8 buffers. Thus a universal Q8/FA incompatibility was not established. The previous exact search failure was not reproduced by this bounded test; no maximum was computed, and the former 176128 result is not asserted valid with current Vision/MTP settings. Reading the latest accumulated user log also produced complete Q8 evidence; log segmentation is a correctness fix, not proof that it caused that specific previous failure. Prior failed probes did not retain enough structured evidence to identify the exact historical rejection. New diagnostics expose the individual reason on a subsequent bounded discovery run.

## Validation and package

- 28 core/schema/configuration tests passed.
- 56 targeted UI, registry, owned runtime and Vision argument regressions passed.
- One opt-in real CUDA 16K Q8/Vision/MTP test passed.
- TypeScript, targeted ESLint, EN extraction and RU validation passed (1824 messages).
- Forge package built in staging then installed at the existing out/Local AI Desktop-linux-x64 path after host process inspection showed no live app. Previous package retained in out-pre-vision-discovery. Bundled executable backend matches src/bin/goose.
- No user profile, context override or discovery registry was edited. No heavy maximum search, benchmark, driver/launcher/AppArmor change, commit or release.

## Remaining verification

The precise historical Q8 maximum-search failure and a new validated maximum are unresolved. Interactive packaged Eye-toggle operation, real Vision On/Off reload/image round trip, and all four combinations through full discovery were not rerun. Unit argument coverage proves projector flags are omitted with Off, but no fresh GPU Off-vs-On VRAM comparison was performed. Do not claim full task completion or a new safe maximum based on the bounded startup test.

Changed sources: contextDiscovery/contextChoices.ts; SessionSettingsPopover.tsx; ggufTypes.ts; ggufConfig.ts; managedGguf.ts; preload.ts; ModelsBottomBar.tsx; new VisionQuickControl.tsx; EN/RU catalogs. Added/updated focused tests: contextChoices, SessionSettingsPopover, ggufVisionToggle and opt-in ggufQ8Bounded.
