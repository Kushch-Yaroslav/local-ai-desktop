#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
fixture="$(mktemp -d)"
trap 'rm -r -- "$fixture"' EXIT
# Exercise the production monitor/state writer with a fixture-owned child.
# No launcher, GPU allocation, or user process is touched.
python3 - "$root/run-local-ai-desktop-llama-cpp-mtp.sh" "$fixture/functions.sh" <<'PY'
import re,sys
source=open(sys.argv[1]).read()
names=['timestamp','log','json_escape','process_start_time','write_state','check_server_lifecycle']
with open(sys.argv[2],'w') as out:
 for name in names:
  match=re.search(r'^'+name+r'\(\) \{.*?(?:^\}|\}\s*$)',source,re.M|re.S)
  assert match, name
  out.write(match.group()+'\n')
PY
source "$fixture/functions.sh"
STATE_FILE="$fixture/state.json"; LOG_FILE="$fixture/launcher.log"
SERVER_LOG="$fixture/server.log"; SERVER_PID_FILE="$fixture/server.pid"
ACTIVE_MODEL="test-model"; ACTIVE_CONTEXT=110592; ACTIVE_KV_TYPE=q8_0
ACTIVE_KV_OFFLOAD=1; ACTIVE_SPECULATIVE_MODE=mtp; ACTIVE_PROJECTOR_DEVICE=gpu
printf 'fixture server diagnostic\n' > "$SERVER_LOG"
bash -c 'exit 17' &
SERVER_PID=$!
printf '%s\n' "$SERVER_PID" > "$SERVER_PID_FILE"
write_state ready
for _ in {1..100}; do
  check_server_lifecycle
  [[ -z "$SERVER_PID" ]] && break
  sleep 0.01
done
[[ -z "$SERVER_PID" && ! -e "$SERVER_PID_FILE" ]]
grep -q 'status=17 unexpected=true' "$LOG_FILE"
grep -q 'fixture server diagnostic' "$LOG_FILE"
node - "$STATE_FILE" <<'JS'
const assert = require('node:assert/strict');
const state = JSON.parse(require('node:fs').readFileSync(process.argv[2], 'utf8'));
assert.equal(state.status, 'offline');
assert.equal(state.modelId, '');
assert.equal(state.contextWindow, 0);
assert.equal(state.serverPid, 0);
assert.match(state.error, /status=17/);
JS
# An idle monitor is a no-op and does not allocate/restart anything.
cp "$STATE_FILE" "$fixture/before.json"
check_server_lifecycle
cmp "$STATE_FILE" "$fixture/before.json"
echo 'llama-server unexpected exit is recorded; runtime becomes offline and retains explicit reload'
