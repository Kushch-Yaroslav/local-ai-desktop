#!/usr/bin/env python3
"""Aggregate temporary full-vocabulary probes; never print or commit binary logits."""
import array
import json
import math
from pathlib import Path
import struct

base=Path('runtime/moe-diag-baseline');cached=Path('runtime/moe-diag-cache')
def read(path):
 b=path.read_bytes();out=[];pos=0
 while pos<len(b):
  n=struct.unpack_from('<I',b,pos)[0];pos+=4
  assert 0<n<1000000 and pos+4*n<=len(b)
  a=array.array('f');a.frombytes(b[pos:pos+4*n]);pos+=4*n;out.append(a)
 return out

def compare(a,b):
 assert len(a)==len(b)
 assert all(math.isfinite(x) for x in a) and all(math.isfinite(x) for x in b)
 delta=[abs(x-y) for x,y in zip(a,b)];n=len(a)
 def probs(v):
  mx=max(v);values=[math.exp(x-mx) for x in v];s=sum(values);return [x/s for x in values]
 pa,pb=probs(a),probs(b)
 ra=sorted(range(n),key=lambda i:a[i],reverse=True);rb=sorted(range(n),key=lambda i:b[i],reverse=True)
 ranka={token:i+1 for i,token in enumerate(ra)};rankb={token:i+1 for i,token in enumerate(rb)}
 ids=list(dict.fromkeys(ra[:10]+rb[:10]))
 js=0
 for x,y in zip(pa,pb):
  m=(x+y)/2
  if x:js+=0.5*x*math.log(x/m)
  if y:js+=0.5*y*math.log(y/m)
 return {'vocab_size':n,'max_abs':max(delta),'mean_abs':sum(delta)/n,'relative_L1':sum(delta)/sum(abs(x) for x in a),'relative_Linf':max(delta)/max(abs(x) for x in a),'total_variation':sum(abs(x-y) for x,y in zip(pa,pb))/2,'Jensen_Shannon_nats':js,'top1_baseline':ra[0],'top1_cache':rb[0],'baseline_top2_gap':a[ra[0]]-a[ra[1]],'cache_top2_gap':b[rb[0]]-b[rb[1]],'top_union':[{'id':i,'baseline_logit':a[i],'cache_logit':b[i],'baseline_p':pa[i],'cache_p':pb[i],'baseline_rank':ranka[i],'cache_rank':rankb[i]} for i in ids]}

def main():
 for folder in (base,cached):
  if (folder/'session.json').exists():
   assert json.loads((folder/'session.json').read_text())['status']=='passed', 'Refusing partial/stale diagnostic session'
 free_a=json.loads((base/'free-1.json').read_text());free_b=json.loads((cached/'free-1.json').read_text())
 first=next((i for i,(a,b) in enumerate(zip(free_a['tokens'],free_b['tokens'])) if a!=b),None)
 teach_a=json.loads((base/'teacher.json').read_text());teach_b=json.loads((cached/'teacher.json').read_text())
 rows=[]
 for step,(a,b) in enumerate(zip(teach_a,teach_b)):
  assert a['prefix_ids']==b['prefix_ids']
  la,lb=read(base/f'teacher-{step}.f32'),read(cached/f'teacher-{step}.f32')
  assert len(la)==len(lb)==1, 'Ambiguous raw-logit capture count'
  row=compare(la[0],lb[0]);row.update(step=step,baseline_chosen=a['chosen_ids'],cache_chosen=b['chosen_ids']);rows.append(row)
 la,lb=read(base/'free-1.f32'),read(cached/'free-1.f32')
 # After first divergence these free logits must NOT be compared.
 shared=[{'step':i,**compare(la[i],lb[i])} for i in range(min(len(la),len(lb),first+1 if first is not None else len(la)))]
 result={'teacher_forced':rows,'free_common_prefix':shared,'first_free_divergence':{'step_zero_based':first,'baseline_id':free_a['tokens'][first] if first is not None else None,'cache_id':free_b['tokens'][first] if first is not None else None},'free_capture_records':[len(la),len(lb)],'cold_warm_same_tokens':{name:json.loads((p/'free-1.json').read_text())['tokens']==json.loads((p/'free-2.json').read_text())['tokens'] for name,p in [('baseline',base),('cache',cached)]},'limitations':'Teacher prefixes re-prefilled identically in both modes; their batching differs from free decoding. No free logits compared beyond first divergence. Relative errors are norm-relative, not unstable elementwise ratios near zero.'}
 out=Path('docs/experiments/advanced-placement-moe/targeted-correctness');out.mkdir(parents=True,exist_ok=True)
 pieces=json.loads((out/'vocab-pieces.json').read_text()) if (out/'vocab-pieces.json').exists() else {}
 for row in result['teacher_forced']+result['free_common_prefix']:
  for token in row['top_union']:
   if str(token['id']) in pieces:token['gguf_vocab_piece']=pieces[str(token['id'])]
 (out/'logits.json').write_text(json.dumps(result,indent=2,allow_nan=False)+'\n')
 print(json.dumps({'first_free_divergence':result['first_free_divergence'],'teacher_steps':len(rows),'max_abs_range':[min(x['max_abs'] for x in rows),max(x['max_abs'] for x in rows)],'mean_abs_range':[min(x['mean_abs'] for x in rows),max(x['mean_abs'] for x in rows)],'teacher_top1_disagreements':[x['step'] for x in rows if x['top1_baseline']!=x['top1_cache']],'cold_warm_same_tokens':result['cold_warm_same_tokens']},indent=2))

if __name__ == "__main__":
 main()
