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
  console.log('PASS Chat compaction: bounded history, complete tool protocol, pinned objective/source cursor, full answer unchanged, fast ordinary question');
}
void main();
