# Third-party notices

This application includes source from the Goose project at `cfb67d72f6129ba3c9f68d4c225d8dfcaba18a87`, licensed under Apache-2.0. The source revision's root license identifies Copyright 2024 Block, Inc.; its complete license and retained source copyright notices are included in `LICENSE` and applicable source files. No separate upstream `NOTICE` file was present at that revision. Local AI Desktop is an independent project and is not affiliated with or endorsed by the Goose maintainers.

The previous Local AI Desktop release line remains available in Git history. Its MIT license, prior third-party notice, and historical Fluent UI icon license are preserved as `licenses/LICENSE.local-ai-desktop-MIT.txt`, `THIRD_PARTY_NOTICES.local-ai-desktop.md`, and `licenses/Microsoft-FluentUI-System-Icons-MIT.txt` for provenance. The icon attribution in `assets/ATTRIBUTION.md` is historical; that icon is not part of the current v0.4.0 application. No old application implementation was copied into the initial snapshot. Any donor code added in later commits must retain its applicable notices.

See `PROJECT_UPSTREAM.md` for the immutable source pin and update procedure. Local AI Desktop modifications include product branding, Electron/React UI changes, ACP session and reasoning controls, and managed local GGUF runtime/profile/discovery workflows. Apache-licensed source files retain Goose copyright notices and carry Local AI Desktop modification comments where the file format permits; JSON locale resources cannot contain comments and are covered by this notice. The product is a downstream modification and does not claim Goose source as wholly original work.

The v0.3.2.0 and earlier Local AI Desktop line has a separate MIT license and Jan-derived source attribution retained for its historical code. The current v0.4.0 Goose-based tree does not contain the Jan-derived implementation described in `THIRD_PARTY_NOTICES.local-ai-desktop.md`; that file remains for historical provenance. The current integrated MoE placement code adapted from the previous Local AI Desktop line retains the applicable MIT notice in `licenses/LICENSE.local-ai-desktop-MIT.txt`.

Electron's generated Chromium license page is shipped with the desktop package. This file is not an exhaustive inventory for every transitive binary dependency.

## Integrated local inference additions

The MoE placement and memory calculation core in `ui/desktop/src/moe/` is adapted from Local AI Desktop v0.3.2.0; its MIT notice is retained in `licenses/LICENSE.local-ai-desktop-MIT.txt`. Goose remains the agent runtime.

The application-owned llama.cpp runtime is built from the official ggml-org/llama.cpp revision `5047748f114564fcf271e6a648f60e2d2eae6264` (MIT). Its complete license is shipped as `runtime/llama/LICENSE.llama.cpp`. Redistributed CUDA Runtime and cuBLAS libraries retain the NVIDIA toolkit EULA at `runtime/llama/EULA.CUDA.txt`; the system NVIDIA driver is provided by the host and is not bundled or modified. The Linux CUDA runtime targets sm_86 and requires a compatible NVIDIA driver. Source provenance and build instructions are under `runtime/integrated-llama/` and `scripts/dev/`.
