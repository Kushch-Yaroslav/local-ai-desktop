// Explicit opt-in preparation. Reads the real source/GGUF; writes only a new
// /tmp fixture. The optional delivery baseline is harness-authored, not a new
// Qwen implementation or a restoration of a lost checkpoint.
import assert from 'node:assert/strict';
import {cp,mkdir,mkdtemp,readFile,writeFile,readdir,stat} from 'node:fs/promises';
import {openSync,closeSync} from 'node:fs';
import {resolve,join,relative} from 'node:path';
import {createHash} from 'node:crypto';
import {spawn,execFileSync} from 'node:child_process';
import {createServer} from 'node:net';
const source=process.env.LOCAL_AI_TEST_SHOP_SOURCE;assert(source&&resolve(source)===source,'Explicit absolute source directory required');
const binary=process.env.LOCAL_AI_TEST_LLAMA_SERVER??resolve('../llama.cpp/build-cuda/bin/llama-server');
const model=process.env.LOCAL_AI_TEST_QWEN_GGUF??resolve('../llama-models/Qwen3.6-35B-A3B-Q4_K_M/Qwen3.6-35B-A3B-UD-Q4_K_M.gguf');
await stat(binary);await stat(model);
const free=Number(execFileSync('nvidia-smi',['--query-gpu=memory.free','--format=csv,noheader,nounits'],{encoding:'utf8'}).trim());assert(free>22000,'Need free GPU memory; never unload an existing model');
const root=await mkdtemp('/tmp/lad-online-shop-qwen-'),project=join(root,'project');
const hashes={};async function inventory(directory){for(const entry of await readdir(directory,{withFileTypes:true})){const path=join(directory,entry.name);if(entry.isDirectory())await inventory(path);else if(entry.isFile())hashes[relative(source,path)]=createHash('sha256').update(await readFile(path)).digest('hex');}}
await inventory(join(source,'src'));await writeFile(join(root,'user-project-hashes.json'),JSON.stringify(hashes),{mode:0o600});
await cp(source,project,{recursive:true,filter:path=>{const rel=relative(source,path);return !rel.split('/').some(part=>['.git','.local-ai-backups','.vite'].includes(part))&&!['dist','shop.zip'].includes(rel.split('/')[0]);}});
const reconstructed=process.argv.includes('--verification-baseline');
if(reconstructed){
 const directory=join(project,'src/Module/Home/Widgets/Content/DeliveryInfo');await mkdir(directory,{recursive:true});
 await writeFile(join(directory,'DeliveryInfo.tsx'),'import {useProduct} from "@/Context/ProductContext";\nimport css from "./DeliveryInfo.module.css";\nexport default function DeliveryInfo(){const product=useProduct();return product.delivery?<section className={css.delivery}>{product.delivery}</section>:null;}\n');
 await writeFile(join(directory,'DeliveryInfo.module.css'),'.delivery{padding:24px;text-align:center;border-block:1px solid #ddd;font-size:18px}\n');
 const update=async(file,edit)=>{const path=join(project,file);await writeFile(path,edit(await readFile(path,'utf8')));};
 await update('src/Module/Home/Home.tsx',s=>'import DeliveryInfo from "./Widgets/Content/DeliveryInfo/DeliveryInfo";\n'+s.replace('                <section id={BlockIdNavigate.otherItems}', '                {product.delivery && <DeliveryInfo/>}\n                <section id={BlockIdNavigate.otherItems}'));
 await update('src/Shared/Interfaces/item.ts',s=>s.replace('export interface Product {','export interface Product {\n    delivery?: string;'));
 await update('src/Shared/Utils/mergeProduct.ts',s=>s.replace('export type BaseProduct = {','export type BaseProduct = {\n    delivery?: string;').replace('        id: base.id,','        id: base.id,\n        delivery: base.delivery,').replace('            id: l.id,','            id: l.id,\n            delivery: l.delivery,'));
 await update('src/JSON-Content/base-items.json',s=>JSON.stringify(JSON.parse(s).map(item=>({...item,...(item.id===1?{delivery:'Consegna stimata: 2–3 giorni'}:item.id===2?{delivery:'Consegna stimata: 4–5 giorni'}:{})})),null,2)+'\n');
}
const listener=createServer();await new Promise(r=>listener.listen(0,'127.0.0.1',r));const port=listener.address().port;await new Promise(r=>listener.close(r));
const out=openSync(join(root,'llama-server.log'),'w',0o600);
const child=spawn(binary,['-m',model,'--alias','qwen3.6:35b-a3b-ud-q4_k_m','--host','127.0.0.1','--port',String(port),'--ctx-size','65536','--parallel','1','--gpu-layers','999','--n-cpu-moe','6','--threads','8','--threads-batch','8','--batch-size','512','--ubatch-size','128','--flash-attn','on','--cache-type-k','q8_0','--cache-type-v','q8_0','--jinja','--fit','off','--no-warmup','--spec-type','none'],{detached:true,stdio:['ignore',out,out]});
await new Promise((r,reject)=>{child.once('spawn',r);child.once('error',reject);});child.unref();closeSync(out);
const meta={root,project,port,modelId:'qwen3.6:35b-a3b-ud-q4_k_m',context:65536,pid:child.pid,binary,baseline:reconstructed?'reconstructed verification baseline; prior /tmp checkpoint unavailable':'source copy; model implements the task'};
await writeFile('/tmp/lad-online-shop-current.json',JSON.stringify(meta),{mode:0o600});await writeFile(join(root,'metadata.json'),JSON.stringify(meta),{mode:0o600});console.log(JSON.stringify({root,pid:child.pid,port,baseline:meta.baseline}));
