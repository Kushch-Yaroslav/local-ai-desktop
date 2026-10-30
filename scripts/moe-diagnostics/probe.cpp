// Explicit diagnostic LD_PRELOAD instrumentation; no weight/model changes.
#include "llama.h"
#include "ggml-backend.h"
#include <dlfcn.h>
#include <cstdlib>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <string>
#include <vector>
#include <mutex>
#include <algorithm>
static std::mutex lock;
static thread_local bool inside=false;
extern "C" float * llama_get_logits_ith(llama_context * ctx,int32_t i) {
 auto real=(decltype(&llama_get_logits_ith))dlsym(RTLD_NEXT,"llama_get_logits_ith");
 float * values=real(ctx,i);
 const char * marker=getenv("LAD_LOGIT_MARKER");
 if(marker&&values){
  std::lock_guard<std::mutex> guard(lock);
  std::ifstream m(marker);std::string output;std::getline(m,output);
  static std::string last;static int count=0;
  if(last!=output){last=output;count=0;}
  if(!output.empty()&&count++<32){
   uint32_t n=llama_vocab_n_tokens(llama_model_get_vocab(llama_get_model(ctx)));
   FILE * f=fopen(output.c_str(),"ab");if(!f)std::abort();
   fwrite(&n,4,1,f);fwrite(values,4,n,f);fclose(f);
  }
 }
 return values;
}
struct sample {ggml_backend_t backend;ggml_tensor * tensor;size_t offset;std::vector<unsigned char> data;};
static std::vector<sample> pending;
static size_t uploads=0,checks=0,errors=0;
extern "C" void ggml_backend_tensor_set_async(ggml_backend_t backend,ggml_tensor * tensor,const void * data,size_t offset,size_t size){
 auto real=(decltype(&ggml_backend_tensor_set_async))dlsym(RTLD_NEXT,"ggml_backend_tensor_set_async");
 if(getenv("LAD_CHECK_UPLOADS")&&!inside&&ggml_backend_dev_type(ggml_backend_get_device(backend))==GGML_BACKEND_DEVICE_TYPE_GPU&&strstr(tensor->name,"moe_cache.")&&strstr(tensor->name,"_exps.weight")&&size>=1536){
  std::lock_guard<std::mutex> guard(lock);
  // Retire samples overwritten by subsequent queued writes before the next sync.
  pending.erase(std::remove_if(pending.begin(),pending.end(),[&](const sample&s){return s.tensor==tensor&&s.offset<offset+size&&offset<s.offset+s.data.size();}),pending.end());
  if(uploads++<64||uploads%1024==0){
   for(size_t at:{size_t(0),size/2,size-512}){
    sample s{backend,tensor,offset+at,{}};s.data.resize(512);memcpy(s.data.data(),(const char*)data+at,512);pending.push_back(std::move(s));
   }
  }
 }
 real(backend,tensor,data,offset,size);
}
extern "C" void ggml_backend_synchronize(ggml_backend_t backend){
 auto real=(decltype(&ggml_backend_synchronize))dlsym(RTLD_NEXT,"ggml_backend_synchronize");
 real(backend);
 if(inside||!getenv("LAD_CHECK_UPLOADS"))return;
 inside=true;
 {
  std::lock_guard<std::mutex> guard(lock);
  for(auto it=pending.begin();it!=pending.end();){
   if(it->backend!=backend){++it;continue;}
   std::vector<unsigned char> actual(it->data.size());
   ggml_backend_tensor_get(it->tensor,actual.data(),it->offset,actual.size());checks++;
   if(actual!=it->data){errors++;fprintf(stderr,"LAD_TRANSFER_MISMATCH tensor=%s offset=%zu\n",it->tensor->name,it->offset);std::abort();}
   it=pending.erase(it);
  }
 }
 inside=false;
}
__attribute__((destructor)) static void report(){
 if(getenv("LAD_CHECK_UPLOADS"))fprintf(stderr,"LAD_TRANSFER_CHECK uploads=%zu blocks=%zu errors=%zu pending=%zu\n",uploads,checks,errors,pending.size());
}
