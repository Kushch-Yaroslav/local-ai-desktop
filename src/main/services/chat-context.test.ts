import './test-runtime-isolation';
import assert from 'node:assert/strict';
import { fitChatContext } from './chat-context';
import type { ToolCallingBackend, ToolMessage } from '../backends/types';
async function main(){
  let summaries=0;
  const backend={countInputTokens:async(_m:string,m:ToolMessage[])=>Math.ceil(JSON.stringify(m).length/2),chatWithTools:async()=>{summaries++;return {role:'assistant',content:'Historical objective, saved document cursor and writing continuity.',finish_reason:'stop'};}} as ToolCallingBackend;
  const history:ToolMessage[]=[{role:'system',content:'Pinned safe capabilities'},{role:'user',content:'Read attachment book-A to EOF'},{role:'assistant',content:'old history '.repeat(3000)},{role:'user',content:'Continue'},{role:'assistant',content:'',tool_calls:[{id:'c',function:{name:'read_file',arguments:'{}'}}]},{role:'tool',tool_call_id:'c',content:'Current source slice'}];
  const result=await fitChatContext(backend,'fixture',history,[],new AbortController().signal,24000,'fast','Read book-A','book-A hash=abc current_offset=240000',history[0].content);
  assert(result.compacted);assert.equal(summaries,1);assert(result.inputTokens<24000*0.65);assert(result.messages[0].content.includes('current_offset=240000'));assert(result.messages[0].content.includes('Read book-A'));
  for(let i=0;i<result.messages.length;i++)if(result.messages[i].role==='tool')assert(result.messages[i-1].tool_calls?.some(c=>c.id===result.messages[i].tool_call_id));
  assert.equal(history.length,6);assert.equal(history[2].content.length,'old history '.repeat(3000).length,'Full persisted answer must remain untouched');
  const normal=await fitChatContext(backend,'fixture',[{role:'user',content:'Hello'}],[],new AbortController().signal,65536,'fast','Hello');assert(!normal.compacted);assert.equal(summaries,1);
  const summaryInputs:string[]=[];
  const repeatedBackend={...backend,chatWithTools:async(_model:string,input:ToolMessage[])=>{summaryInputs.push(input[1].content);return {role:'assistant',content:'Retained first-pass-fact-782 and current decisions.',finish_reason:'stop'};}} as ToolCallingBackend;
  const second=await fitChatContext(repeatedBackend,'fixture',[
    {role:'system',content:'Safe prefix\nPreviously compacted: first-pass-fact-782'},
    {role:'assistant',content:'later history '.repeat(4000)},
    {role:'user',content:'Continue the original task'},
  ],[],new AbortController().signal,24000,'fast','Continue',undefined,'Safe prefix');
  assert(second.compacted);assert(summaryInputs.some(input=>input.includes('first-pass-fact-782')),'A second compaction must process the first summary');
  summaryInputs.length=0;
  const oversized=await fitChatContext(repeatedBackend,'fixture',[
    {role:'system',content:'Safe prefix'},
    {role:'assistant',content:'START-184 '+ 'old text '.repeat(32000)+' END-926'},
    {role:'user',content:'Continue'},
  ],[],new AbortController().signal,24000,'fast','Continue',undefined,'Safe prefix');
  assert(oversized.compacted);assert(summaryInputs.length>2,'History exceeding the physical window needs multiple bounded summaries');
  assert(summaryInputs.some(input=>input.includes('START-184')));assert(summaryInputs.some(input=>input.includes('END-926')),'The end of oversized history must also be processed');
  const compactedUserInputs:string[]=[];
  const compactedUserBackend={...backend,chatWithTools:async(_model:string,input:ToolMessage[])=>{compactedUserInputs.push(input[1].content);return {role:'assistant',content:'{"source_facts":["BLACK_HOLE_FACT_914"]}',finish_reason:'stop'};}} as ToolCallingBackend;
  const latestQuestion='What is inside the selected Canvas region? Read the source before answering.';
  const afterLargeResult=await fitChatContext(compactedUserBackend,'fixture',[
    {role:'system',content:'Read-only capabilities and selected project.'},
    {role:'user',content:latestQuestion},
    {role:'assistant',content:'',tool_calls:[{id:'read-source',function:{name:'read_project_file',arguments:'{"path":"index.html"}'}}]},
    {role:'tool',tool_call_id:'read-source',content:'BLACK_HOLE_FACT_914 '+ 'Canvas source '.repeat(12000)},
  ],[],new AbortController().signal,8192,'fast',latestQuestion,'selected project=project-A','Read-only capabilities and selected project.');
  assert(afterLargeResult.compacted);assert.equal(afterLargeResult.messages.at(-1)?.role,'user');assert.equal(afterLargeResult.messages.at(-1)?.content,latestQuestion,'The actual current user turn must survive as a user message after compaction.');
  assert(!afterLargeResult.messages.some(message=>message.role==='tool'),'An oversized protocol group must be summarized as a whole, without an orphan tool result.');
  assert(compactedUserInputs.some(input=>input.includes('BLACK_HOLE_FACT_914')),'Compaction must process the oversized read-only result before dropping its protocol group.');
  console.log('PASS Chat compaction: bounded history, complete tool protocol, pinned objective/source cursor, preserved current user turn, full answer unchanged, fast ordinary question');
}
void main();
