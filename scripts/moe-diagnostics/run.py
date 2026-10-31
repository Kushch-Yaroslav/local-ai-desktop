#!/usr/bin/env python3
"""Use existing bounded server lifecycle for targeted free/teacher-forced requests."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sys
import time

spec=importlib.util.spec_from_file_location('runner',Path(__file__).parents[1]/'moe-cache-experiment.py')
r=importlib.util.module_from_spec(spec);spec.loader.exec_module(r)
root=Path(os.environ['LAD_DIAG_DIR']).resolve();root.mkdir(parents=True,exist_ok=True)
marker=root/'marker';os.environ['LAD_LOGIT_MARKER']=str(marker)
os.environ['LD_PRELOAD']=os.environ.get('LAD_DIAG_PRELOAD',str(Path('runtime/moe-diagnostic-probe.so').resolve()))
reference=Path('runtime/moe-diag-baseline/reference.json')
cycle=0
(root/'session.json').write_text(json.dumps({'status':'running','started_unix':time.time()}))

def request(url,prompt,tokens,timeout):
 global cycle
 cycle+=1
 ids=r.post_json(url,'/tokenize',{'content':prompt,'add_special':True,'parse_special':True},timeout)['tokens']
 digest=hashlib.sha256(prompt.encode()).hexdigest()
 old=json.loads(next(Path('docs/experiments/advanced-placement-moe/qwen-ab-cache0').glob('*.json')).read_text())
 expected=next(x['formatted_prompt_sha256'] for x in old['runs'] if x['task']=='explain')
 if digest!=expected:raise RuntimeError('Formatted prompt differs from saved A/B')
 if reference.exists():
  ref=json.loads(reference.read_text())
  if ref['input_ids']!=ids:raise RuntimeError('Input token IDs differ')
 else:ref=None
 def complete(name,prefix,n):
  (root/(name+'.json')).unlink(missing_ok=True)
  target=root/(name+'.f32');target.unlink(missing_ok=True);marker.write_text(str(target))
  start=time.monotonic()
  out=r.post_json(url,'/completion',{'prompt':prefix,'n_predict':n,'temperature':0,'top_k':1,'top_p':1,'seed':42,'cache_prompt':False,'stream':False,'return_tokens':True},timeout)
  out['_wall_seconds']=time.monotonic()-start;out['_ttft_seconds']=None
  return out
 if os.environ.get('LAD_TARGET_STEP'):
  step=int(os.environ['LAD_TARGET_STEP']);assert ref is not None
  prefix=ids+ref['output_ids'][:step]
  out=complete('teacher-target',prefix,1)
  (root/'teacher-target.json').write_text(json.dumps({'step':step,'prefix_ids':prefix,'result':out},indent=2)+'\n')
  return out
 out=complete(f'free-{cycle}',ids,tokens)
 if not out.get('tokens'):raise RuntimeError('Missing returned token IDs')
 (root/f'free-{cycle}.json').write_text(json.dumps(out,indent=2)+'\n')
 if ref is None:
  ref={'input_ids':ids,'output_ids':out['tokens'],'formatted_prompt_sha256':digest,'formatted_prompt':prompt}
  reference.parent.mkdir(parents=True,exist_ok=True);reference.write_text(json.dumps(ref,indent=2)+'\n')
 if cycle==1 and not os.environ.get('LAD_SKIP_TEACHER'):
  # Re-evaluate identical prefixes in both modes, independent of free-generation divergence.
  teachers=[]
  for step in range(16):
   prefix=ids+ref['output_ids'][:step]
   result=complete(f'teacher-{step}',prefix,1)
   teachers.append({'step':step,'prefix_ids':prefix,'chosen_ids':result.get('tokens'),'timings':result.get('timings')})
  (root/'teacher.json').write_text(json.dumps(teachers,indent=2)+'\n')
 marker.write_text('')
 return out
r.post_completion=request
code=r.main()
(root/'session.json').write_text(json.dumps({'status':'passed' if code==0 else 'failed','exit_code':code,'ended_unix':time.time()}))
raise SystemExit(code)
