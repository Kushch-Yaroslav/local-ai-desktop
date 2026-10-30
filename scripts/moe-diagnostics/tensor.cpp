#include "ggml.h"
#include "ggml-backend.h"
#include "ggml-alloc.h"
#include <fstream>
#include <vector>
#include <cmath>
#include <cstring>
#include <cassert>
#include <iostream>
#include <cstdlib>
std::vector<float> run(ggml_backend_t backend,int type,int ni,int no,const std::vector<char>& bytes,bool slot){
 auto ctx=ggml_init({4*1024*1024,nullptr,true});assert(ctx);
 auto w=ggml_new_tensor_3d(ctx,(ggml_type)type,ni,no,slot?2:1);ggml_set_name(w,"moe_cache.blk.0.ffn_gate_exps.weight");
 auto b=ggml_new_tensor_3d(ctx,GGML_TYPE_F32,ni,1,1);
 auto ids=ggml_new_tensor_2d(ctx,GGML_TYPE_I32,1,1);
 auto out=ggml_mul_mat_id(ctx,w,b,ids);assert(ggml_backend_supports_op(backend,out));
 auto graph=ggml_new_graph_custom(ctx,128,false);ggml_build_forward_expand(graph,out);
 auto buffer=ggml_backend_alloc_ctx_tensors(ctx,backend);assert(buffer);
 std::vector<float> input(ni);for(int i=0;i<ni;i++)input[i]=std::sin(i*0.13f)*0.25f;
 int id=slot?1:0;ggml_backend_tensor_set(ids,&id,0,4);ggml_backend_tensor_set(b,input.data(),0,ni*4);
 if(slot){ // overwrite a prior slot value before computing from the final upload
  std::vector<char> previous(bytes.size(),0);ggml_backend_tensor_set_async(backend,w,previous.data(),w->nb[2],bytes.size());ggml_backend_synchronize(backend);
 }
 assert(w->nb[2]==bytes.size());
 ggml_backend_tensor_set_async(backend,w,bytes.data(),id*w->nb[2],bytes.size());
 if(slot && std::getenv("LAD_INJECT_CORRUPTION")) {
  auto bad=bytes;bad[0]^=1;ggml_backend_tensor_set(w,bad.data(),id*w->nb[2],bad.size());
 }
 ggml_backend_synchronize(backend);
 // Explicit sync/read-back control, not a race stress test.
 assert(ggml_backend_graph_compute(backend,graph)==GGML_STATUS_SUCCESS);
 std::vector<float> result(no);ggml_backend_tensor_get(out,result.data(),0,no*4);
 std::vector<char> actual(bytes.size());ggml_backend_tensor_get(w,actual.data(),id*w->nb[2],actual.size());assert(actual==bytes);
 ggml_backend_buffer_free(buffer);ggml_free(ctx);return result;
}
int main(int argc,char**argv){
 assert(argc==2);std::ifstream f(argv[1],std::ios::binary);int h[4];f.read((char*)h,sizeof(h));assert(f);
 int type=h[0],ni=h[1],no=h[2],size=h[3];std::vector<char> bytes(size);f.read(bytes.data(),size);assert(f);
 ggml_backend_load_all();auto cpu=ggml_backend_init_by_name("CPU",nullptr);auto gpu=ggml_backend_init_by_name("CUDA0",nullptr);assert(cpu&&gpu);
 auto a=run(cpu,type,ni,no,bytes,false);auto b=run(gpu,type,ni,no,bytes,false);auto c=run(gpu,type,ni,no,bytes,true);
 double max_cpu=0,mae=0,max_slot=0,ref=0;
 for(int i=0;i<no;i++){max_cpu=std::max(max_cpu,double(std::abs(a[i]-b[i])));mae+=std::abs(a[i]-b[i]);ref+=std::abs(a[i]);max_slot=std::max(max_slot,double(std::abs(b[i]-c[i])));}
 std::cout<<"{\"ggml_type\":"<<type<<",\"input\":"<<ni<<",\"output\":"<<no<<",\"CPU_CUDA_max_abs\":"<<max_cpu<<",\"CPU_CUDA_mean_abs\":"<<mae/no<<",\"CPU_mean_abs\":"<<ref/no<<",\"CUDA_static_slot_max_abs\":"<<max_slot<<",\"full_expert_bytes_equal\":true}\n";
 ggml_backend_free(cpu);ggml_backend_free(gpu);
}
