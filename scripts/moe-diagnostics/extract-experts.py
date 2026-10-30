#!/usr/bin/env python3
"""Extract two small expert payloads into ignored runtime; never modify GGUF."""
import json
import struct
from pathlib import Path
models=json.loads(Path('docs/experiments/advanced-placement-moe/inventory.json').read_text())
m=next(m for m in models if m['metadata']['general.architecture']=='qwen3next' and m['metadata']['qwen3next.block_count']==48)
alignment=m['metadata'].get('general.alignment',32)
start=(m['descriptor_bytes_read']+alignment-1)//alignment*alignment
manifest=[]
for ty,block in [(12,144),(14,210)]:
 t=next(t for t in m['tensors'] if '_exps.weight' in t['name'] and t['ggml_type']==ty)
 ni,no,experts=t['shape'];size=ni*no//256*block
 with open(m['path'],'rb') as f:
  f.seek(start+t['offset']);data=f.read(size)
 assert len(data)==size
 Path(f'runtime/moe-expert-type{ty}.bin').write_bytes(struct.pack('<iiii',ty,ni,no,size)+data)
 manifest.append({'model':m['path'],'tensor':t,'expert_id':0,'data_start':start,'expert_bytes':size})
Path('runtime/moe-expert-manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
