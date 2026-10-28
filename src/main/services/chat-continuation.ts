/** Chat-only response budget. Agent turn/tool/security budgets are independent. */
export const CHAT_OUTPUT_TOKEN_LIMIT=50_000;
export const CHAT_CONTINUATION_REQUEST_LIMIT=32;
export const chatContinuationInstruction='Continue the SAME answer exactly where it stopped. Do not repeat its introduction, headings or previous paragraphs. Preserve the existing Markdown/code fence state; do not reopen a fence already open. Produce only the next part. Stop naturally when the requested answer is complete.';

/** Delay only an ambiguous repeated boundary, bounded to the last 8K chars. */
export class ChatContinuationBoundary{
  private pending='';private decided=false;
  constructor(private readonly previous:string){}
  push(text:string){if(this.decided)return text;this.pending+=text;return this.drain(false);}
  finish(){return this.drain(true);}
  private drain(final:boolean){
    if(this.decided)return '';
    const tail=this.previous.slice(-8192);let overlap=0,partial=false;
    for(let i=0;i<tail.length;i++){const suffix=tail.slice(i);if(this.pending.startsWith(suffix))overlap=Math.max(overlap,suffix.length);else if(suffix.startsWith(this.pending))partial=true;}
    if(!final&&partial&&this.pending.length<8192)return '';
    this.decided=true;const result=this.pending.slice(overlap);this.pending='';return result;
  }
}
