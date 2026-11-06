# Integrated llama.cpp runtime

Local AI Desktop's managed GGUF profiles use the app-owned `runtime/llama` runtime. It is built from the vendored llama.cpp source snapshot at `5047748f114564fcf271e6a648f60e2d2eae6264`; the upstream MIT license is retained in both the source snapshot and `runtime/llama/LICENSE.llama.cpp`. `provenance.json` records hashes for the source files used to identify this runtime.

The tracked source tree contains code and build inputs. Upstream documentation, model/vocabulary data, benchmark outputs, upstream CI/issue workflows, build output, logs, local agent settings and private key-like files are excluded. The shipped CUDA runtime targets sm_86. Model weights and the NVIDIA driver are not bundled.

To rebuild on a Linux CUDA development host, run from the repository root:

```sh
python3 scripts/dev/build-integrated-llama.py \
  --source runtime/integrated-llama/source \
  --cmake cmake \
  --cuda-compiler /path/to/nvcc
```

The build is staged under the ignored `runtime/integrated-llama/build/` directory. It does not overwrite the app runtime. The binary package uses the separately verified files under `runtime/llama/`.
