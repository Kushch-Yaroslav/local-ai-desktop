#!/usr/bin/env python3
import json
from pathlib import Path
r=json.loads(Path('runtime/moe-activation-results.json').read_text());assert len(r['operations'])==6
assert r['system_swapout_pages']==0
for op in r['operations']:
 assert len(op['states'])==5
 for state in op['states']:
  assert state['static_cached']['max_abs']==0
  assert state['full_selected_weight_bytes_equal']
  assert len(set(state['selected_slots']))==10
  for k in ('CPU_static','CPU_cached','static_cached'):
   c=state[k]['above_thresholds'];assert c==sorted(c,reverse=True)
 first=op['states'][0];assert first['CPU_captured']['max_abs']==0
 assert first['oracle_static_CUDA']['RMSE']==first['oracle_cached_CUDA']['RMSE']
 assert first['oracle_static_CUDA']['RMSE']<first['oracle_CPU']['RMSE']
for p in Path('runtime/moe-activation-fixtures').glob('op-*.json'):
 log=Path('runtime',p.stem+'-replay.log').read_text();assert '10 slots' in log and 'hits = 20, misses = 30' in log
assert 'ERROR SUMMARY: 0 errors' in Path('runtime/op-1-replay-memcheck.log').read_text()
assert '0 hazards displayed (0 errors, 0 warnings)' in Path('runtime/op-3-replay-racecheck.log').read_text()
print('PASS:6CPU capture identities,30CUDA/cache identities and weight/mapping checks,6oracle controls,2sanitizer summaries')
