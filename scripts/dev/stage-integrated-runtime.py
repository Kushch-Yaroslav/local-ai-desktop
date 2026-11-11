#!/usr/bin/env python3
"""Stage the single app-owned runtime after host verification; external llama.cpp is untouched."""
import hashlib,json,pathlib,shutil,subprocess,time
root=pathlib.Path(__file__).resolve().parents[2]
work=root/'runtime/integrated-llama'; source=work/'build/bin'; final=root/'runtime/llama'
for process in pathlib.Path('/proc').glob('[0-9]*'):
 try:
  if (process/'exe').resolve()==(final/'llama-server').resolve():
   raise RuntimeError('App-owned runtime is active; refusing replacement')
 except (OSError,UnicodeError): pass
report=json.loads(pathlib.Path('/tmp/lad-integrated-moe-benchmark.json').read_text())
assert all(any(r['cacheMiB']==size and r.get('scope',{}).get('swapMax')=='0' and len(r.get('samples',[]))==3 for r in report['rows']) for size in [0,8192,12288,16384])
assert '5047748' in report['version']
next_path=root/'runtime/llama.next'
if next_path.exists(): raise RuntimeError('Staging already exists; refusing overwrite')
next_path.mkdir()
for item in source.iterdir():
 if item.name=='llama-server' or '.so' in item.name:
  if item.is_symlink(): (next_path/item.name).symlink_to(item.resolve().name)
  elif item.is_file(): shutil.copy2(item,next_path/item.name)
# Redistributable CUDA runtime libraries only, never the host libcuda driver.
linked=subprocess.check_output(['ldd',str(source/'libggml-cuda.so')],text=True)
for line in linked.splitlines():
 fields=line.split()
 if len(fields)>2 and fields[0].startswith(('libcudart.so','libcublas.so','libcublasLt.so')):
  shutil.copy2(pathlib.Path(fields[2]).resolve(),next_path/fields[0])
shutil.copy2(work/'source/LICENSE',next_path/'LICENSE.llama.cpp')
eula=pathlib.Path('/usr/local/cuda-12.6/EULA.txt')
if eula.exists(): shutil.copy2(eula,next_path/'EULA.CUDA.txt')
manifest={'commit':'5047748f114564fcf271e6a648f60e2d2eae6264','cudaArchitectures':'86','integration':'one-managed-runtime','files':{p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in next_path.iterdir() if p.is_file() and not p.is_symlink()}}
(next_path/'runtime-manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
if final.exists(): final.rename(work/('previous-runtime-'+str(int(time.time()))))
next_path.rename(final)
print(final)
