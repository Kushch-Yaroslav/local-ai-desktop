# Experimental model acceleration and memory

This guide describes the bundled llama.cpp runtime in v0.3.2.0. Model and backend detection determine which controls are available.

## Dynamic MoE expert cache

MoE routing selects experts for each token. When supported, llama.cpp keeps expert weights in host memory and caches requested experts in GPU memory. This cache is separate from ordinary GPU layers and KV state. Modes are Standard (no cache), Automatic (bounded estimate for recognized model/backend combinations) and Manual (2, 4, 8, 12 or 16 GiB options when the current VRAM estimate permits them).

The validated model gate is Qwen3-Coder-Next 80B Q4_K_M (qwen3next, 48 blocks, 512 experts) on the bundled CUDA build. This does not establish universal MoE compatibility. A larger cache can improve speed, have no effect or slow generation. CPU and GPU kernels may produce different logits and answers; bit-identical output is not guaranteed.

A historical paired test on an RTX 3090 used an experimental backend and 4K context allocation:

| GPU expert cache | Median decode |
| --- | ---: |
| 0 GiB | 29.07 tok/s |
| 8 GiB | 36.96 tok/s |
| 12 GiB | 46.82 tok/s |
| 16 GiB | 56.25 tok/s |

The 16 GiB result was about 93.5% faster in that test. It is not a guarantee for other prompts, contexts, backends, models or computers. The bundled runtime later loaded this Qwen with 16 GiB cache and 64K Q8 GPU KV and completed a short response. No benchmark filled the full 64K context.

## Advanced layer placement

GGUF metadata provides the block count and tensor names. The grid and range field select ordinary block tensors for GPU placement; for example `3-12, 15, 16-20`. Blocks are not semantic “coding” or “reasoning” layers. Placement uses llama.cpp tensor overrides and supported buffers; incomplete metadata or an unsupported architecture/backend limits the available choices. CPU MoE placement is separate, so expert tensors may stay in RAM regardless of ordinary layer selection.

## Memory and context

The GPU estimate includes known tensor weights, expert cache, attention KV, hybrid recurrent state, compute headroom and a reserve. Runtime logs confirm actual allocations. Q8 KV uses less memory than FP16 but is an independent precision setting.

With explicit mmap and bounded no-repack placement, GGUF pages are file-backed and reclaimable rather than mandatory anonymous allocations. Accessed pages still need physical RAM; eviction can slow inference. The host estimate separates mandatory allocations, runtime headroom and OS reserve, and checks the model cgroup `MemoryMax`. The launcher retains `MemorySwapMax=0`, memory/PSI monitoring, VRAM preflight and a RAM reserve. Global swap-out is diagnostic only and does not independently stop the model.

A 64K allocation does not mean 64K tokens were processed. Qwen has hybrid attention/recurrent state, so its memory is not described by a single generic KV formula.

## Known limitations

- Experimental Alpha, not a stable product.
- MoE acceleration has been validated on a narrow set of models and hardware.
- CPU/GPU answers are not guaranteed to be bit-identical.
- Arbitrary layer placement is constrained by tensor names, architecture and backend buffers.
- Long Agent workflows and all tool sequences have not been exhaustively validated.
- Semantic loops and excessive file exploration may occur.
- Review may delay the Agent final answer until generation is complete.
- mmap working sets can page and reduce speed under memory pressure.
- Some legacy regression scenarios remain failing; see release notes.
- A fully populated 64K context benchmark was not performed.
- Packaging/runtime validation targets Linux x86_64, primarily Ubuntu 24.04 and the tested NVIDIA/CUDA setup. Other GPUs, drivers, distributions and operating systems are not universally supported.
