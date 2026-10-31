#!/usr/bin/env python3
import argparse
import importlib.util
import json
import os
import signal
from pathlib import Path
import subprocess
import time
s=importlib.util.spec_from_file_location('memory',Path('scripts/moe-cache-experiment.py'));m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
parser=argparse.ArgumentParser();parser.add_argument('--tool',choices=['memcheck','racecheck','synccheck']);parser.add_argument('--fixture');args=parser.parse_args()
cg=Path('/sys/fs/cgroup')/Path('/proc/self/cgroup').read_text().split('0::',1)[1].strip().lstrip('/')
limit=(cg/'memory.max').read_text().strip()
assert limit!='max' and int(limit)<=4*1024**3 and (cg/'memory.swap.max').read_text().strip()=='0', 'Require bounded4GiB cgroup with swap0'
initial=m.proc_counters(-1)[3];swap=m.system_swap_used_kib();results=[]
fixtures=[Path(args.fixture)] if args.fixture else sorted(Path('runtime/moe-activation-fixtures').glob('op-*.json'))
for fixture in fixtures:
 suffix='-'+args.tool if args.tool else ''
 out=Path('runtime')/(fixture.stem+'-replay'+suffix+'.json');log=Path('runtime')/(fixture.stem+'-replay'+suffix+'.log')
 gpu=m.gpu_stats()
 if 'free_mib' not in gpu or gpu['free_mib']<3072:raise RuntimeError('Need at least3GiB free VRAM for bounded operator replay')
 with log.open('w') as f:
  command=['runtime/moe-activation-replay',str(fixture),str(out)]
  if args.tool:command=['/usr/local/cuda-12.6/bin/compute-sanitizer','--tool',args.tool,'--error-exitcode','86']+command
  p=subprocess.Popen(command,stdout=f,stderr=subprocess.STDOUT,start_new_session=True)
  try:
   deadline=time.monotonic()+(120 if args.tool else 60)
   while p.poll() is None:
    vm=m.proc_counters(-1)[3];memory=m.free_memory_gib();pressure=Path('/proc/pressure/memory').read_text()
    reason=m.memory_stop_reason(memory['MemAvailable'],max(0,m.system_swap_used_kib()-swap),max(0,vm['pswpout']-initial['pswpout'])*os.sysconf('SC_PAGE_SIZE'),pressure)
    if reason or memory['MemAvailable']<7 or time.monotonic()>deadline:raise RuntimeError(reason or 'RAM reserve/timeout guard')
    time.sleep(0.5)
   if p.returncode:raise RuntimeError(f'{fixture}: exit{p.returncode}; see {log}')
  finally:
   if p.poll() is None:
    os.killpg(p.pid,signal.SIGTERM)
    try:p.wait(timeout=5)
    except subprocess.TimeoutExpired:os.killpg(p.pid,signal.SIGKILL);p.wait()
 results.append(json.loads(out.read_text()))
Path('runtime/moe-activation'+('-'+args.tool if args.tool else '')+'-results.json').write_text(json.dumps({'operations':results,'system_swapout_pages':m.proc_counters(-1)[3]['pswpout']-initial['pswpout'],'net_swap_growth_kib':m.system_swap_used_kib()-swap},indent=2)+'\n')
print(f'PASS fixtures={len(results)} states={len(results)*5}: CPU-captured exact, static-CUDA/cache exact, full selected expert bytes exact')
