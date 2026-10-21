// Real IPC/attachment encoding + HTTP/SSE fixture. No real multimodal inference.
import assert from 'node:assert/strict';
import {mkdtemp,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createServer} from 'node:http';
import {_electron} from 'playwright-core';
const root=await mkdtemp('/tmp/lad-vision-image-routing-'),bodies=[];let multimodal=true,app;
const server=createServer(async(req,res)=>{
 const chunks=[];for await(const part of req)chunks.push(part);
 if(req.url==='/v1/models'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({models:[{capabilities:multimodal?['multimodal']:['completion']}],data:[{id:'qwen3.8:27b-q4_K_M',meta:{n_ctx:65536}}]}));return;}
 if(req.url?.endsWith('/input_tokens')){res.setHeader('Content-Type','application/json');res.end('{"input_tokens":256}');return;}
 if(req.url==='/health'){res.end('{}');return;}
 const body=JSON.parse(Buffer.concat(chunks).toString()||'{}');bodies.push(body);
 res.setHeader('Content-Type','text/event-stream');res.end('data: {"choices":[{"delta":{"content":"Fixture response; not real image interpretation."},"finish_reason":null}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
});
try{
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
 app=await _electron.launch({executablePath:resolve('scripts/electron-unconfined-fixture.sh'),args:[resolve('test-fixtures/live-browser/electron-main.cjs')],env:{...process.env,LOCAL_AI_RUNTIME_ROOT:root,LOCAL_AI_LLAMA_CPP_URL:base,LOCAL_AI_AGENT_ENDPOINT:base+'/v1/chat/completions'}});
 await app.evaluate(({net})=>{globalThis.fetch=net.fetch.bind(net);});
 const page=await app.firstWindow();page.setDefaultTimeout(20000);await page.locator('.conversation').waitFor();
 const id=await page.evaluate(async()=> (await window.localAi.conversations.list()).find(c=>c.title==='Live Browser workspace').id);
 await page.evaluate(async id=>{await window.localAi.runtime.control({action:'restart',conversationId:id,modelId:'qwen3.8:27b-q4_K_M'});await window.localAi.mtp.apply('qwen3.8:27b-q4_K_M','off',true,id);await window.localAi.conversations.update(id,{mode:'chat'});},id);
 const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aPYsAAAAASUVORK5CYII=','base64');
 const turn=async(mode,attach=true,injected=false)=>page.evaluate(async({id,mode,png,attach,injected})=>{
  await window.localAi.browserQa.configure(mode,false,true,id);
  const messageId=crypto.randomUUID(),generationId=crypto.randomUUID();
  const user={id:messageId,conversationId:id,role:'user',content:'Image routing '+mode,createdAt:new Date().toISOString(),...(injected?{images:['data:image/png;base64,UNTRUSTED']}:{})};
  await window.localAi.chat.send({conversationId:id,model:'qwen3.8:27b-q4_K_M',mode:'chat',messages:[user],generationId,persistUserMessage:true,...(attach?{attachments:[{messageId,index:0,filename:'image.png',mimeType:'image/png',data:new Uint8Array(png)}]}:{})});
  return {messageId,attachments:await window.localAi.attachments.list(messageId)};
 },{id,mode,png:[...png],attach,injected});
 const imageParts=body=>(body?.messages??[]).flatMap(m=>Array.isArray(m.content)?m.content:[]).filter(c=>c.type==='image_url');
 const off=await turn('off');assert.equal(imageParts(bodies.at(-1)).length,0);assert.equal(off.attachments.length,1);assert.match(off.attachments[0].error,/Vision выключен/);
 const auto=await turn('auto');assert.equal(imageParts(bodies.at(-1)).length,1);assert.equal(auto.attachments[0].messageId,auto.messageId);assert.match(imageParts(bodies.at(-1))[0].image_url.url,/^data:image\/png;base64,/);
 await turn('on');assert.equal(imageParts(bodies.at(-1)).length,1,'On uses the same current-image pipeline');
 await turn('auto',false);assert.equal(imageParts(bodies.at(-1)).length,0,'Auto does not attach unrelated historical images');
 await turn('off',false,true);assert.equal(imageParts(bodies.at(-1)).length,0,'renderer payload cannot bypass Off');
 multimodal=false;const blocked=await turn('auto');assert.equal(imageParts(bodies.at(-1)).length,0);assert.equal(blocked.attachments.length,1);
 assert.equal(bodies.length,6,'every turn reached the controlled backend');
 const gptId='custom:123e4567-e89b-42d3-a456-426614174233',gptPath=root+'/gpt-switch.gguf';
 const n64=n=>{const b=Buffer.alloc(8);b.writeBigUInt64LE(BigInt(n));return b;},n32=n=>{const b=Buffer.alloc(4);b.writeUInt32LE(n);return b;},text=s=>Buffer.concat([n64(Buffer.byteLength(s)),Buffer.from(s)]);
 await writeFile(gptPath,Buffer.concat([Buffer.from('GGUF'),n32(3),n64(0),n64(1),text('general.architecture'),n32(8),text('gpt-oss')]));
 const config=(await page.evaluate(()=>window.localAi.settings.get())).setup.config;assert(config.llamaServerPath.startsWith(root));
 await writeFile(config.llamaServerPath,'#!/bin/sh\necho "--model --ctx-size --port --spec-type none,draft-mtp"\n',{mode:0o700});
 await page.evaluate(async({config,gptId,gptPath})=>{await window.localAi.settings.save({...config,models:[...config.models,{id:gptId,displayName:'GPT switch fixture',modelPath:gptPath,mmprojPath:'',gpuLayers:0,supportsTools:true,builtin:false,speculative:'none',mtpMode:'on'}]});const chat=await window.localAi.conversations.create(gptId);await window.localAi.conversations.update(chat.id,{modelId:gptId});const settings=await window.localAi.settings.get();if(settings.llamaRuntime.mtpMode!=='off'||settings.llamaRuntime.speculativeMode!=='none')throw Error('Unsupported inherited MTP On was passed to the launcher');const vision=await window.localAi.browserQa.status(chat.id);if(vision.available)throw Error('Another model\'s multimodal declaration leaked into the selected text model');}, {config,gptId,gptPath});
 console.log(JSON.stringify({result:'PASS',root,scope:'Actual Electron/SQLite/IPC/image bytes; controlled HTTP/SSE, not model inference',checks:['chat Off suppresses bytes but retains attachment','Auto sends current image to correct user turn','no unrelated image replay','renderer cannot inject images','backend capability removed suppresses payload','active model switch suppresses unsupported inherited MTP On','foreign model multimodal capability is rejected']}));
}finally{await app?.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
