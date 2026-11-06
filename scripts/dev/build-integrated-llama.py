#!/usr/bin/env python3
"""Build app-owned CUDA staging only; never replace an external or installed runtime."""
import argparse
import hashlib
import json
import pathlib
import shutil
import subprocess

root = pathlib.Path(__file__).resolve().parents[2]
p = argparse.ArgumentParser(description=__doc__)
p.add_argument('--source', type=pathlib.Path, required=True, help='Read-only donor unified source snapshot')
p.add_argument('--cmake', required=True)
p.add_argument('--cuda-compiler', required=True)
p.add_argument('--jobs', type=int, default=3)
a = p.parse_args()
if not 1 <= a.jobs <= 8:
    p.error('jobs must be 1..8')
work = root / 'runtime/integrated-llama'
pin = json.loads((work / 'provenance.json').read_text())
source = a.source.resolve()
for name, expected in pin['sha256'].items():
    if hashlib.sha256((source / name).read_bytes()).hexdigest() != expected:
        raise RuntimeError(f'Source provenance mismatch: {name}')
dest = work / 'source'
if not dest.exists():
    shutil.copytree(source, dest, symlinks=True)
for name, expected in pin['sha256'].items():
    if hashlib.sha256((dest / name).read_bytes()).hexdigest() != expected:
        raise RuntimeError(f'Staged source changed: {name}')
subprocess.run([a.cmake, '-S', str(dest), '-B', str(work / 'build'),
    '-DCMAKE_BUILD_TYPE=Release', '-DGGML_CUDA=ON', '-DCMAKE_CUDA_ARCHITECTURES=86',
    '-DCMAKE_CUDA_COMPILER=' + a.cuda_compiler, '-DGGML_NATIVE=OFF',
    '-DLLAMA_BUILD_COMMIT=' + pin['declaredCommit'][:7], '-DLLAMA_BUILD_NUMBER=0',
    '-DLLAMA_BUILD_TESTS=OFF', '-DLLAMA_BUILD_UI=OFF', '-DLLAMA_BUILD_EXAMPLES=OFF',
    '-DLLAMA_BUILD_MTMD=ON', '-DCMAKE_BUILD_WITH_INSTALL_RPATH=ON',
    '-DCMAKE_INSTALL_RPATH=$ORIGIN'], check=True)
subprocess.run([a.cmake, '--build', str(work / 'build'), '--target', 'llama-server',
    '-j', str(a.jobs)], check=True)
print('Built staging runtime; installation requires CUDA/inference/MTP/Vision/cache validation.')
