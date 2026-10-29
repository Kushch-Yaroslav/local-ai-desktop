# Local AI Desktop

[English](README.md) · [Русский](README.ru.md)

Local AI Desktop is an experimental Linux app for chatting with local language models and asking an AI agent to work on your code. Your model runs on your computer through `llama.cpp`; the Agent can work with a selected project and report the checks it ran.

**v0.3.0 Experimental Alpha** adds Browser Workspace for local web projects, selectable page regions, and progressive reading of long text documents.

[Release notes](docs/releases/v0.3.0.md) · [Getting started](docs/en/GETTING_STARTED.md) · [User guide](docs/en/USER_GUIDE.md) · [Documentation](docs/README.md)

## Watch the demo

![](GITHUB_ATTACHMENT_URL_PENDING)

**Scripted demonstration. No live model inference.**

## What you can do

- Chat with a local GGUF model and attach supported files.
- Ask the Agent to explore a project, make changes, run checks and show its results.
- Open a running local web project in Browser Workspace, adjust its viewport and select one or more regions to discuss changes.
- Ask Chat to read a long supported text document progressively, then request a summary or follow-up.
- Save Agent tasks and continue them later; review plans, progress and verification results.

Select a part of a page, then describe the change you want. A text-only model does not directly see browser pixels: it may use region details, page elements and project sources; image input depends on the selected model and vision settings. Browser Workspace is intended mainly for local projects, not as a secure general-purpose browser. Start the project's dev server yourself if needed.

## Screenshots

![A local web project open beside Chat in Browser Workspace](docs/img/releases/v0.3.0/browser1.png)

![A long TXT document being read with visible progress](docs/img/releases/v0.3.0/book.png)

[More v0.3.0 screenshots and details](docs/releases/v0.3.0.md#browser-workspace).

## Install

Download `local-ai-desktop_0.3.0_amd64.deb` and `SHA256SUMS` from the [v0.3.0 GitHub Release](https://github.com/Kushch-Yaroslav/local-ai-desktop/releases/tag/v0.3.0), verify the checksum, then install:

```sh
sudo apt install ./local-ai-desktop_0.3.0_amd64.deb
```

The supported target is Linux x86_64; Ubuntu 24.04 is the primary tested environment. You need a compatible `llama-server` and local GGUF model files; they are not included. Agent terminal use requires administrator-authorized Bubblewrap and enforcing AppArmor setup. Never launch the app with `sudo`.

## Current limitations

This is an **Experimental Alpha**, not a stable or production-ready release. Model support and results depend on the GGUF, `llama.cpp`, hardware and task. Agent changes affect real project files, so review them and keep backups. Terminal isolation is mandatory, but readable host files and network access are not a privacy boundary. Other Linux distributions, ARM systems, GPUs and drivers have not been broadly validated.

See [Features](docs/en/FEATURES.md), [Getting started](docs/en/GETTING_STARTED.md), [User guide](docs/en/USER_GUIDE.md), and [all documentation](docs/README.md). Русская версия: [описание v0.3.0](docs/releases/v0.3.0.ru.md).

## License

Original code is available under MIT; portions adapted from Jan are under Apache-2.0. See [LICENSE](LICENSE), [third-party notices](THIRD_PARTY_NOTICES.md), and [asset attributions](assets/ATTRIBUTION.md).
