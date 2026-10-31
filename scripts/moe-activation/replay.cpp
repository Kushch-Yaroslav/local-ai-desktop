#ifdef NDEBUG
#error Diagnostic harness requires active assertions
#endif
#include "llama-model.h"
#include "llama-moe-cache.h"
#include "ggml-alloc.h"
#include "nlohmann/json.hpp"
#include <fstream>
#include <vector>
#include <set>
#include <cassert>
#include <cmath>
#include <cstring>
#include <iostream>
using json=nlohmann::json;
static std::vector<char> read(const std::string&p){std::ifstream f(p,std::ios::binary);assert(f);return {std::istreambuf_iterator<char>(f),{}};}
static json metric(const std::vector<float>&a,const std::vector<float>&b){
 assert(a.size()==b.size());double mx=0,l1=0,sq=0,na=0,nb=0,maxa=0;int counts[4]={};
 for(size_t i=0;i<a.size();i++){assert(std::isfinite(a[i])&&std::isfinite(b[i]));double d=std::abs(double(a[i])-b[i]);mx=std::max(mx,d);l1+=d;sq+=d*d;na+=double(a[i])*a[i];nb+=double(b[i])*b[i];maxa=std::max(maxa,std::abs(double(a[i])));int j=0;for(double t:{1e-6,1e-4,1e-3,1e-2})counts[j++]+=d>t;}
 return {{"elements",a.size()},{"max_abs",mx},{"mean_abs",l1/a.size()},{"RMSE",sqrt(sq/a.size())},{"relative_L2",sqrt(sq)/std::max(sqrt(na),1e-12)},{"relative_Linf",mx/std::max(maxa,1e-12)},{"reference_L2",sqrt(na)},{"test_L2",sqrt(nb)},{"above_thresholds",{counts[0],counts[1],counts[2],counts[3]}}};
}
struct engine{
 ggml_backend_t backend;ggml_context*ctx;ggml_backend_buffer_t buffer;ggml_cgraph*graph;ggml_tensor*w,*b,*ids,*out,*map=nullptr,*slots=nullptr;std::vector<char>input;
 engine(ggml_backend_t dev,ggml_tensor*weight,const json&m,const std::string&stem,llama_moe_cache*cache=nullptr):backend(dev),w(weight){
  ctx=ggml_init({8*1024*1024,nullptr,true});assert(ctx);auto n=m["input"]["ne"];
  b=ggml_new_tensor_4d(ctx,(ggml_type)m["input"]["type"].get<int>(),n[0],n[1],n[2],n[3]);
  for(int i=0;i<4;i++)assert(b->nb[i]==m["input"]["nb"][i].get<size_t>());
  ids=ggml_new_tensor_2d(ctx,GGML_TYPE_I32,10,1);auto use_ids=ids;
  if(cache){auto host=cache->get_slot_map(m["layer"],1,10);assert(host);map=ggml_dup_tensor(ctx,host);auto lookup=ggml_get_rows(ctx,map,ids);slots=ggml_reshape_2d(ctx,lookup,10,1);use_ids=slots;w=cache->get_experts(weight);assert(w);}
  out=ggml_mul_mat_id(ctx,w,b,use_ids);auto params=m["op_params"].get<std::vector<int32_t>>();memcpy(out->op_params,params.data(),GGML_MAX_OP_PARAMS);
  assert(ggml_backend_supports_op(dev,out));graph=ggml_new_graph_custom(ctx,128,false);ggml_build_forward_expand(graph,out);
  buffer=ggml_backend_alloc_ctx_tensors(ctx,dev);assert(buffer);input=read(stem+".input.bin");assert(input.size()==ggml_nbytes(b));ggml_backend_tensor_set(b,input.data(),0,input.size());
 }
 std::vector<float> compute(const std::vector<int32_t>&selected,llama_moe_cache*cache=nullptr,int layer=0){
  ggml_backend_tensor_set(ids,selected.data(),0,40);
  if(cache)assert(cache->copy(backend,cache->get_slot_map(layer,1,10),map,graph));
  // No harness synchronization between real cache uploads/slot copy and graph execution.
  assert(ggml_backend_graph_compute_async(backend,graph)==GGML_STATUS_SUCCESS);
  ggml_backend_synchronize(backend); // wait for OUTPUT completion, never before queued uploads/compute
  std::vector<float>v(ggml_nelements(out));ggml_backend_tensor_get(out,v.data(),0,v.size()*4);return v;
 }
 ~engine(){ggml_backend_buffer_free(buffer);ggml_free(ctx);}
};
int main(int argc,char**argv){
 assert(argc==3);std::ifstream mf(argv[1]);json m;mf>>m;std::string stem=argv[1];stem=stem.substr(0,stem.size()-5);
 ggml_backend_load_all();auto cpu=ggml_backend_init_by_name("CPU",nullptr),gpu=ggml_backend_init_by_name("CUDA0",nullptr);assert(cpu&&gpu);ggml_backend_cpu_set_n_threads(cpu,8);
 auto params=llama_model_default_params();params.no_alloc=true;params.n_gpu_layers=999;params.load_mode=LLAMA_LOAD_MODE_DIRECT_IO;params.no_host=true;params.use_extra_bufts=false;
 auto model=llama_model_load_from_file(m["gguf"].get<std::string>().c_str(),params);assert(model);
 auto w=const_cast<ggml_tensor*>(model->get_tensor(m["weight_name"].get<std::string>().c_str()));assert(w);
 for(auto&layer:model->layers)layer.ffn_gate_exps=layer.ffn_up_exps=layer.ffn_down_exps=layer.ffn_gate_up_exps=nullptr;
 const int layer=m["layer"];model->layers[layer].ffn_gate_exps=w;
 w->buffer=nullptr;w->data=nullptr;auto host=ggml_backend_alloc_buffer(cpu,ggml_nbytes(w));assert(host);ggml_backend_buffer_set_usage(host,GGML_BACKEND_BUFFER_USAGE_WEIGHTS);assert(ggml_backend_tensor_alloc(host,w,ggml_backend_buffer_get_base(host))==GGML_STATUS_SUCCESS);
 auto weightctx=ggml_init({1024*1024,nullptr,true});auto staticw=ggml_dup_tensor(weightctx,w);auto staticbuf=ggml_backend_alloc_ctx_tensors(weightctx,gpu);assert(staticbuf);ggml_backend_buffer_set_usage(staticbuf,GGML_BACKEND_BUFFER_USAGE_WEIGHTS);
 auto original=m["expert_ids"].get<std::vector<int32_t>>();std::vector<int32_t>other;for(int i=0;other.size()<10;i++)if(std::find(original.begin(),original.end(),i)==original.end())other.push_back(i);
 std::set<int>needed(original.begin(),original.end());needed.insert(other.begin(),other.end());std::ifstream gguf(m["gguf"].get<std::string>(),std::ios::binary);std::vector<char>expert(w->nb[2]);
 for(int e:needed){gguf.seekg(m["weight_offset"].get<size_t>()+e*w->nb[2]);gguf.read(expert.data(),expert.size());assert(gguf);ggml_backend_tensor_set(w,expert.data(),e*w->nb[2],expert.size());ggml_backend_tensor_set(staticw,expert.data(),e*w->nb[2],expert.size());}
 json result={{"fixture",argv[1]},{"weight",m["weight_name"]},{"layer",layer},{"expert_ids",original},{"input",m["input"]},{"states",json::array()}};
 {
  llama_moe_cache cache(*model,false,{cpu,gpu},{ggml_backend_get_default_buffer_type(cpu),ggml_backend_get_default_buffer_type(gpu)},w->nb[2]*11+256);
  engine ce(cpu,w,m,stem),se(gpu,staticw,m,stem),de(gpu,w,m,stem,&cache);
  std::vector<std::vector<int32_t>>sequence={original,original,other,original,original};
  const char* names[]={"first-miss","hit","disjoint-miss-eviction","reuse-miss","hit-after-reuse"};
  for(int phase=0;phase<5;phase++){
   auto ids=sequence[phase];auto a=ce.compute(ids),b=se.compute(ids),c=de.compute(ids,&cache,layer);
   auto hostmap=cache.get_slot_map(layer,1,10);std::vector<int32_t>slots(512);ggml_backend_tensor_get(hostmap,slots.data(),0,512*4);
   auto bank=cache.get_experts(w);bool bytes_equal=true;std::set<int>unique;
   for(int e:ids){assert(slots[e]>=0);assert(unique.insert(slots[e]).second);std::vector<char>cpu_bytes(w->nb[2]),gpu_bytes(w->nb[2]);ggml_backend_tensor_get(w,cpu_bytes.data(),e*w->nb[2],cpu_bytes.size());ggml_backend_tensor_get(bank,gpu_bytes.data(),slots[e]*bank->nb[2],gpu_bytes.size());bytes_equal&=cpu_bytes==gpu_bytes;}
   assert(bytes_equal);json row={{"phase",names[phase]},{"CPU_static",metric(a,b)},{"static_cached",metric(b,c)},{"CPU_cached",metric(a,c)},{"full_selected_weight_bytes_equal",bytes_equal},{"selected_ids",ids},{"selected_slots",json::array()}};
   for(int e:ids)row["selected_slots"].push_back(slots[e]);
   if(phase==0){auto captured=read(stem+".output.bin");std::vector<float>v(captured.size()/4);memcpy(v.data(),captured.data(),captured.size());row["CPU_captured"]=metric(v,a);}
   assert(row["static_cached"]["max_abs"].get<double>()==0);
   if(phase==0)assert(row["CPU_captured"]["max_abs"].get<double>()==0);
   if(phase==0){
    // Separate oracle only: dequantize the ORIGINAL quantized rows to float,
    // keep captured float activations and accumulate in double precision.
    auto traits=ggml_get_type_traits(w->type);assert(traits->to_float);
    std::vector<float>input(ce.input.size()/4),weights(w->ne[0]),oracle(a.size());memcpy(input.data(),ce.input.data(),ce.input.size());
    for(size_t lane=0;lane<ids.size();lane++)for(int64_t channel=0;channel<w->ne[1];channel++){
     auto ptr=(const char*)w->data+ids[lane]*w->nb[2]+channel*w->nb[1];traits->to_float(ptr,weights.data(),w->ne[0]);double sum=0;
     for(int64_t k=0;k<w->ne[0];k++)sum+=double(weights[k])*input[(lane%ce.b->ne[1])*w->ne[0]+k];
     oracle[lane*w->ne[1]+channel]=float(sum);
    }
    row["oracle_CPU"]=metric(oracle,a);row["oracle_static_CUDA"]=metric(oracle,b);row["oracle_cached_CUDA"]=metric(oracle,c);
   }
   result["states"].push_back(row);
  }
 }
 std::ofstream output(argv[2]);output<<result.dump(2);w->buffer=nullptr;w->data=nullptr;ggml_backend_buffer_free(host);ggml_backend_buffer_free(staticbuf);ggml_free(weightctx);llama_model_free(model);ggml_backend_free(cpu);ggml_backend_free(gpu);
}
