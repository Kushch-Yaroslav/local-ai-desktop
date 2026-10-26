import assert from 'node:assert/strict';
import {mkdtemp,writeFile,symlink} from 'node:fs/promises';
import {join} from 'node:path';
import {createRequire} from 'node:module';
import {chromium} from 'playwright-core';
process.env.LOCAL_AI_RUNTIME_ROOT=await mkdtemp('/tmp/lad-spatial-geometry-');
const require=createRequire(import.meta.url);const {groundRegion}=require('../dist/main/web/visual-selection.js');
const {Database}=require('../dist/main/services/database.js');const db=new Database(join(process.env.LOCAL_AI_RUNTIME_ROOT,'ownership.db'));const chat=db.createConversation(),task=db.resolveLogicalTask(chat.id),other=db.resolveLogicalTask(chat.id);const owned=db.addMessage(chat.id,'user','Original absence constraint',undefined,[],{logicalTaskId:task});const foreign=db.addMessage(chat.id,'user','Other task',undefined,[],{logicalTaskId:other});const restored=db.taskHistory(chat.id,task,[{...owned,logicalTaskId:undefined},foreign]);assert.equal(restored.length,1);assert.equal(restored[0].logicalTaskId,task);db.close();
const {matchesDevSourceMap,readPreviewAsset}=require('../dist/main/web/project-browser.js');
const source=Buffer.from('export default function App(){return null}');
const encoded=value=>Buffer.from('compiled transform\n//# sourceMappingURL=data:application/json;base64,'+Buffer.from(JSON.stringify(value)).toString('base64'));
assert(matchesDevSourceMap(encoded({version:3,sourcesContent:[source.toString()]}),source));
assert(!matchesDevSourceMap(encoded({version:3,sourcesContent:['old source']}),source));
assert(!matchesDevSourceMap(Buffer.from('no source map'),source));
assert(!matchesDevSourceMap(encoded({version:2,sourcesContent:[source.toString()]}),source));
const sourceRoot=await mkdtemp('/tmp/lad-dev-source-');await writeFile(join(sourceRoot,'App.jsx'),source);await writeFile(join(sourceRoot,'.env'),'PRIVATE');await symlink(join(sourceRoot,'App.jsx'),join(sourceRoot,'link.jsx'));
await assert.rejects(readPreviewAsset(sourceRoot,'/App.jsx'),'Uncompiled source remains blocked in static serving');
assert.deepEqual((await readPreviewAsset(sourceRoot,'/App.jsx',false,true)).body,source);
await assert.rejects(readPreviewAsset(sourceRoot,'/link.jsx',false,true));await assert.rejects(readPreviewAsset(sourceRoot,'/.env',false,true));
console.log('PASS exact dev source maps, stale/missing map rejection, private/symlink/static-source guards');
const browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:1000,height:900}});
try{
 await page.setContent('<style>body{margin:0}main{display:flex;flex-direction:column;gap:100px}section{height:200px}</style><main id="composition"><section id="a">Above<input value="PRIVATE_CONTROL"><span data-private>PRIVATE_TEXT</span></section><section id="b">Below</section></main>');
 for(const rect of [{x:20,y:180,width:900,height:140},{x:20,y:210,width:900,height:80},{x:0,y:0,width:1000,height:500}]){const r=await groundRegion(page,rect);assert.equal(r.surroundings.relation,'between-siblings');assert.equal(r.surroundings.above.selector,'#a');assert.equal(r.surroundings.below.selector,'#b');assert(r.surroundings.confidence<1);assert(!JSON.stringify(r).includes('PRIVATE_'));}
 await page.setContent('<style>body{margin:0}.col{width:45%;float:left}section{height:200px;margin-bottom:100px}</style><div class="col"><section>A</section><section>B</section></div><div class="col"><section>C</section><section>D</section></div>');
 assert.equal((await groundRegion(page,{x:0,y:180,width:1000,height:140})).surroundings.relation,'ambiguous','Competing columns must not invent one insertion pair');
 await page.setContent('<style>body{margin:0}section{height:200px}.gap{height:100px}</style><div><section>A</section></div><div class="gap"></div><div><section>B</section></div>');
 assert.equal((await groundRegion(page,{x:0,y:180,width:1000,height:140})).surroundings.relation,'ambiguous','Different DOM subtrees require source inspection');
 console.log('PASS crossing selection, empty gap, large rectangle, private text, competing columns and different subtrees');
}finally{await browser.close();}
