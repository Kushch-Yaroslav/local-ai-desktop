#!/usr/bin/env python3
import importlib.util
import json
from pathlib import Path
spec=importlib.util.spec_from_file_location('metrics',Path('scripts/moe-diagnostics/compare.py'));m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
a=Path('runtime/moe-target20-cpu');b=Path('runtime/moe-target20-cache')
x=json.loads((a/'teacher-target.json').read_text());y=json.loads((b/'teacher-target.json').read_text());assert x['prefix_ids']==y['prefix_ids']
va,vb=m.read(a/'teacher-target.f32'),m.read(b/'teacher-target.f32');assert len(va)==len(vb)==1
r=m.compare(va[0],vb[0]);r.update(step=x['step'],prefix_ids=x['prefix_ids'],baseline_chosen=x['result']['tokens'],cache_chosen=y['result']['tokens'],batching='Identical full prefix prefill; not the previous free-decoding step20 batching')
out=Path('docs/experiments/advanced-placement-moe/real-activation');out.mkdir(parents=True,exist_ok=True);(out/'target20-logits.json').write_text(json.dumps(r,indent=2)+'\n')
print(json.dumps({k:r[k] for k in ['max_abs','mean_abs','relative_L2'] if k in r}|{'total_variation':r['total_variation'],'top1':[r['top1_baseline'],r['top1_cache']]},indent=2))
