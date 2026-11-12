# Local AI Desktop

**Stable release: v0.4.1**

Local AI Desktop is an independently developed desktop AI agent based on the open-source [Goose project](https://github.com/aaif-goose/goose). It combines Goose's Rust agent runtime with a desktop workspace for local GGUF inference and project work.

## Install on Ubuntu Linux x64

Download `local-ai-desktop_0.4.1_amd64.deb` and `SHA256SUMS` from the [v0.4.1 GitHub Release](https://github.com/Kushch-Yaroslav/local-ai-desktop/releases/tag/v0.4.1), verify the package, then install it:

```sh
sha256sum -c SHA256SUMS
sudo apt install ./local-ai-desktop_0.4.1_amd64.deb
```

Ubuntu 24.04 x64 is the primary tested environment. On Ubuntu systems that restrict unprivileged user namespaces, Chromium may need the per-application AppArmor rule documented in the [release notes](docs/releases/v0.4.1.md). The Chromium sandbox remains enabled.

The package contains Electron, the Goose backend, the bundled Node/Playwright Live Browser runtime, and the integrated llama.cpp runtime. It does not contain GGUF model weights. Add your own compatible local models in the application. GPU, model, and context support depend on the model files, runtime capabilities, drivers, and available memory.

## Highlights

- Separate Chat and Agent modes. Goose enforces that Chat does not execute tools; Agent tool use follows its configured permission policy.
- Local GGUF inference with an application-managed llama.cpp runtime, configurable inference settings, GPU/CPU offload controls, Flash Attention, and maximum-context discovery.
- Experimental Qwen MTP speculative decoding for compatible models and runtime configurations.
- Native Live Browser with Playwright and MCP integration, visual regions/findings, and typed browser-context attachments.
- Parallel local GGUF subagents with managed llama.cpp, per-session context monitoring, and automatic child-session compaction.
- Sidebar actions for deleting saved chats and project groups while keeping project files.
- Ubuntu x64 packaging and Local AI Desktop launcher integration.

Read the [v0.4.1 release notes](docs/releases/v0.4.1.md), [changelog](CHANGELOG.md), and [upstream notices](THIRD_PARTY_NOTICES.md). Local AI Desktop is independently maintained and is not affiliated with or endorsed by the Goose maintainers. Goose source is licensed under Apache-2.0; see [`LICENSE`](LICENSE), [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md), and [`PROJECT_UPSTREAM.md`](PROJECT_UPSTREAM.md).

Product source, issues, and releases: <https://github.com/Kushch-Yaroslav/local-ai-desktop>
