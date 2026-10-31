#!/usr/bin/env python3
"""Read tokenizer METADATA only; create a synthetic four-block dense GGUF."""
from pathlib import Path
import struct
import sys
source,output=map(Path,sys.argv[1:3])
with source.open('rb') as f:
 def num(fmt):return struct.unpack('<'+fmt,f.read(struct.calcsize('<'+fmt)))[0]
 def text():return f.read(num('Q')).decode()
 def skip(t):
  if t==8:f.seek(num('Q'),1)
  elif t==9:
   et,n=num('I'),num('Q')
   for _ in range(n):skip(et)
  else:f.seek({0:1,1:1,2:2,3:2,4:4,5:4,6:4,7:1,10:8,11:8,12:8}[t],1)
 assert f.read(4)==b'GGUF';num('I');num('Q');count=num('Q');meta={}
 for _ in range(count):
  k=text();t=num('I');start=f.tell();skip(t);end=f.tell()
  if k.startswith('tokenizer.'):
   f.seek(start);meta[k]=(t,f.read(end-start))
 def string(s):b=s.encode();return struct.pack('<Q',len(b))+b
 def setv(k,t,v):meta[k]=(t,struct.pack('<I',v) if t==4 else struct.pack('<f',v) if t==6 else string(v))
 for k,v in {'llama.context_length':8192,'llama.embedding_length':32,'llama.block_count':4,'llama.feed_forward_length':64,'llama.attention.head_count':1,'llama.attention.head_count_kv':1,'llama.rope.dimension_count':32}.items():setv(k,4,v)
 setv('general.architecture',8,'llama');setv('general.name',8,'Synthetic dense placement fixture');setv('general.file_type',4,0);setv('llama.attention.layer_norm_rms_epsilon',6,1e-5);setv('tokenizer.chat_template',8,"{% for message in messages %}{{ message['content'] }}{% endfor %}")
 vocab=struct.unpack_from('<Q',meta['tokenizer.ggml.tokens'][1],4)[0]
 tensors=[('token_embd.weight',[32,vocab],False),('output.weight',[32,vocab],False),('output_norm.weight',[32],True)]
 for i in range(4):
  for name in ['attn_norm','ffn_norm']:tensors.append((f'blk.{i}.{name}.weight',[32],True))
  for name in ['q','k','v','output']:tensors.append((f'blk.{i}.attn_{name}.weight',[32,32],False))
  for name,shape in [('gate',[32,64]),('up',[32,64]),('down',[64,32])]:tensors.append((f'blk.{i}.ffn_{name}.weight',shape,False))
 header=b'GGUF'+struct.pack('<IQQ',3,len(tensors),len(meta))+b''.join(string(k)+struct.pack('<I',t)+v for k,(t,v) in meta.items());blob=bytearray()
 for name,shape,ones in tensors:
  header+=string(name)+struct.pack('<I',len(shape))+struct.pack('<'+'Q'*len(shape),*shape)+struct.pack('<IQ',0,len(blob));size=1
  for n in shape:size*=n
  blob+=(struct.pack('<f',1) if ones else b'\0'*4)*size;blob+=b'\0'*((-len(blob))%32)
 header+=b'\0'*((-len(header))%32);output.write_bytes(header+blob)
 print(output,output.stat().st_size)
