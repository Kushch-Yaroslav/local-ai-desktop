#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
fixture="$(mktemp -d)"
trap 'rm -r -- "$fixture"' EXIT
python3 - "$root/run-local-ai-desktop-llama-cpp-mtp.sh" "$fixture/functions.sh" <<'PY'
import re,sys
source=open(sys.argv[1]).read()
with open(sys.argv[2],'w') as out:
 for name in ['timestamp','log','json_escape','process_start_time','write_state','memory_snapshot','placement_memory_ok','stop_for_memory_safety']:
  match=re.search(r'^'+name+r'\(\) \{.*?(?:^\}|\}\s*$)',source,re.M|re.S)
  assert match,name
  out.write(match.group()+'\n')
PY
source "$fixture/functions.sh"
STATE_FILE="$fixture/state.json"; LOG_FILE="$fixture/launcher.log"; SERVER_PID_FILE="$fixture/server.pid"
ACTIVE_MODEL=fixture; ACTIVE_CONTEXT=65536; ACTIVE_KV_TYPE=q8_0; ACTIVE_KV_OFFLOAD=1
ACTIVE_SPECULATIVE_MODE=none; ACTIVE_MTP_MODE=off; MTP_FALLBACK_REASON=''; ACTIVE_PROJECTOR_DEVICE=''
ACTIVE_PROFILE_FINGERPRINT=''; ACTIVE_PROFILE_CONFIG=''; PROFILE_MEMORY_GUARD=1
MODEL_SWAP_BASE=100; MEMORY_SAMPLE_AT=9999999; SERVER_PID=$$; ELECTRON_PID=''
# Exercise production metadata collection on this test's own PID first.
memory_snapshot fixture
 grep -q 'memory.process pid=' "$LOG_FILE"
 grep -q 'memory.vmstat swapBasePages=' "$LOG_FILE"
# Deterministic counters from the real incident; no actual memory pressure.
fixture_available=51527096; fixture_swap=14072
awk() {
 case "${*: -1}" in
 /proc/meminfo) echo "$fixture_available";;
 /proc/vmstat) echo "$fixture_swap";;
 *) command awk "$@";;
 esac
}
memory_snapshot() { log "memory.fixture phase=$1"; }
stop_llama_server() {
 node - "$STATE_FILE" <<'JS'
const assert=require('node:assert/strict');
const s=JSON.parse(require('node:fs').readFileSync(process.argv[2],'utf8'));
assert.equal(s.status,'offline');assert.match(s.error,/criterion=global_swap_out/);
assert.equal(s.serverPid,process.ppid,'Cause must be published before first signal');
JS
 log 'fixture.signal TERM';
}
if placement_memory_ok; then echo 'Missed swap threshold' >&2; exit 1; fi
[[ "$LAUNCH_ERROR" == *'criterion=global_swap_out;'* ]]
stop_for_memory_safety
[[ -z "$SERVER_PID" ]]
node - "$LOG_FILE" "$STATE_FILE" <<'JS'
const fs=require('node:fs'),assert=require('node:assert/strict');const l=fs.readFileSync(process.argv[2],'utf8');
assert(l.indexOf('Memory safety stop:')<l.indexOf('fixture.signal TERM'));
assert.match(fs.readFileSync(process.argv[3],'utf8'),/global_swap_out/);
JS
fixture_swap=100; fixture_available=6000000
if placement_memory_ok; then exit 1; fi
[[ "$LAUNCH_ERROR" == *'criterion=ram_reserve;'* ]]
fixture_available=51527096
placement_memory_ok
# Equality is allowed; strict >32MiB retained.
fixture_swap=$((MODEL_SWAP_BASE+32*1024*1024/$(getconf PAGESIZE)))
placement_memory_ok
fixture_swap=$((fixture_swap+1))
if placement_memory_ok; then exit 1; fi
fixture_available=''; fixture_swap=''
if placement_memory_ok; then exit 1; fi
[[ "$LAUNCH_ERROR" == *'criterion=telemetry_unavailable;'* ]]
printf 'PASS memory thresholds and stop cause published before HTTP disconnect\n'
