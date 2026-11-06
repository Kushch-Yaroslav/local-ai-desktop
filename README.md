# Local AI Desktop

**Version checkpoint: v0.4.0-alpha.1 — experimental, not a stable release.**

Local AI Desktop is an independently developed desktop AI agent based on the open-source [Goose project](https://github.com/aaif-goose/goose). This checkpoint moves the application to Goose's Rust agent runtime and Electron/React desktop while adding a Local AI Desktop integration for managed `llama.cpp` / `llama-server` GGUF models.

The migration is in progress. Not all features and data compatibility from the previous Local AI Desktop v0.3.2.0 architecture have been carried forward. Live Browser and additional legacy features remain in development. The project's priority is running an AI agent locally on the user's hardware; Goose also supports local model providers, and this downstream project adds its own runtime management and GGUF workflows.

See the complete [v0.4.0-alpha.1 checkpoint notes](docs/releases/v0.4.0-alpha.1.md) in English and Russian. This is an intermediate technical checkpoint, not a completed user release. No GitHub Release is associated with this checkpoint.

Local AI Desktop is independently maintained and is not affiliated with or endorsed by the Goose maintainers. Goose source is licensed under Apache-2.0; see [`LICENSE`](LICENSE), [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) and [`PROJECT_UPSTREAM.md`](PROJECT_UPSTREAM.md).

Product source, issues and future releases: https://github.com/Kushch-Yaroslav/local-ai-desktop

The v0.1–v0.3.2.0 product history, source and tags remain available in this repository. Historical Local AI Desktop and Jan attributions remain preserved for that release line.
