#!/usr/bin/env bash
set -euo pipefail
root="$(cd -- "$(dirname -- "$0")/.." && pwd)"
cd "$root"
state=runtime/qwen-ab-swappiness.json
stop=runtime/qwen-ab-swappiness.stop
python3 - "$state" <<'PY'
import json,sys,time
from pathlib import Path
s=json.loads(Path(sys.argv[1]).read_text())
assert s['status']=='active' and Path('/proc/sys/vm/swappiness').read_text().strip()=='0', 'No authorized active session'
assert time.time() < s['started_unix']+s['duration_seconds']-120, 'Session expires too soon'
PY
cleanup() {
 touch "$stop"
 for attempt in {1..20}; do
  if python3 - "$state" <<'PY'
import json,sys
from pathlib import Path
s=json.loads(Path(sys.argv[1]).read_text())
assert s['status']=='restored' and int(Path('/proc/sys/vm/swappiness').read_text())==s['original']
PY
  then return; fi
  sleep 0.5
 done
 echo 'ERROR: verify swappiness restoration manually' >&2
 return 1
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
for budget in 0 8192 12288 16384; do
 systemd-run --user --scope --property=MemoryMax=51G --property=MemorySwapMax=0 timeout --signal=TERM --kill-after=20s 420s python3 scripts/moe-cache-experiment.py \
 --server "$root/runtime/experimental-llama-moe/build/bin/llama-server" \
 --model /media/yaroslav/01D9B3596C5596B0/LINUX-LLM/Qwen3-Coder-Next-80B-Q4/Qwen_Qwen3-Coder-Next-Q4_K_M.gguf \
 --outdir "docs/experiments/advanced-placement-moe/qwen-ab-cache${budget}" \
 --suite scripts/moe-ab-prompts.json --alternate-order --moe-cache-mib "$budget" \
 --load-mode dio --no-repack --no-host --lazy-mode off \
 --ctx 4096 --tokens 768 --repeats 2 --verbosity 4 --min-available-gib 7 \
 --startup-timeout 80 --request-timeout 60 --require-swappiness-zero
 done
