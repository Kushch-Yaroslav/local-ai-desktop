# Live Browser: real Qwen acceptance and inference discovery

## Observed connection chain (2026-11-09)

The selected provider in `/media/yaroslav/DATA/Local-AI-Desktop/data/goose-dev/goose-backend/config/config.yaml` is `custom_qwen27b-3_8___7862b695`. Its custom provider metadata selects OpenAI-compatible `local-gguf` at `http://127.0.0.1:32849`.

This is **the managed gateway**, not the llama.cpp worker's ephemeral port. `ui/desktop/src/managedGguf.ts:prepare/persistGateways/route` persists gateway ports and credentials in the Electron data root's `gguf-endpoints.json`. `route` authenticates the client, serializes runtime requests, then forwards to the resident worker with its separate credential. The worker key is in `LLAMA_API_KEY`; neither credential belongs in logs or Git. `GET /v1/models` is metadata-only and does not activate a model. A POST can activate a lazy profile, so tests require a matching resident llama-server before using the selected gateway.

The old `/proc`-only discovery did not inspect this chain. It also cannot see host processes from the restricted Codex PID namespace. `tests/e2e/goose-seed.ts:discoverManagedGateway` now checks the selected profile, authenticated gateway metadata and the matching resident GGUF process. A configured but unavailable selected gateway does not fall back to a different loaded model. Secrets reach the short probe over stdin, not process arguments.

## What actually responded

At approximately 16:18–16:21 Kyiv time, authenticated GETs to all four persisted gateways returned TCP `ECONNREFUSED`, including Qwen's `127.0.0.1:32849`. This was reproduced **on the host through the IDE terminal**, PID namespace `4026531836`, not just the restricted execution namespace. No primary Electron, Goose or llama-server was present in the host process inventory. Subsequent checks found only the explicitly isolated QA applications.

The primary profile's `electron/logs/main.log` records its last start at 16:09:40 and `Terminating goose serve` at **16:10:20**. The primary app was not stopped by this task. The profile/configuration clearly exists; its availability at another time is not disputed. An HTTP authorization decision or model completion could not be tested while the TCP listener was absent. Authorization was not disabled or bypassed.

An asynchronous request asked the user to start the usual app and load its selected Qwen. No second model/server was launched by the task.

## Real-model acceptance test

`ui/desktop/tests/e2e/live-browser-qwen-fix.spec.ts` is a separate, non-scripted test. It:

- requires the selected, already-resident model; makes one short authenticated probe;
- creates a disposable React/Vite project with a clipped product title;
- uses the normal DirSwitcher, native Page, region selection and compact attachment;
- submits only **«Исправь это»**, without supplying the component filename;
- records real provider requests through an authenticated, sequential local pass-through;
- waits for actual edits and checks the original area against source revisions on the same Page;
- retains request/tool evidence and UI history as ignored test artifacts.

The pass-through never fabricates completions. The scripted provider in `live-browser-context.spec.ts` remains a **protocol/ledger/vision test**, not Qwen evidence. Its manual fixture source change is explicitly labelled as such.

Current real-Qwen result: **BLOCKED / setup FAIL before inference**. A strict host run at approximately 21:32 Kyiv again found the selected gateway unreachable and no matching resident llama-server; no model request was issued. Autonomous source discovery/editing, accuracy of Qwen's repair and confinement of its actual edits are therefore unconfirmed. Do not convert a skipped test or protocol fixture into a PASS.

## Minimal next action

Start **Local AI Desktop — Goose Dev** normally and load **Qwen27B-3.8**. Leave that model resident. Then run the real-model spec from a host terminal with the checked package (the isolated test configuration will reuse the existing gateway). The test never starts llama-server. See the current handoff for the exact checked build and commands.

The model request uses the existing profile's capabilities; it does not enable a projector or reload weights to force Vision. A text-only Qwen can use URL, DOM and source scope. A true multimodal/provider matrix remains separate acceptance work.
