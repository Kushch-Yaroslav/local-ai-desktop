// Real local GGUFs, CUDA, production launcher/controller and image inference.
// Isolated runtime, dedicated port; never signals an existing launcher.
import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {mkdtemp,writeFile,readFile,mkdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createRequire} from 'node:module';
import {createServer} from 'node:net';
import {createHash} from 'node:crypto';
const root=await mkdtemp('/tmp/lad-p3-matrix-');process.env.LOCAL_AI_RUNTIME_ROOT=root;
const require=createRequire(import.meta.url);require('../dist/main/services/paths.js').ensureAppDirectories();
const {loadRuntimeConfiguration,saveRuntimeConfiguration}=require('../dist/main/services/runtime-settings.js');
const {LlamaRuntimeController}=require('../dist/main/services/llama-runtime-controller.js');
const {mtpCapability,probeBackendMtp}=require('../dist/main/services/mtp-capability.js');
const {BrowserVisionProvider,liveMultimodal}=require('../dist/main/services/browser-vision.js');
const {parseMtpMetrics}=require('../dist/main/services/mtp-diagnostics.js');
const free=Number(execFileSync('nvidia-smi',['--query-gpu=memory.free','--format=csv,noheader,nounits'],{encoding:'utf8'}).trim());assert(free>21000,'Refuse to compete with an existing model');
const binary=resolve('../llama.cpp/build-cuda/bin/llama-server');
const config={...loadRuntimeConfiguration(),llamaServerPath:binary,imageProcessingDevice:'cpu',browserVision:'on',models:loadRuntimeConfiguration().models.filter(m=>!m.id.startsWith('huihui'))};saveRuntimeConfiguration(config);
const socket=createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const port=socket.address().port;await new Promise(r=>socket.close(r));const base=`http://127.0.0.1:${port}`,endpoint=base+'/v1/chat/completions';
const control=new LlamaRuntimeController({stateFile:join(root,'llama-cpp-runtime-state.json'),requestFile:join(root,'llama-cpp-runtime-request.env'),launcherPidFile:join(root,'llama-cpp-mtp-launcher.pid')});
const logFile=await import('node:fs').then(fs=>fs.openSync(join(root,'launcher-console.log'),'w'));
const launcher=spawn('bash',[resolve('run-local-ai-desktop-llama-cpp-mtp.sh')],{env:{...process.env,LOCAL_AI_APP_DIR:resolve('.'),LOCAL_AI_LLAMA_PORT:String(port),LOCAL_AI_LAUNCHER_HEADLESS:'1',LOCAL_AI_PARENT_PID:String(process.pid)},stdio:['ignore',logFile,logFile]});
const delay=ms=>new Promise(r=>setTimeout(r,ms)),result={root,binary,rows:[],capabilities:[],errors:[]},pids=[];
const output=resolve('docs/test-results/p3/qwen-matrix.json');const persist=async()=>writeFile(output,JSON.stringify(result,null,2));let browser;
try {
 for(let i=0;(await control.state()).status!=='idle';i++){assert(i<150&&launcher.exitCode===null,await readFile(join(root,'launcher-console.log'),'utf8'));await delay(100);}
 result.backend=await probeBackendMtp(binary);assert.equal(result.backend.status,'supported');
 browser=await require('../dist/main/web/web-tools.js').launchWebBrowser();
 const page=await browser.newPage({viewport:{width:384,height:256}});await page.setContent('<body style="margin:0;background:#101820;color:#fff;font:24px sans-serif"><h1>Browser QA</h1><button style="padding:12px">Ready</button></body>');
 const imagePath=join(root,'browser.png'),bytes=await page.screenshot({path:imagePath});
 const capture={id:'p3',path:imagePath,sha256:createHash('sha256').update(bytes).digest('hex'),width:384,height:256,viewport:{width:384,height:256},region:{x:0,y:0,width:384,height:256},url:'about:blank',capturedAt:new Date().toISOString(),bytes:bytes.length};
 for(const model of config.models){
  const cap=await mtpCapability(model.modelPath,binary);result.capabilities.push({model:model.id,...cap});assert(cap.supported,JSON.stringify(cap));
  for(const [mode,vision,context] of [['on','on',16384],['auto','on',16384],['off','on',16384],['on','off',16384],['off','off',12288]]){
   saveRuntimeConfiguration({...loadRuntimeConfiguration(),browserVision:vision});const before=await control.state(),start=performance.now();
   const sw=await control.switchTo(model.id,context,'q8_0',true,'cpu',mode);assert(sw.ok,JSON.stringify(sw));pids.push(sw.state.serverPid);
   assert.equal(sw.state.modelId,model.id);assert.equal(sw.state.contextWindow,context);assert.equal(sw.state.speculativeMode,mode==='off'?'none':'mtp');assert(await liveMultimodal(endpoint));
   if(before.serverPid){assert.throws(()=>process.kill(before.serverPid,0),'old process must exit');}
   const response=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({model:model.id,messages:[{role:'user',content:'List the first ten positive integers, separated by commas. No explanation.'}],max_tokens:64,temperature:0,chat_template_kwargs:{enable_thinking:false}}),signal:AbortSignal.timeout(90000)});const body=await response.json();assert(response.ok,JSON.stringify(body));assert(body.choices[0].message.content.length>0);
   const metricsResponse=await fetch(base+'/metrics'),metrics=parseMtpMetrics(await metricsResponse.text());
   let visual;
   if(vision==='on'&&mode==='on'){visual=await new BrowserVisionProvider(endpoint,model.id).analyze(capture,AbortSignal.timeout(90000));assert(visual.analyzed,JSON.stringify(visual));}
   result.rows.push({model:model.id,mode,vision,context,elapsedMs:performance.now()-start,state:sw.state,content:body.choices[0].message.content,metrics,visual});await persist();console.log(JSON.stringify({model:model.id,mode,vision,context,metrics,analyzed:visual?.analyzed}));
  }
 }
 // A missing target projector fails in the production launcher and restores
 // the previous healthy model; no user model/configuration is touched.
 const previous=await control.state(),target=config.models.find(m=>m.id!==previous.modelId);
 saveRuntimeConfiguration({...loadRuntimeConfiguration(),browserVision:'on',models:config.models.map(m=>m.id===target.id?{...m,mmprojPath:join(root,'missing-projector.gguf')}:m)});
 const failed=await control.switchTo(target.id,8192,'q8_0',true,'cpu','on');result.preflightFailure=failed;assert(!failed.ok);assert.equal(failed.state.modelId,previous.modelId);assert.equal(failed.state.status,'ready');assert.equal(failed.state.serverPid,previous.serverPid,'invalid configuration is rejected before stop');result.preflightFailure=failed;
 const invalidProjector=join(root,'invalid-projector.gguf');await writeFile(invalidProjector,'not a GGUF');
 saveRuntimeConfiguration({...config,models:config.models.map(m=>m.id===target.id?{...m,mmprojPath:invalidProjector}:m)});
 const rollback=await control.switchTo(target.id,8192,'q8_0',true,'cpu','on');assert(!rollback.ok);assert.equal(rollback.state.modelId,previous.modelId);assert.equal(rollback.state.status,'ready');assert.equal(rollback.state.rolledBack,true);result.failureRecovery=rollback;
 saveRuntimeConfiguration(config);const retry=await control.switchTo(target.id,8192,'q8_0',true,'cpu','on');assert(retry.ok,JSON.stringify(retry));pids.push(retry.state.serverPid);result.retry=retry;result.result='PASS';
} catch(error){result.errors.push(String(error));throw error;}finally{
 await browser?.close();launcher.kill('SIGTERM');await Promise.race([new Promise(r=>launcher.once('exit',r)),delay(15000)]);result.cleanup=pids.map(pid=>{try{process.kill(pid,0);return{pid,alive:true};}catch{return{pid,alive:false};}});await mkdir(resolve('docs/test-results/p3'),{recursive:true});await persist();console.log(output);
}
