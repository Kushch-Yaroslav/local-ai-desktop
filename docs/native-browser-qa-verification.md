# Native Live Browser: verification and measurements

Development branch `feature/v0.3-native-browser-qa`, based on P2 `cfa3237`. Electron 39.8.10 / Playwright 1.63.0. No version, release, installed package or user `runtime/` changes. Test projects and model-server state are isolated under `/tmp`; existing model/projector files are read only. No downloads.

## Actual native Chromium acceptance

`node scripts/native-browser.test.mjs` uses the production renderer/IPC and native browser, real Playwright and XTest physical input. The fixture supplies model/control metadata; it does not substitute a fake browser. All 19 native acceptance groups passed, including:

- Exactly one project Page, no preview canvas or frame IPC, no Node or privileged preload.
- Physical input shield while agent owns the page; CDP clicks still work. User clicks, current-layout text entry and native WASD down/hold/up work after handover without replacing the Page.
- Paused ownership, release of held mouse/key input, repeated approved run and background focus preservation.
- Real WebGL red-pixel readback through ANGLE on the RTX 3090.
- Keyboard QA with Shift+w hold, Q repeats and E down/up; native wheel scrolling, Back/Forward/Refresh; before/after PNGs from that Page.
- Six genuinely edited revisions retested beyond the former task QA ceiling; unchanged repetitions blocked with prior evidence; unrelated read still available.
- A pointer-triggered Canvas exception reproduced; repaired fixture retested. This harness repair is scripted, distinct from the real Qwen repair below.
- Internal native navigation, Back, viewport resize, hide/reopen, modal focus, narrow layout.
- Explicit screenshot allowance exhausted without breaking the native surface or QA captures.
- Five open/close cycles leave no native webContents; independent Main origin/network denial and forced debugger disconnect fail closed.

`node scripts/qa-loop-runtime.test.mjs` uses scripted model responses with the real Rust runtime, actual Chromium, source writes and QA. It proves that unchanged QA is blocked locally, accepted explicit user steering permits the same check again, a real permission change permits another check while resending unchanged permissions does not, a real edit permits the same arguments again, and other tools continue without global pause. It is not a real-model inference test.

The guard unit tests cover normalized scenarios, content revisions, ignored runtime/evidence files, changed expectations/state/runtime/permissions, reopen, explicit continuation and alternating outcomes. Rust tests include 100 repeated local QA blockers without escalating to task pause.

## Controlled display comparison

`node scripts/native-browser-performance.test.mjs` loads the actual old hub/component from P2 `cfa3237` in test-only temporary files and compares it with the current native implementation. Two alternating runs per mode, same visible window and animated Canvas source, no model loaded. Raw samples: [performance JSON](test-results/native-browser/performance-comparison.json).

| Metric | Old screencast | Native |
|---|---:|---:|
| Frame IPC messages per ~5.1 s | 51 | 0 |
| Base64 frame payload per ~5.1 s | 3.67 MB | 0 |
| Physical key → changed X11 pixel, median, 6 samples | 127.98 ms | 28.71 ms |
| Scene requestAnimationFrame rate | 60.06–60.14 /s | 143.97–143.99 /s |
| Main UI event → next RAF, median | 0.7 ms | 0.5 ms |
| Main renderer long tasks in sampled interval | 0 | 0 |
| Sum of own Electron + legacy browser RSS | 1339–1358 MiB | 773–786 MiB |
| Main renderer JS heap sample | 16.1 MB | 10.0 MB |
| Screenshot capture | 40.0–65.0 ms | 52.7–69.3 ms |
| Shared desktop GPU snapshot | 22–30%, 1202–1220 MiB, 42–65 W | 26–27%, 836–860 MiB, 84–89 W |

These are short measurements, not a long-running soak or inference benchmark. RAF is not measured compositor presentation FPS. Pixel latency is a polling upper bound from XTest injection to XGetImage, not photon timing. RSS sums double-count shared pages and are not PSS. The old viewport was 1280×900 and native followed the displayed 633×654 surface; Chromium versions and refresh policies differ. Native rendering uses the 144 Hz display and **did not lower power** in this scene. GPU snapshots include the rest of the desktop. No claim is made that this fixes a separate system-wide 100% GPU incident or the cost of an expensive project scene.

`native-workspace.png` is an X11 capture of the actual owned window including the native child. An ordinary screenshot of the parent renderer omits native child surfaces and is deliberately not used as Vision evidence. Vision instead captures the actual project Playwright Page.

## Known boundaries

This implementation retains the existing exact-origin, GET-only project policy; it is not a general unrestricted web browser. Browser-wide CDP operations, new targets, popups, file chooser privileges, downloads and unapproved networking remain unavailable. Real native presentation/physical input was tested on Linux X11; Wayland, other OSes, IME/accessibility integration and long-duration resource soak need further coverage. A visible native surface follows viewport resizing, so responsive layouts can legitimately change.

Vision is probabilistic. Real testing exposed alternating assessments of unchanged content; the negative evidence is retained in [the pre-fix report](test-results/native-browser/qa-outcome-oscillation-before.json). The guard now recognizes recurring outcomes across such oscillations. It suppresses redundant operations and supplies corrective guidance; it cannot guarantee that every model follows that guidance or that every visual assessment is correct. Functional and visual results remain separate and a blocked/partial check never becomes Verified just because a tool returned.

NEXUS/user projects were not edited. The test fixture's WebGL/Canvas checks do not certify arbitrary 3D scenes. The original Qwen3.6 MoE benchmark was not rerun here; real-model native acceptance uses the available Qwen3.8.


## Additional defects and harness corrections

- Real external-JS renderer crash: isolated to native CDP Fetch response delivery. The [negative asset matrix](test-results/native-browser/native-assets-before.json) includes CSS/inline controls and a failure without a global inspector. Resource delivery moved to the isolated session protocol while retaining the shared validator. The ordinary Electron asset regression and original HTML/CSS/JS UI auto-reload test now pass. No GPU/software-renderer workaround or Electron version change was used.
- Legacy browser tests still demanded canvas frames/FPS. They now assert actual animated pixels and zero frame IPC, or delegate to the maintained physical-input native suite. Security denial tests accept Electron's `ERR_FAILED` mapping only alongside a server-side assertion that the forbidden destination received zero requests.
- The early real-model harness incorrectly discarded chat history after a completed run while forwarding confirmed Task Memory references. Rust correctly rejected the unrelated evidence lineage. The fixture now carries canonical user/assistant history. A fast actual Electron/Rust scripted test verifies completion → next run → Stop → continuation with unchanged confirmed observation references; runtime evidence validation was kept intact.
- Read-only `task_memory view` correctly emits no update event. Its actual tool result is inspected rather than interpreting a missing update event as lost memory.
- A previous Resume assertion demanded a wholly Verified report even when an extra model-selected click had no expectation. The [recorded scoped result](test-results/native-browser/resume-scope-before.json) shows the requested keyboard state change passed and the model honestly disclosed partial scope. Current acceptance checks the requested state assertions and records the full visual/functional status separately.
- Test Stop/Pause commands use an isolated file acknowledgement channel to avoid Electron inspector promise garbage collection; model/tool/QA execution remains the actual Rust/runtime path. Electron profiles are isolated under each fixture root.


## Final real Qwen checkpoint / Resume / Stop

`node scripts/native-browser-qwen.test.mjs`: **PASS**, actual local Qwen3.8-27B Q4_K_M, 32,768 context, Q8 K/V, GPU model offload, CPU projector (`--no-mmproj-offload`), MTP `draft-mtp`, two draft tokens. The model server is an owned isolated process. This validates the real backend/tool/browser path; the fixture's control-panel model/hardware metadata are mocked and are not presented as a full real supervisor-load test.

1. An image-only challenge recognized a blue square, red triangle and yellow circle from native captured pixels; none of those labels was supplied through DOM text. HTTP image analysis took **4,429.75 ms**, 400 prompt / 51 completion tokens.
2. Qwen created a plan, reproduced the pointer-triggered exception and stopped RAF before editing, read the file, recorded a confirmed Task Memory finding and used an approved exact `replace_text` to remove `active=false` and the thrown error. Pointer/keyboard handlers were retained; no input substitutes were added.
3. Pause interrupted the post-edit Vision request in the **original active run**. It completed in **1,104.96 ms**, preserving plan IDs, the confirmed observation-backed finding, the verification ledger and native view ID **4**. The interrupted check is **Blocked**, never falsely Verified.
4. Resume used the saved checkpoint and canonical chat history. It performed actual QA on view **4**, verified held W changing `#camera`, a canvas click changing state, continued RAF/draw calls and no JavaScript/NaN errors. Actual PNGs were analyzed. Functional **Verified**, visual **Verified**, overall **Verified**. No successful source edit was repeated; source bytes stayed unchanged.
5. Stop during the following generation emitted the real cancellation event in **403.46 ms**, retaining view **4**. A subsequent read-only run in the same chat completed, performed another QA (Verified) and retained the same page/source.

Real backend metrics across this acceptance session: **5,806 drafted / 3,653 accepted tokens** (~62.92%); aggregate generation **48.44 tokens/s**. These include tool/reasoning/image requests and are not an Off/On speedup benchmark. Total desktop GPU snapshot after the run: **18,448 MiB**, 15%, 183.61 W; server RSS **10,528,512 KiB**, HWM **16,791,004 KiB**. These are samples, not a VRAM peak measurement. After the owned server was stopped: **647 MiB total desktop VRAM**, 11%, 41.06 W, **no compute processes**.

[Real reports, checkpoint/plan, metrics and source](test-results/native-browser/qwen-native-result.json) include saved before/after PNGs. The model's final prose called Playwright headless by habit; actual native view identity and E2E evidence establish headed execution. Tool output now states native headed versus CLI headless provenance explicitly; that addition was checked with real native/CLI tests, without claiming another model behavior test.

## Final validation and readiness

- `npm run build`: passed (Rust build, TypeScript, Vite renderer and Electron Main/preload compilation). Only the existing large-bundle warning remains.
- `npm run typecheck`, `npm run lint`: passed.
- `cargo test --locked --manifest-path rust-agent/Cargo.toml`: **386 passed, 1 ignored** (the repository's default-ignored Chrome dependency test). Real Chromium, Electron and Qwen coverage was run separately.
- QA guard unit tests and actual Rust/Chromium QA-loop integration passed. Permission changes, identical-permission non-progress, explicit user steering, actual edits, two/three-outcome cycles, unrelated work and no global pause are covered.
- Actual Native Browser acceptance: **19 groups passed**; native asset test without a global debug port passed. Exact PID/start-time tracking included six owned Electron/Chromium processes before teardown; **none remained after quit**.
- Actual Electron regression: Compact persistence, pending/applied effort/strategy, Pause, model controls, MTP UI, Vision preselection/restart, QA panel, tooltips, context profiles/validation, narrow layouts and chat switching passed. Model/hardware/SSE fixtures in these tests are explicitly distinct from real Qwen inference.
- Chromium regressions: static/loopback assets, GET/origin/redirect/file/symlink/CSP restrictions, sticky explicit denial, repeated approvals, keyboard/navigation, screenshot separation and automatic reload passed.
- The final display comparison repeated both modes twice; it is a short no-model fixture, not a presentation-FPS or full-VRAM stress benchmark. Initial measurements are retained in [the earlier samples](test-results/native-browser/performance-comparison-initial.json). CPU fields are raw per-process samples; legacy CDP cumulative CPU time and Electron CPU percentage are not combined into a fabricated common percentage.

[Current checks manifest](test-results/native-browser/checks.json) lists successful relevant script runs. Full local logs stay under ignored `artifacts/native-browser/logs/`. Legacy opt-in Qwen control/MoE benchmark scripts were adapted away from frame assumptions but were **not rerun**; the actual real-model acceptance above is Qwen3.8 native E2E. No NEXUS edits, other-model downloads, release/package installation or main merge occurred.

Ready for user testing of the native browser/QA changes. Remaining coverage limits: Wayland/other OSes, long-duration reasoning/full-VRAM UI stress, compositor dropped-frame/presentation metrics and arbitrary NEXUS/WebGL scenes. Vision remains probabilistic even with real pixel input. The work does not claim to repair the separate earlier system-wide GPU incident.


## Git / continuation map

Before interruption, `dad782b`, `4499392` and `3042d3f` provided the architecture plan, native bridge/ownership and initial progress-aware QA. This continuation completed the teardown/focus and alternating-outcome fixes, live control transitions, external-JS delivery correction, true Qwen checkpoint/Resume/Stop acceptance, profile/history harness corrections, security/resource coverage and final measurements.

Local implementation/test commits (the documentation commit follows this list):

- `dad782b` docs: plan native browser and progress-aware QA
- `4499392` feat: embed a scoped native browser with exclusive ownership
- `3042d3f` feat: make browser QA progress-aware with real keyboard actions
- `451d7ba` fix: detect oscillating QA outcomes and allow explicit retests
- `0165383` fix: await native browser teardown and preserve input ownership
- `973a752` fix: reopen QA observation windows after accepted live controls
- `8b23590` fix: serve native browser assets outside CDP Fetch
- `faef542` test: verify native browser provenance and complete process cleanup
- `3c300c2` test: cover native browser ownership, QA recovery and real Qwen resume

Working branch: `feature/v0.3-native-browser-qa`. Only the original untracked user `runtime/` is intentionally left uncommitted after documentation is committed. No merge into main, tags, version change, release or installed .deb update.
