# Real-activation cache correctness replay

Pinned backend5047748; no llama.cpp source or production binary patches.

1. Build capture.cpp as a shared diagnostic module with -shared -fPIC and includes
   ggml/include, vendor. Run one24-token saved explain request using the existing
   bounded run.py, LAD_DIAG_PRELOAD pointing at the capture module,
   LAD_CAPTURE_DIR/LAD_DIAG_DIR=runtime/moe-activation-fixtures, LAD_SKIP_TEACHER=1.
2. `python3 scripts/moe-activation/prepare.py` attaches GGUF descriptor offsets and
   verifies that24output IDs match the saved baseline. Callbacks split execution at
   chosen nodes and read inputs before later operations can reuse their memory.
3. Compile replay.cpp with includes src/include/ggml/include/vendor from the pinned
   checkout and link -lllama -lggml -lggml-cpu -lggml-base against its build/bin.
   Then run run-replays.py inside MemoryMax4G/MemorySwapMax0.

Capture is six MUL_MAT_ID operations (gate/up/down in layers0,1), all at the first
incremental decode, same prefix. Input F32, original selected IDs and op parameters
are immutable fixtures. Inputs/output/IDs are small binaries; do not commit weights.
The metadata-only model uses no_alloc=true and n_gpu_layers999 solely to assign the
chosen fixture's cache device to CUDA (including layer0, CPU-assigned in the original
ngl48 full-model config). Only one expert tensor is allocated; all other expert
pointers are removed from this isolated metadata model before cache construction.
This does not run or allocate the full model on GPU.

Replay calls the ACTUAL exported llama_moe_cache constructor/copy/get_experts/get_slot_map
and GGML GET_ROWS slot lookup. No reimplementation of SLRU/eviction/upload is used.
One original CPU tensor and one static CUDA tensor have512expert descriptors but
only the20needed payloads are read from original GGUF. The native cache has10slots.
Static and cache paths receive exactly the same input bytes/IDs/op parameters.
Weights remain Q4_K or Q6_K in all three main paths.

States: original IDs miss, hit, disjoint control IDs miss/evict, original IDs reuse
miss, hit-after-reuse. Disjoint control IDs are not a captured router decision;
they stress eviction using real weights with fixed captured inputs. There is no
harness synchronization between native cache uploads and graph launch. Sync occurs
AFTER graph execution before host output consumption; an early harness omitted this
mandatory output wait and produced stale metrics. That harness bug was corrected,
not an upstream cache bug. All selected expert bytes are checked only after output.

The native per-op logs must show hits20/misses30/slots10. CPU output for original
IDs must equal captured output bitwise; static CUDA and cache CUDA must match bitwise.
Output metrics include abs/MAE/RMSE, norm-relative errors, norms, counts above
1e-6/1e-4/1e-3/1e-2. No unstable elementwise relative division near zero is used.

A SEPARATE oracle dequantizes original weight rows to float and accumulates products
with unchanged captured F32 activations in double. It does not replace any main
comparison or alter GGUF quantization. Its error metrics assess kernel approximation.

Optional --tool memcheck/racecheck/synccheck --fixture FILE invokes installed CUDA
Compute Sanitizer on this small replay with watchdog and timeout. Racecheck covers
CUDA shared-memory hazards, not a universal proof about global/cross-stream races.
The sequential replay does not cover all full-model scheduler concurrency, multiple
layers sharing a cache group, every expert, every activation or every architecture.

LAD_TARGET_STEP=20 in run.py performs ONE teacher-forced prediction on the frozen
baseline prefix. This is a prefill comparison, not free-decoding logits. It is not
by itself causal attribution of the entire full-model logit difference.
