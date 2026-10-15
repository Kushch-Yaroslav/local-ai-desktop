# Local AI Desktop

[English](README.md) · [Русский](README.ru.md)

Local AI Desktop is an experimental Linux app for chatting with local language models and asking an AI agent to work on your code. Your model runs on your own computer through `llama.cpp`; the agent can read and edit a selected project, run commands in an isolated terminal, and show what it checked.

It brings local AI chat and coding work into one desktop app, with saved conversations and tasks. You choose the model and project, and you stay in control of permissions and changes.

[Download v0.2.0](https://github.com/Kushch-Yaroslav/local-ai-desktop/releases/tag/v0.2.0) · [Getting started](docs/en/GETTING_STARTED.md) · [User guide](docs/en/USER_GUIDE.md) · [Documentation index](docs/README.md)

## What you can do

- Chat with a local GGUF model and attach supported files.
- Ask the Agent to explore a project, make changes, run checks and report its results.
- Save task plans and verified results, switch chats, then continue a task later.
- Choose whether the Agent asks before actions or uses Absolute Autopilot within the same enforced boundaries.
- View rich answers with tables, charts and diagrams, and export charts as SVG.
- Choose FP16 or Q8 context settings and discover model-specific context sizes that loaded successfully.

See [Features](docs/en/FEATURES.md) for the current scope and limits.

## Screenshots

Continue saved work from another chat. The task menu lets you return to a saved task or start a new one.

![Saved plan and verified deliverables with the Continue this task action and task selector](docs/img/releases/v0.2.0/continue.png)

Rich Responses can combine cards and charts, with SVG export.

![Rich response with cards and a chart](docs/img/interface/4-e.png)

## Requirements

The supported target is Linux x86_64; Ubuntu 24.04 is the primary tested environment. You need a compatible `llama-server` build and local GGUF model files. They are not included in the app. Agent terminal commands also require Bubblewrap 0.9.0 or later and enforcing AppArmor 4.0.0 or later. Other distributions, ARM systems, GPUs and drivers have not been broadly validated.

## Download and install

Download the amd64 `.deb` from the [v0.2.0 Experimental Alpha release](https://github.com/Kushch-Yaroslav/local-ai-desktop/releases/tag/v0.2.0), then install it from the directory where you saved it:

```sh
sudo apt install ./local-ai-desktop_0.2.0_amd64.deb
```

An administrator must authorize each desktop account for Agent terminal use. See [Getting started](docs/en/GETTING_STARTED.md) for the required setup and verification. Never launch the desktop app with `sudo`.

## Quick start

1. Install the app and complete the Agent isolation setup in [Getting started](docs/en/GETTING_STARTED.md).
2. Install a compatible `llama-server` and choose its location and your GGUF model in **Settings → Models and runtime**.
3. Select a context and KV-cache type, load that configuration, and wait for the model to be ready.
4. Start a chat. To work on code, select a project and switch to Agent. Begin with **Ask for confirmation** while you learn how its actions work.

The [User guide](docs/en/USER_GUIDE.md) explains the controls and common workflows.

## Current limitations

This is an Experimental Alpha. The app does not download models, and model compatibility depends on the GGUF, `llama.cpp`, hardware and task. Agent changes affect real project files, so review them and keep backups. Terminal isolation is mandatory, but it is not a privacy boundary: readable host files may remain visible and network access is shared. Unsupported terminal startup fails closed. A clean installation and broad distribution compatibility have not been independently verified.

## License

Original code is available under MIT; portions adapted from Jan are under Apache-2.0. See [LICENSE](LICENSE), [third-party notices](THIRD_PARTY_NOTICES.md), and [asset attributions](assets/ATTRIBUTION.md).

## Project

This is an independently developed open-source project. [Report an issue](https://github.com/Kushch-Yaroslav/local-ai-desktop/issues) with reproduction steps and redacted diagnostics.
