import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Database} from './database';
import {visionPreference,mtpPreference} from '../../shared/model-features';
const root=mkdtempSync(join(tmpdir(),'lad-feature-db-')),file=join(root,'test.sqlite');
let db=new Database(file);
try{
 const a=db.createConversation('qwen'),b=db.createConversation('gpt-oss');
 assert.equal(a.visionMode,null);assert.equal(a.mtpMode,null);
 assert.equal(visionPreference(a,{browserVision:'on'}),'on','legacy global preference is inherited without rewriting chats');
 db.updateConversation(a.id,{visionMode:'auto',mtpMode:'on'});
 db.updateConversation(b.id,{visionMode:'off',mtpMode:'off'});
 db.close();db=new Database(file);
 assert.equal(db.getConversation(a.id)?.visionMode,'auto');assert.equal(db.getConversation(a.id)?.mtpMode,'on');
 assert.equal(db.getConversation(b.id)?.visionMode,'off');assert.equal(db.getConversation(b.id)?.mtpMode,'off');
 db.updateConversation(a.id,{title:'Another task'});assert.equal(db.getConversation(a.id)?.visionMode,'auto');
 assert.equal(mtpPreference(db.getConversation(a.id)!,{id:'text',displayName:'Text',modelPath:'/missing',mmprojPath:'',gpuLayers:0,supportsTools:true,builtin:false,speculative:'none'}),'on','stored preference is not capability or a promise to launch');
 assert.throws(()=>db.updateConversation(a.id,{visionMode:'wrong' as 'auto'}),/Invalid/);
 console.log('PASS additive SQLite preference migration, legacy inheritance, separate chats, restart and non-destructive updates');
}finally{db.close();rmSync(root,{recursive:true,force:true});}
