#!/usr/bin/env python3
"""Attach exact GGUF offsets and verified common prefix to captured small fixtures."""
import hashlib
import json
from pathlib import Path
import re
import struct
root=Path('runtime/moe-activation-fixtures')
models=json.loads(Path('docs/experiments/advanced-placement-moe/inventory.json').read_text())
m=next(m for m in models if m['metadata']['general.architecture']=='qwen3next' and m['metadata']['qwen3next.block_count']==48)
a=m['metadata'].get('general.alignment',32);start=(m['descriptor_bytes_read']+a-1)//a*a
ref=json.loads(Path('docs/experiments/advanced-placement-moe/targeted-correctness/reference.json').read_text())
free=json.loads((root/'free-1.json').read_text());assert free['tokens']==ref['output_ids'][:24]
for p in sorted(root.glob('op-*.json')):
 d=json.loads(p.read_text());name=re.search(r'blk\.\d+\..*',d['weight']['name'])[0];t=next(t for t in m['tensors'] if t['name']==name)
 d.update(weight_name=name,layer=int(name.split('.')[1]),gguf=m['path'],weight_offset=start+t['offset'],prefix_ids=ref['input_ids']+ref['output_ids'][:1],decode_step_zero_based=1)
 raw=p.with_suffix('.ids.bin').read_bytes();d['expert_ids']=list(struct.unpack('<'+'i'*(len(raw)//4),raw))
 d['fixture_hashes']={kind:hashlib.sha256(p.with_suffix('.'+kind+'.bin').read_bytes()).hexdigest() for kind in ('input','ids','output')}
 p.write_text(json.dumps(d,indent=2)+'\n')
print('Verified24baseline output IDs; six operations share decode step1 prefix')
