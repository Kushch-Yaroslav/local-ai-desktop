#!/usr/bin/env bash
set -euo pipefail
root="$(cd -- "$(dirname -- "$0")/.." && pwd)"
cd "$root"
for budget in 0 8192 12288 16384; do
 systemd-run --user --scope --property=MemoryMax=51G --property=MemorySwapMax=0 timeout --signal=TERM --kill-after=20s 1200s python3 scripts/moe-cache-experiment.py \
 --server "$root/runtime/experimental-llama-moe/build/bin/llama-server" \
 --model /media/yaroslav/01D9B3596C5596B0/LINUX-LLM/Qwen3-Coder-Next-80B-Q4/Qwen_Qwen3-Coder-Next-Q4_K_M.gguf \
 --outdir "docs/experiments/advanced-placement-moe/qwen-suite4k-cache${budget}" \
 --suite scripts/moe-evaluation-prompts.json --moe-cache-mib "$budget" \
 --ctx 4096 --tokens 512 --repeats 2 --verbosity 4 --min-available-gib 7 --startup-timeout 500
 done
