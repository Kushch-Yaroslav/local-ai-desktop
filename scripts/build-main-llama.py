#!/usr/bin/env python3
"""Build the pinned app runtime independently, then stage its relocatable dependencies."""
import argparse, hashlib, json, os, pathlib, shutil, subprocess, tarfile
p=argparse.ArgumentParser();p.add_argument('--source',required=True,help='Existing official llama.cpp git clone (read only)');p.add_argument('--jobs',default='4');p.add_argument('--cmake',default=os.environ.get('CMAKE','cmake'));a=p.parse_args()
root=pathlib.Path(__file__).resolve().parent.parent
pin=json.loads((root/'resources/llama-runtime.json').read_text());commit=pin['commit']
source=pathlib.Path(a.source).resolve();work=root/'runtime/main-llama';work.mkdir(exist_ok=True)
actual=subprocess.check_output(['git','-C',str(source),'rev-parse',commit],text=True).strip();assert actual==commit
archive=work/'source.tar';dest=work/'source'
if not dest.exists():
 with archive.open('wb') as f:subprocess.run(['git','-C',str(source),'archive',commit],stdout=f,check=True)
 dest.mkdir()
 with tarfile.open(archive) as t:t.extractall(dest,filter='data')
 archive.unlink()
build=work/'build'
subprocess.run([a.cmake,'-DLLAMA_BUILD_COMMIT='+commit[:7],'-DLLAMA_BUILD_NUMBER=0','-DCMAKE_CUDA_COMPILER=/usr/local/cuda-12.6/bin/nvcc','-S',str(dest),'-B',str(build),'-DCMAKE_BUILD_TYPE=Release','-DGGML_CUDA=ON','-DCMAKE_CUDA_ARCHITECTURES='+pin['cudaArchitectures'],'-DGGML_NATIVE=OFF','-DLLAMA_BUILD_TESTS=OFF','-DLLAMA_BUILD_UI=OFF','-DLLAMA_BUILD_EXAMPLES=OFF','-DLLAMA_BUILD_MTMD=ON','-DCMAKE_BUILD_WITH_INSTALL_RPATH=ON','-DCMAKE_INSTALL_RPATH=$ORIGIN','-DLLAMA_OPENSSL=ON'],check=True)
subprocess.run([a.cmake,'--build',str(build),'--target','llama-server','-j',a.jobs],check=True)
stage=root/'runtime/llama.next';shutil.rmtree(stage,ignore_errors=True);stage.mkdir()
for f in (build/'bin').iterdir():
 if f.name=='llama-server' or '.so' in f.name:
  if f.is_symlink(): (stage/f.name).symlink_to(f.resolve().name)
  elif f.is_file():shutil.copy2(f,stage/f.name)
# CUDA redistributables only; libcuda is supplied by the host driver, never bundled.
ldd=subprocess.check_output(['ldd',str(stage/'libggml-cuda.so')],text=True,env={**os.environ,'LD_LIBRARY_PATH':'/usr/local/cuda-12.6/lib64'})
for line in ldd.splitlines():
 fields=line.split()
 if len(fields)>2 and fields[0].startswith(('libcudart.so','libcublas.so','libcublasLt.so')):
  shutil.copy2(pathlib.Path(fields[2]).resolve(),stage/fields[0])
shutil.copy2(dest/'LICENSE',stage/'LICENSE.llama.cpp')
licenses=list(pathlib.Path('/usr/local').glob('cuda*/EULA.txt'))
if licenses:shutil.copy2(licenses[0],stage/'EULA.CUDA.txt')
manifest={**pin,'files':{f.name:hashlib.sha256(f.read_bytes()).hexdigest() for f in stage.iterdir() if f.is_file() and not f.is_symlink()}}
(stage/'runtime-manifest.json').write_text(json.dumps(manifest,indent=2))
final=root/'runtime/llama'
if final.exists():
 backup=work/'previous-runtime'
 if backup.exists():raise RuntimeError('Previous runtime backup exists; refusing overwrite')
 final.rename(backup)
stage.rename(final)
print('STAGED',final)
