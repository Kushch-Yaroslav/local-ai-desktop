#!/usr/bin/env python3
"""Small GPU byte-probe regression controls. No full model or sysctl changes."""
import json
import os
from pathlib import Path
import resource
import subprocess
resource.setrlimit(resource.RLIMIT_CORE,(0,0))
env=dict(os.environ,LD_PRELOAD=str(Path('runtime/moe-diagnostic-probe.so').resolve()),LAD_CHECK_UPLOADS='1')
results=[]
for corrupt in (False,True):
 e=env.copy()
 if corrupt:e['LAD_INJECT_CORRUPTION']='1'
 r=subprocess.run(['runtime/moe-tensor-diagnostic','runtime/moe-expert-type12.bin'],env=e,capture_output=True,text=True,timeout=30)
 expected=(r.returncode==-6 and 'LAD_TRANSFER_MISMATCH' in r.stderr) if corrupt else (r.returncode==0 and 'errors=0 pending=0' in r.stderr)
 results.append({'corrupt':corrupt,'returncode':r.returncode,'expected_behavior':expected,'probe_lines':[line for line in r.stderr.splitlines() if line.startswith('LAD_')],'stdout':r.stdout.strip()})
 assert expected,results[-1]
Path('runtime/moe-probe-controls.json').write_text(json.dumps(results,indent=2)+'\n')
print('PASS: valid GPU uploads accepted; deliberate slot corruption detected')
