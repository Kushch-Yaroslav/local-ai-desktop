# Targeted Qwen correctness instrumentation

Use the existing pinned experimental backend5047748. Do not replace production runtime.
`probe.cpp` is an explicit diagnostic LD_PRELOAD module: it returns the original
raw-logit pointer unchanged. A marker file selects a temporary binary capture;
maximum32vectors per named request. No forcing or sampler modification occurs.

Build:

```bash
g++ -std=c++17 -shared -fPIC -O2 -I runtime/experimental-llama-moe/include -I runtime/experimental-llama-moe/ggml/include scripts/moe-diagnostics/probe.cpp -ldl -o runtime/moe-diagnostic-probe.so
python3 scripts/moe-diagnostics/extract-experts.py
g++ -std=c++17 -O2 -I runtime/experimental-llama-moe/ggml/include scripts/moe-diagnostics/tensor.cpp -L runtime/experimental-llama-moe/build/bin -Wl,-rpath,/media/yaroslav/DATA/local-ai-desktop/runtime/experimental-llama-moe/build/bin -lggml -lggml-base -o runtime/moe-tensor-diagnostic
python3 scripts/moe-diagnostics/controls.py
```

The two extracted payloads are one actual Q4_K and one Q6_K expert from the saved
GGUF descriptor inventory. Never commit payloads or full-vocabulary binary dumps.
`tensor.cpp` compares CPU matmul_id, static CUDA, and CUDA slot1, including overwrite
and full-expert byte read-back. This small control explicitly synchronizes before
compute and is not a race stress test.

`run.py` reuses the existing cgroup/watchdog lifecycle and original `/apply-template`.
Set LAD_DIAG_DIR to runtime/moe-diag-baseline or runtime/moe-diag-cache and pass
moe-cache-experiment.py arguments with suite scripts/moe-diagnostics/prompt.json,
repeats2, tokens768, same model/settings as paired A/B. For cache, add
--moe-cache-mib 16384 and LAD_CHECK_UPLOADS=1. Run only one full model at a time.
No sysctl changes are performed by these tools. Root administrative authorization
is not required; GPU commands use the usual authorized host execution mode.

The first baseline freezes exact formatted prompt/token IDs and its output IDs.
Teacher requests re-prefill those identical prefixes with one predicted token at
positions0..15. Free requests independently generate full answers. Teacher batches
are identical across modes but differ from incremental free decoding; do not mix
the two comparisons. Native llama.cpp startup warmup remains enabled: first request
after restart is not guaranteed an empty expert cache. The second free request
follows the teacher probes, so its expert cache has extra history.

Byte checks sample512bytes at beginning/middle/end of selected GPU expert writes,
after existing backend sync calls. Overwritten queued samples are retired, avoiding
incorrect comparisons against stale writes. This is sampled validation, not an
exhaustive proof. Read-back adds timing perturbation and may hide timing-sensitive
races. Positive/negative controls must pass before treating probe results as evidence.

After both runs: `python3 scripts/moe-diagnostics/compare.py` writes compact raw-logit
errors, normalized distribution distances, top-K/ranks and first free divergence.
It never compares free vectors beyond the common prefix. Binary arrays remain in
ignored runtime for re-aggregation and are not printed or committed. The aggregate
report can be annotated with the few GGUF vocabulary pieces using metadata-only
reads. `compare.test.py` verifies metric identities including additive-logit shifts.

No production/backend source patches are required. A successful sample does not
prove universal correctness or exclude asynchronous races. Do not promote cache
to validated integration based solely on these probes.
