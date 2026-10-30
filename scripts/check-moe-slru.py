#!/usr/bin/env python3
"""Test the pinned backend's actual SLRU struct without loading weights/CUDA.
This tests slot identity/eviction only, not CUDA transfers or model numerics.
"""
from pathlib import Path
import subprocess
import tempfile

source = Path('runtime/experimental-llama-moe/src/llama-moe-cache.cpp').read_text()
start = source.index('struct moe_cache_slru {')
end = source.index('\n// gate, up, down', start)
struct = source[start:end]
program = r'''
#include <algorithm>
#include <cassert>
#include <cstdint>
#include <cstdlib>
#include <iostream>
#include <random>
#include <vector>
#define GGML_ASSERT(x) assert(x)
#define GGML_ABORT(...) std::abort()
''' + struct + r'''
int main() {
 std::mt19937 random(42); size_t requests=0, verified=0;
 for(int capacity: {10,64,512,4096}) {
  constexpr int layers=48, experts=512;
  moe_cache_slru cache;cache.init(layers,experts,capacity);
  std::vector<std::vector<int32_t>> maps(layers,std::vector<int32_t>(experts,-1));
  for(int il=0;il<layers;il++)cache.slot_map[il]=maps[il].data();
  std::vector<int> bank(capacity,-1);
  for(int step=0;step<5000;step++){
   int il=random()%layers;
   std::vector<int32_t> ids;
   const int count=step%7==0?std::min(capacity+3,experts):10;
   for(int i=0;i<count;i++)ids.push_back(random()%experts);
   if(step%11==0)ids.push_back(ids.front()); // duplicate expert ids
   std::vector<int32_t> unique=ids;std::sort(unique.begin(),unique.end());
   unique.erase(std::unique(unique.begin(),unique.end()),unique.end());
   size_t expected_hits=0;
   for(auto id:unique)expected_hits+=maps[il][id]>=0;
   if(step==2500)cache.seen_gen=UINT32_MAX; // exercise generation wrap
   std::vector<moe_cache_slru::fill> fills;size_t hits=0;
   bool ok=cache.plan(il,ids.data(),ids.size(),fills,hits);requests++;
   assert(ok==(unique.size()<=size_t(capacity)));
   if(!ok)continue;
   assert(hits==expected_hits);
   for(auto fill:fills){assert(fill.slot>=0&&fill.slot<capacity);bank[fill.slot]=il*experts+fill.expert;}
   for(auto id:ids){const int slot=maps[il][id];assert(slot>=0&&slot<capacity);assert(bank[slot]==il*experts+id);verified++;}
   if(step%100==0)for(int layer=0;layer<layers;layer++)for(int e=0;e<experts;e++)if(maps[layer][e]>=0){
    assert(cache.key_of[maps[layer][e]]==layer*experts+e);
    assert(bank[maps[layer][e]]==layer*experts+e);
   }
  }
 }
 std::cout<<"PASS requests="<<requests<<" selected_expert_identity_checks="<<verified<<"\n";
}
'''
with tempfile.TemporaryDirectory(prefix='moe-slru-') as temp:
    src, binary = Path(temp)/'test.cpp', Path(temp)/'test'
    src.write_text(program)
    subprocess.run(['g++','-std=c++17','-O2',str(src),'-o',str(binary)],check=True,timeout=30)
    subprocess.run([str(binary)],check=True,timeout=30)
