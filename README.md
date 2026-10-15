# Local AI Desktop

[English](README.md) · [Русский](README.ru.md)

An experimental Linux desktop app for local LLM chat and coding tasks. GGUF inference runs through an external llama.cpp server; the interface uses Electron and Agent Runtime V2 uses Rust.

[Published releases](https://github.com/Kushch-Yaroslav/local-ai-desktop/releases) · [Installation](docs/en/GETTING_STARTED.md) · [User guide](docs/en/USER_GUIDE.md) · [Release history](CHANGELOG.md)

Repository documentation describes the current source tree. Published packages may contain an earlier feature set; see the [release status and notes](docs/README.md#release-status).

## What it does

- Local Chat and project-aware Agent workflows, with streaming, attachments, optional read-oriented web tools and rich responses.
- Two projects and `@` file references; task-scoped plans, Task Memory, deliverables and historical verification snapshots.
- Explicit task continuation, Stop/resume and bounded loop recovery that preserves the original execution history.
- **Ask for confirmation** and **Absolute Autopilot**, subject to mandatory filesystem and process protections.
- Isolated terminal execution and managed development-server tasks; scoped, fresh verification evidence.
- Model-aware FP16/Q8 context selection, saved discovery results and runtime telemetry.

See [Features](docs/en/FEATURES.md) for current capabilities and boundaries, [Models](docs/en/MODELS.md) for observed compatibility, and [Roadmap](docs/en/ROADMAP.md) for future work.

## Setup and safety

Linux x86_64 is the current target; Ubuntu 24.04 is the primary tested environment. Supply a compatible `llama-server` and local GGUF weights; neither is bundled. Agent terminal execution also needs the host isolation prerequisites described in [Getting started](docs/en/GETTING_STARTED.md).

Autopilot is not unrestricted host access. Terminal PID isolation, seccomp and filesystem restrictions remain active; the reviewed Ubuntu deployment uses enforcing dedicated AppArmor profiles. Writable project files are real files, host reads are not fully concealed, and networking is shared. See [security boundaries](docs/en/FEATURES.md#security-boundaries). Keep backups and review results.

## Screenshots

Rich Responses combine cards and charts with SVG export. This earlier screenshot remains a useful rendering example; its toolbar predates the current context controls.

![Rich response with cards and a chart](docs/img/interface/4-e.png)

Version-specific Agent, permission and context screenshots live with their [release notes](docs/README.md#release-status), not on this landing page.

## Status and contributions

This is an actively developed personal project. Compatibility depends on the model, llama.cpp build, hardware and workload. [Report issues](https://github.com/Kushch-Yaroslav/local-ai-desktop/issues); include reproduction steps and redacted diagnostics.

**Yaroslav Kushch** — Independent Developer, Zaporizhzhia, Ukraine. [LinkedIn](https://www.linkedin.com/in/yaroslav-kushch-5b937b378) · [Telegram](https://t.me/fivElemen) · [Email](mailto:malborodo123@gmail.com)

## Attribution and license

Parts of transcript handling and context compaction were adapted from [Jan](https://github.com/janhq/jan), by Menlo Research (Apache-2.0). This product includes software developed by Menlo Research (https://menlo.ai). [Qwen-Agent](https://github.com/QwenLM/Qwen-Agent) was studied as a reference. This project is independent and is not affiliated with or endorsed by either project.

Original code: [MIT](LICENSE). Jan-derived portions: Apache-2.0. See [third-party notices](THIRD_PARTY_NOTICES.md), [license texts](licenses/Jan-LICENSE.txt) and [asset attribution](assets/ATTRIBUTION.md).
