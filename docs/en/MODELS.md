# Models and context

[English](MODELS.md) · [Русский](../ru/MODELS.md) · [Home](../../README.md)

Local AI Desktop runs local GGUF model files through an external `llama-server`. The app does not include or download models. Compatibility depends on the model architecture, the server build, your hardware and the task.

## Choose and configure a model

Install a compatible `llama-server`, then select its executable and your GGUF file in **Settings → Models and runtime**. Some vision models also need a projector file. Tool use, reasoning controls, image input and speculative decoding (MTP) depend on support in both the model and server.

The built-in catalog provides starting profiles for selected Qwen models. A profile is not a copy of the model and does not certify compatibility. You can configure other GGUF files if your server supports them.


## Model families and reasoning

Profiles keep detected GGUF family separate from a manual selection. Auto detect uses metadata, then the chat template. Choices include Qwen, GPT-OSS, Gemma, GLM, Devstral/Mistral, Llama and Other/Custom. An override can correct classification; it cannot manufacture backend or template support.

Qwen Thinking On/Off requires a matching template parameter. GPT-OSS Harmony uses Low/Medium/High Reasoning Effort and analysis/final channels, without a mandatory Qwen-style toggle. Effort changes the actual `reasoning_effort` request parameter. Agent Strategy belongs to the application and is independent of model-specific reasoning controls. Tool calling is declared separately; successful plain Chat does not establish Agent reliability.

## CPU/GPU offload and lifecycle

Model settings group reasoning, memory/acceleration, management and author observations separately. **Save changes** stores a pending profile without stopping the model. **Apply and restart** validates settings and restarts only the application-owned llama-server, preserving Electron, history and checkpoints. **Unload model** frees model resources; pause an active Agent safely first. Unrelated servers are not stopped; GGUF and disk KV-cache files are not deleted.

GPU Layers controls ordinary layer offload. Automatic uses supported `--fit` with VRAM headroom. Advanced MoE can keep all expert weights or experts of the first N layers on CPU (`--cpu-moe`, `--n-cpu-moe`) when the current build and GGUF support it. This is not individual expert assignment. Active MoE parameter count is not the full stored-weight footprint.

Additional controls cover CPU threads, batch/microbatch, Flash Attention, mmap/load mode, context, KV precision and placement. Tensor-specific offload uses bounded `--override-tensor` pattern → buffer rules; applicability depends on actual tensor names, devices and backend. Real CLI flags are checked using `--help`, rather than assumed across versions. Actual launch arguments remain available in technical details.

Weights, KV, compute buffers, CUDA graphs, temporary allocations and Electron/Chromium all consume VRAM. Seeing 22.3 of 24 GB used does not guarantee the next buffer fits: allocation size, peaks and allocator state matter. One VRAM reading cannot establish the cause of a particular CUDA OOM or prove fragmentation. More offload does not guarantee higher speed. A failed apply attempts to restore the exact previous working configuration; prior-attempt diagnostics remain separate from a successfully loaded state.

The author’s saved log from 19 October 2026 shows GPT-OSS-120B attempts with 14 GPU layers and 32K Q8 reaching compute-graph reservation for microbatch 512. The next **651.30 MiB** allocation failed with CUDA OOM (`failed to allocate compute pp buffers`). This is concrete compute-memory evidence, not proof of fragmentation. A total VRAM indicator alone does not describe this allocation. See the [preserved read-only extract](../test-results/model-profiles-v2/gptoss/historical-14-layer-compute-oom.txt).

## Context size and KV cache

Context size is the amount of conversation and task information the model can consider at once. Larger context needs more memory and does not automatically make answers faster or better.

The app offers supported context sizes and two KV-cache choices:

- **FP16** keeps more numerical precision and uses more memory.
- **Q8** uses less memory, with a possible precision tradeoff.

KV-cache precision is separate from model-weight quantization. For example, Q4 model weights do not mean the KV cache is Q4.

Context discovery tries selected configurations and records which ones loaded for the current model, cache type and measured conditions. Treat the result as a useful starting point, not a promise: a different server build, driver, workload or memory state can change what fits. The selected configuration must be loaded explicitly. If it fails, choose a smaller supported context or adjust GPU layers yourself; the app does not guarantee an automatic fallback.

## Memory and practical limits

Memory use depends on model weights, context size, KV precision, GPU offload and workload. Partial CPU/GPU offload can help when supported by your server, but may be slower. A successful load does not guarantee every later prompt will fit, and recovery from total memory exhaustion is not guaranteed.

Model catalog entries and old speed reports are not compatibility ratings or benchmarks. Start with a moderate context and reasoning setting, try a representative prompt, and increase settings only while the system remains responsive. Vision needs a compatible model and projector; image support does not move the entire model to a different device.

For installation steps, see [Getting started](GETTING_STARTED.md). For broader feature boundaries, see [Features](FEATURES.md).


## Author hardware and historical observations

Linux, CUDA llama.cpp, **NVIDIA RTX 3090 24 GB VRAM, AMD Ryzen 7 5700X3D, 64 GB DDR4**. This is the author's hardware, not Local AI Desktop minimum requirements. The observations below were restored from the [historical MODELS.md](https://github.com/Kushch-Yaroslav/local-ai-desktop/blob/b2ec86c2f73d4b914b032c80afc432fcfb5edf16/docs/en/MODELS.md). They are not a standardized comparative benchmark. Unknown conditions were not filled with assumptions.

| Model as reported | Configuration / observation | Generation speed |
| --- | --- | ---: |
| GPT-OSS 20B | GPT-OSS-20B MXFP4 GGUF (about 12.1 GB on disk in the historical record); reported to fit in GPU memory. “Full precision” was imprecise shorthand and does not mean FP16 weights. | ~150–170 tok/s |
| GLM-4.7-Flash | Q4_K GGUF; approximately 64K context. KV-cache type was not recorded here. | ~100 tok/s |
| Qwen3.6-35B-A3B | Q4 weights; approximately 75K context with Q8 KV cache. | ~100–115 tok/s |
| Qwen 80B Coder | Q8 KV cache; model layers split between RAM and VRAM. Exact model identifier/weight quantization needs confirmation. | ~45 tok/s |
| Gemma 4 | Approximately 64K context with FP16 KV cache. Weight precision/quantization needs confirmation. | ~35–45 tok/s |
| Devstral Small 2 24B | Q4 weights; approximately 56K context with FP16 KV cache. | ~45 tok/s |
| Qwen3.8-27B | Q4 weights; approximately 64K with FP16 KV, up to approximately 108K with FP8 KV. | ~33–38 tok/s standard; up to ~55 tok/s with MTP in some tests |
| GPT-OSS-120B | Preliminary user observation: Q4_K_M GGUF split into two files, about 62.9 GB total in the file manager. RTX 3090 24 GB + 64 GB DDR4. 12 GPU layers loaded; 14 caused CUDA OOM. 32K with Q8 KV was used in one successful run. Tool calling is checked in the profile; reliability needs a separate test. | ~11 tokens/s |

Historical Qwen3.8 FP8 KV is retained as recorded; it is not silently renamed Q8. The exact FP8 runtime flag was not recorded. Q4 weights and Q8/FP16/FP8 KV are independent concepts. Gemma weight quantization and the exact historical Qwen 80B Coder identifier remain unknown.

Full GPU placement and partial CPU/GPU offload have different memory and speed costs. Partial offload is an intentional configuration, not inherently a failure. Successful Chat use of other models predates Rich Responses; Agent, tools, context and long tasks were tested most extensively on Qwen3.8-27B. Renderer support does not prove each model generates correct structured output.

## Author GPU layer starting points

| Model | GPU layers / observation |
| --- | --- |
| Qwen3.8-27B Q4 | 999 |
| Qwen3.6-35B-A3B Q4 | 999; current catalog name, no duplicate Qwen3.5 profile |
| GPT-OSS-20B MXFP4 | 999 |
| GLM-4.7-Flash Q4 | 999 |
| Gemma 4 31B | 999, depends on quantization and context |
| Devstral Small 2 24B Q4 | 999 |
| Qwen3-Coder-Next 80B MoE | Layer count unconfirmed; do not silently equate it with the incomplete historical Qwen 80B Coder record |
| GPT-OSS-120B Q4_K_M | 12 loaded; 13 experimental; 14 CUDA OOM |

`999` requests maximum possible offload; it does not guarantee placement. GPT-OSS-120B at 13 layers is not declared stable. **Use as a starting point** in **Author-tested configurations** updates only the pending configuration and does not restart the model. Applicability uses architecture, quantization and model metadata/shape, not just the filename. Unknown fields remain unknown. Historical author observations and tests on the current build are separate facts.

## Limitations and links

Historical prompts, tasks, runtime versions, filled-context size and measurement methods were not standardized. Generation speed does not measure reasoning quality or Agent reliability. Qwen3.8 MTP acceleration was observed in individual tests, not guaranteed. GPT-OSS-120B is a preliminary user record, not an official benchmark. Git history is preserved.

See [Getting started](GETTING_STARTED.md), [Features](FEATURES.md) and the [Scenario QA report](../scenario-aware-qa-verification.md).
