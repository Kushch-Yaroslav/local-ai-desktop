#!/usr/bin/env python3
"""Bounded identical load probes; original profiles/GGUF remain read-only."""
import json,pathlib,subprocess,time,urllib.request,socket,os,signal,hashlib
root=pathlib.Path(__file__).resolve().parent.parent
config=root/'runtime/app-data/runtime-settings.json';raw=config.read_bytes();model=next(m for m in json.loads(raw)['models'] if 'Artemis' in m['displayName'])
out=root/'docs/experiments/artemis-runtime-audit';out.mkdir(exist_ok=True)
def kv(path):
 return {x.split()[0].rstrip(':'):int(x.split()[1]) for x in pathlib.Path(path).read_text().splitlines() if len(x.split())>1 and x.split()[1].isdigit()}
def swaps():
 d={}
 for p in pathlib.Path('/proc').glob('[0-9]*/status'):
  try:
   v=kv(p);d[int(p.parent.name)]={'swapKiB':v.get('VmSwap',0),'comm':(p.parent/'comm').read_text().strip()}
  except (OSError,ValueError):pass
 return d
cg=pathlib.Path('/sys/fs/cgroup'+pathlib.Path('/proc/self/cgroup').read_text().strip().split(':')[-1]);assert (cg/'memory.swap.max').read_text().strip()=='0'
assert int((cg/'memory.max').read_text())<=55*1024**3
assert int(subprocess.check_output(['nvidia-smi','--query-gpu=memory.free','--format=csv,noheader,nounits'],text=True).strip())>22000
def interrupted(_signum,_frame):raise KeyboardInterrupt('audit interrupted')
signal.signal(signal.SIGTERM,interrupted)
results=[]
for label,binary in [('old','/media/yaroslav/DATA/llama.cpp/build-cuda/bin/llama-server'),('new',str(root/'runtime/llama/llama-server'))]:
 before=kv('/proc/vmstat');mem=kv('/proc/meminfo');assert mem['MemAvailable']>20*1024**2
 initial=swaps();s=socket.socket();s.bind(('127.0.0.1',0));port=s.getsockname()[1];s.close()
 args=[binary,'-m',model['modelPath'],'--host','127.0.0.1','--port',str(port),'--ctx-size','4096','--gpu-layers','32','--flash-attn','on','--cache-type-k','q8_0','--cache-type-v','q8_0','--kv-offload','--parallel','1','--jinja','--fit','off','--threads','8','--threads-batch','8','--batch-size','512','--ubatch-size','128','--load-mode','mmap','--no-warmup','--spec-type','none']
 result={'runtime':label,'args':args,'version':subprocess.check_output([binary,'--version'],stderr=subprocess.STDOUT,text=True).strip(),'beforeMemory':mem,'samples':[]};start=time.monotonic();log=open('/tmp/artemis-audit-'+label+'.log','w');p=subprocess.Popen(args,stdout=log,stderr=log);ready=False
 try:
  while time.monotonic()-start<100:
   v=kv('/proc/vmstat');m=kv('/proc/meminfo');status=kv(f'/proc/{p.pid}/status') if pathlib.Path(f'/proc/{p.pid}/status').exists() else {};stat=kv(cg/'memory.stat');sample={'seconds':round(time.monotonic()-start,2),'mem':{k:m.get(k) for k in ['MemAvailable','MemFree','Cached','SReclaimable','AnonPages','Mlocked','Unevictable','SwapFree']},'process':{k:status.get(k) for k in ['VmRSS','RssAnon','RssFile','VmSwap','VmPin','VmLck']},'pswpoutDelta':v['pswpout']-before['pswpout'],'pswpinDelta':v['pswpin']-before['pswpin'],'psi':pathlib.Path('/proc/pressure/memory').read_text().strip(),'cgroup':{'current':(cg/'memory.current').read_text().strip(),'swap':(cg/'memory.swap.current').read_text().strip(),'events':(cg/'memory.events').read_text().strip(),'anon':stat.get('anon'),'file':stat.get('file')}};result['samples'].append(sample)
   if m['MemAvailable']<7*1024**2 or sample['pswpoutDelta']>8192 or status.get('VmSwap',0)>0:result['stop']='memory watchdog';break
   if p.poll() is not None:result['stop']='runtime exited';break
   try:
    with urllib.request.urlopen(f'http://127.0.0.1:{port}/health',timeout=.2) as r:ready=r.status==200
   except Exception:pass
   if ready:
    result['loadSeconds']=round(time.monotonic()-start,3);result['stop']='ready';break
   time.sleep(.25)
  if ready: # bounded short completion; metrics remain loader-focused
   req=urllib.request.Request(f'http://127.0.0.1:{port}/completion',json.dumps({'prompt':'2 + 2 =','n_predict':8,'temperature':0,'seed':42}).encode(),{'Content-Type':'application/json'})
   with urllib.request.urlopen(req,timeout=20) as r:result['completion']=json.load(r)
 finally:
  p.terminate()
  try:p.wait(timeout=10)
  except subprocess.TimeoutExpired:p.kill();p.wait()
  log.close();after=swaps();result['swapGrowthProcesses']=[{'pid':pid,'comm':x['comm'],'deltaKiB':x['swapKiB']-initial.get(pid,{}).get('swapKiB',0)} for pid,x in after.items() if x['swapKiB']>initial.get(pid,{}).get('swapKiB',0)];result['finalPswpoutDelta']=kv('/proc/vmstat')['pswpout']-before['pswpout'];text=pathlib.Path(log.name).read_text();result['allocationAndWarnings']=[l for l in text.splitlines() if any(w in l for w in ['buffer size','warning','CPU_REPACK','error:'])][-25:];results.append(result);(out/'ab.json').write_text(json.dumps(results,indent=2));assert config.read_bytes()==raw
 if result.get('stop')=='memory watchdog':break # no unsafe retries; new historical artifacts retained
 time.sleep(2)
print(json.dumps([{'runtime':r['runtime'],'stop':r.get('stop'),'swapPages':r['finalPswpoutDelta']} for r in results]))
