#include "ggml.h"
#include "ggml-backend.h"
#include "nlohmann/json.hpp"
#include <dlfcn.h>
#include <fstream>
#include <set>
#include <string>
#include <cstdlib>
using json=nlohmann::json;
static std::set<std::string> captured;
static json descriptor(ggml_tensor*t){return {{"name",t->name},{"type",int(t->type)},{"ne",{t->ne[0],t->ne[1],t->ne[2],t->ne[3]}},{"nb",{t->nb[0],t->nb[1],t->nb[2],t->nb[3]}},{"bytes",ggml_nbytes(t)}};}
static bool selected(ggml_tensor*t){
 if(t->op!=GGML_OP_MUL_MAT_ID||t->src[0]->ne[2]!=512||t->src[2]->ne[1]!=1)return false;
 std::string n=t->src[0]->name;
 return (n.find("blk.0.")!=std::string::npos||n.find("blk.1.")!=std::string::npos)&&!captured.count(n)&&n.find("_exps.weight")!=std::string::npos;
}
static bool callback(ggml_tensor*t,bool ask,void*){
 if(!getenv("LAD_CAPTURE_DIR"))return false;
 std::ifstream marker(getenv("LAD_LOGIT_MARKER"));std::string request;std::getline(marker,request);
 if(request.empty())return false;
 bool take=selected(t);if(ask)return take;if(!take)return true;
 std::string weight=t->src[0]->name;captured.insert(weight);
 std::string stem=std::string(getenv("LAD_CAPTURE_DIR"))+"/op-"+std::to_string(captured.size());
 json meta={{"weight",descriptor(t->src[0])},{"input",descriptor(t->src[1])},{"ids",descriptor(t->src[2])},{"output",descriptor(t)},{"request_marker",request},{"epoch","first incremental decode after prompt"},{"op_params",json::array()}};
 for(int v:t->op_params)meta["op_params"].push_back(v);
 for(auto pair:{std::make_pair("input",t->src[1]),std::make_pair("ids",t->src[2]),std::make_pair("output",t)}){
  std::vector<char> data(ggml_nbytes(pair.second));ggml_backend_tensor_get(pair.second,data.data(),0,data.size());
  std::ofstream f(stem+"."+pair.first+".bin",std::ios::binary);f.write(data.data(),data.size());
 }
 std::ofstream f(stem+".json");f<<meta.dump(2);return true;
}
extern "C" void ggml_backend_sched_set_eval_callback(ggml_backend_sched_t sched,ggml_backend_sched_eval_callback old,void*data){
 auto real=(decltype(&ggml_backend_sched_set_eval_callback))dlsym(RTLD_NEXT,"ggml_backend_sched_set_eval_callback");
 if(getenv("LAD_CAPTURE_DIR")){if(old)std::abort();real(sched,callback,nullptr);}else real(sched,old,data);
}
