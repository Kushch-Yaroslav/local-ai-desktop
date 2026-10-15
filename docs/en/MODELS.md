# Models and context

[English](MODELS.md) · [Русский](../ru/MODELS.md) · [Home](../../README.md)

Local AI Desktop runs local GGUF model files through an external `llama-server`. The app does not include or download models. Compatibility depends on the model architecture, the server build, your hardware and the task.

## Choose and configure a model

Install a compatible `llama-server`, then select its executable and your GGUF file in **Settings → Models and runtime**. Some vision models also need a projector file. Tool use, reasoning controls, image input and speculative decoding (MTP) depend on support in both the model and server.

The built-in catalog provides starting profiles for selected Qwen models. A profile is not a copy of the model and does not certify compatibility. You can configure other GGUF files if your server supports them.

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
