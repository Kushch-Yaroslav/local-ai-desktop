# Model compatibility and observations

[English](MODELS.md) · [Русский](../ru/MODELS.md) · [Home](../../README.md)

Compatibility depends on the GGUF architecture, llama.cpp build, prompt template and task. A catalog profile is not a certification. Weight quantization and KV-cache precision are separate: Q4 weights do not imply Q4 KV. The current context UI exposes supported FP16 (`f16`) and Q8 (`q8_0`) cache configurations; do not interpret older “FP8” wording as an implemented FP8 selector.

## Current catalog

The source catalog contains `qwen3.8:27b-q4_K_M`, `qwen3.6:35b-a3b-ud-q4_k_m` and `huihui-qwen3.8:27b-ud-dw-q4_k_m`. These are application profile names, not bundled weights. Configure the actual files through Settings. The catalog's context ceiling is a capability hint; real GGUF/backend limits and available memory govern loading. Custom GGUFs are supported subject to backend compatibility. Tool calling, reasoning, vision/projectors and MTP each need separate support.

## Recent real-agent evidence

Qwen3.6-35B-A3B is the model used in the recent Agent V2 acceptance work. A retained October 13 source-run report records real Electron → Rust → llama.cpp/Qwen execution at 65,536 context with Q8 KV: 43 model requests, 78 tool calls, 10 passing Python tests, 5/5 verified deliverables, managed HTTP start/status/stop and successful cleanup. Thirteen rejected calls occurred and were recovered from; this is not a claim of error-free model behavior.

An earlier owner-reported test covered A → independent B → Continue A and reported 26/26 Python tests, 6/6 verified deliverables, successful continuation and working Ask/Autopilot. The user later reported installed-RC2 Qwen Agent tasks, recovery from a previously paused loop, cross-chat continuation and package upgrade on the developer's Ubuntu system. These results are attributed to the user and were not independently reproduced; they do not provide a complete model/runtime/GPU matrix or establish compatibility on other systems. See the [v0.2.0 notes](../releases/v0.2.0.md#validation).

The author's test hardware: Linux/llama.cpp, RTX 3090 24 GB, Ryzen 7 5700X3D, 64 GB RAM. Results do not establish minimum requirements or compatibility on other machines. Historical Qwen3.8-focused development is distinct from this more recent Qwen3.6 acceptance.

## Historical observations, not a current certification matrix

These author-reported figures were not measured under standardized workloads and were not rerun during the documentation audit. Speed measures throughput, not Agent reliability. Incomplete identifiers/settings remain explicitly incomplete.

| Reported model | Historical settings/observation | Reported generation speed |
| --- | --- | --- |
| GPT-OSS 20B | MXFP4 GGUF, about 12.1 GB on disk; reported GPU fit. Not FP16 weights. | ~150–170 tok/s |
| GLM-4.7-Flash | Q4_K; about 64K context; KV type not recorded | ~100 tok/s |
| Qwen3.6-35B-A3B | Q4 weights; about 75K context, Q8 KV | ~100–115 tok/s |
| Qwen 80B Coder | Q8 KV, layers split RAM/VRAM; exact model and weight quantization unconfirmed | ~45 tok/s |
| Gemma 4 | About 64K, FP16 KV; weight configuration unconfirmed | ~35–45 tok/s |
| Devstral Small 2 24B | Q4 weights, about 56K, FP16 KV | ~45 tok/s |
| Qwen3.8-27B | Q4 weights, about 64K FP16 KV; older ~108K “FP8” claim has unconfirmed cache type | ~33–38 tok/s; up to ~55 with MTP in some tests |

Do not promote these observations to release compatibility badges without a reproducible retest. Rich Responses rendering support does not prove that every listed model generates all formats correctly. The author observed unusually long Qwen3.8 xHigh reasoning, sometimes about an hour; this is neither a benchmark nor a recommended default. Start with moderate effort and inspect actual progress.

## Memory and testing limits

FP16 KV uses higher numerical precision and more memory; Q8 reduces memory with possible precision loss. A discovered GPU-fit value is specific to the model, KV mode, backend and measurement conditions. Increasing context does not increase token-generation speed or guarantee better answers. Partial CPU/RAM offload must be supported and configured; recovery from total memory exhaustion is not established.

Automated tests with scripted providers or mocked GPU measurements validate application behavior, not model quality or real GPU capacity. Before release, record the exact GGUF identity, llama.cpp build, requested/effective context and KV, offload settings, hardware and results for the release candidate. See [setup](GETTING_STARTED.md) and the [release checklist](../releases/v0.2.0-checklist.md).
