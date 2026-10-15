# Features

[English](FEATURES.md) · [Русский](../ru/FEATURES.md) · [Home](../../README.md)

Local AI Desktop combines a local-model chat with an agent that can work in a selected code project. The app is experimental; what a model can do depends on its files, runtime, hardware and instructions.

## Chat and answers

- Run compatible GGUF models through an external `llama-server`. Choose model files and runtime settings in the app.
- Stream answers, stop generation, edit a prompt and regenerate a response. Some reasoning controls depend on the model.
- Attach supported documents and code. Images require a model and projector that support vision. The app extracts supported document formats locally; it does not perform OCR or calculate spreadsheet formulas.
- View rich answers with cards, tables, charts, diagrams and image galleries. These formats help present information; they do not guarantee that a model's claims are correct.
- Optionally use web search and read web pages. These tools do not automate a browser or submit forms, and web content can be untrusted.

## Coding tasks

Choose a project and ask the Agent to inspect files, make edits and run checks. It can create a plan, track deliverables and show verification results. File changes are real changes to your project, so review them and keep backups.

Tasks are saved separately from chats. You can switch to another chat or task and later continue saved work. The plan, progress and recorded check results remain available; continuing starts a new attempt and leaves the previous attempt in the history. Stop cancels ongoing work, but does not undo edits already made.

The Agent can run terminal commands inside a required Linux sandbox. Some commands and developer tools that need unsupported system access may be blocked. Agent file access follows the selected project scope; terminal isolation and file-tool permissions are separate safeguards.

## Permissions and recovery

The app offers two modes:

- **Ask for confirmation** requests approval for changes and command execution.
- **Absolute Autopilot** avoids routine prompts for actions allowed within the current project and task scope.

Both modes keep the same mandatory filesystem and process protections. Autopilot does not grant broader access. Some actions remain blocked, and grants can be revoked. Approval does not reverse work already completed.

If the Agent repeats the same unproductive actions, the app gives it corrective guidance and may retry with the repetitive part left out of the next model request. If it cannot identify a safe recovery, or bounded recovery attempts fail, the task pauses for you. The original history remains available.

The Agent reports checks it actually ran, such as tests or builds. A passing check only supports the files and behavior it covered; it is not a guarantee that all changes are correct.

## Context and memory

Choose FP16 or Q8 KV-cache precision and a context size supported by your model and runtime. FP16 uses more memory; Q8 can reduce memory use with a possible precision tradeoff. Context discovery tries configurations and records which ones loaded under the measured conditions. It is a practical guide, not a guarantee that the same settings will fit after hardware, model or runtime conditions change.

Task Memory keeps useful notes for the same task. It is not shared learning across unrelated tasks. Context compaction can omit details from older conversation history.

## Security boundaries

The Agent terminal is supported on Linux x86_64; Ubuntu 24.04 is the primary validated environment. The reviewed setup requires Bubblewrap, Linux namespaces, seccomp and enforcing AppArmor profiles. If isolation cannot start, the terminal refuses to run.

This is not a privacy sandbox: host files readable by your account may remain visible, and the terminal shares the host network. Resource use is not fully isolated, and some development tools will not work. Read the [getting started instructions](GETTING_STARTED.md) before using Agent terminal features. Advanced details are in the [security and installation references](../README.md#advanced-technical-references).

## Not available

The app does not include or automatically download models, provide general browser automation, perform OCR, offer a universal undo for agent edits, or coordinate multiple agents. These items should not be assumed to work unless a future release documents them.
