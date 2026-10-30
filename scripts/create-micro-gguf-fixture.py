import struct,pathlib,sys
p=pathlib.Path(sys.argv[1]);data=p.read_bytes();o=24
u=lambda f:struct.unpack_from(f,data,o)
def val(t):
 global o
 sizes={0:1,1:1,2:2,3:2,4:4,5:4,6:4,7:1,10:8,11:8,12:8}
 if t in sizes:o+=sizes[t]
 elif t==8:n=struct.unpack_from('<Q',data,o)[0];o+=8+n
 elif t==9:
  st,n=struct.unpack_from('<IQ',data,o);o+=12
  for _ in range(n):val(st)
 else:raise Exception(t)
meta={};n=struct.unpack_from('<Q',data,16)[0]
for _ in range(n):
 start=o;klen=struct.unpack_from('<Q',data,o)[0];o+=8;k=data[o:o+klen].decode();o+=klen;t=struct.unpack_from('<I',data,o)[0];o+=4;vstart=o;val(t);meta[k]=(t,data[vstart:o])
# Preserve the tokenizer only; model tensors below are synthetic zeros.
def string(s):b=s.encode();return struct.pack('<Q',len(b))+b
def setv(k,t,v):meta[k]=(t,struct.pack('<I',v) if t==4 else struct.pack('<f',v) if t==6 else string(v))
for k,v in {'llama.context_length':8192,'llama.embedding_length':32,'llama.block_count':1,'llama.feed_forward_length':64,'llama.attention.head_count':1,'llama.attention.head_count_kv':1,'llama.rope.dimension_count':32}.items():setv(k,4,v)
setv('general.file_type',4,0);setv('general.architecture',8,'llama');setv('general.name',8,'Local test-only zero-weight micro fixture');setv('llama.attention.layer_norm_rms_epsilon',6,1e-5)
vraw=meta['tokenizer.ggml.tokens'][1];vocab=struct.unpack_from('<Q',vraw,4)[0]
setv('tokenizer.chat_template',8,"{% for message in messages %}{{ message['content'] }}{% endfor %}")
tensors=[('token_embd.weight',[32,vocab],False),('output_norm.weight',[32],True),('output.weight',[32,vocab],False),('blk.0.attn_norm.weight',[32],True),('blk.0.ffn_norm.weight',[32],True)]
for x in ['q','k','v','output']:tensors.append(('blk.0.attn_'+x+'.weight',[32,32],False))
for x,dims in [('gate',[32,64]),('up',[32,64]),('down',[64,32])]:tensors.append(('blk.0.ffn_'+x+'.weight',dims,False))
header=b'GGUF'+struct.pack('<IQQ',3,len(tensors),len(meta));header+=b''.join(string(k)+struct.pack('<I',t)+v for k,(t,v) in meta.items());blob=b''
for name,dims,ones in tensors:
 offset=len(blob);header+=string(name)+struct.pack('<I',len(dims))+struct.pack('<'+'Q'*len(dims),*dims)+struct.pack('<IQ',0,offset)
 count=1
 for d in dims:count*=d
 blob+=(struct.pack('<f',1.0) if ones else b'\0'*4)*count;blob+=b'\0'*((-len(blob))%32)
header+=b'\0'*((-len(header))%32);out=pathlib.Path(sys.argv[2]);out.write_bytes(header+blob);print(out,out.stat().st_size)
