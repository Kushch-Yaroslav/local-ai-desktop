import {createHash} from 'node:crypto';

/** Canonical typography only: no case folding, word substitution or fuzzy semantic matching. */
function canonical(text:string) {
  const chars:string[]=[],starts:number[]=[],ends:number[]=[];
  for(const part of new Intl.Segmenter(undefined,{granularity:'grapheme'}).segment(text)) {
    const normalized=part.segment.normalize('NFC').replace(/[«»“”„]/g,'"').replace(/[‘’]/g,"'").replace(/[–—]/g,'-');
    for(const char of normalized) {
      const value=/\s/u.test(char)?' ':char;
      if(value===' '&&chars.at(-1)===' '){ends[ends.length-1]=part.index+part.segment.length;continue;}
      // One map entry per UTF-16 unit, matching String.indexOf offsets.
      for(let i=0;i<value.length;i++){chars.push(value[i]);starts.push(part.index);ends.push(part.index+part.segment.length);}
    }
  }
  return {text:chars.join(''),starts,ends};
}
export function sourceQuoteEvidence(source:string, candidate:unknown, offset=0):Record<string,unknown> {
  if(typeof candidate!=='string'||!candidate.trim())return {status:'unverified',reason:'missing_or_invalid_model_excerpt'};
  const exact=source.indexOf(candidate);
  if(exact>=0)return {status:'exact',start:offset+exact,end:offset+exact+candidate.length,quote:source.slice(exact,exact+candidate.length)};
  const original=canonical(source),needle=canonical(candidate).text.trim();
  const index=needle?original.text.indexOf(needle):-1;
  if(index>=0){const start=original.starts[index],end=original.ends[index+needle.length-1];return {status:'typography_normalized',start:offset+start,end:offset+end,quote:source.slice(start,end)};}
  return {status:'unverified',reason:'model_excerpt_not_in_source',model_excerpt:candidate.slice(0,1000)};
}

/** A receipt proves the submitted source range; it never certifies semantic correctness of model notes. */
export function prepareDocumentNotes(notes:Record<string,unknown>, source:string, start:number, attachmentId:string, contentHash:string) {
  const statuses:Record<string,number>={};
  function visit(value:unknown):unknown {
    if(Array.isArray(value))return value.map(visit);
    if(!value||typeof value!=='object')return value;
    const record=value as Record<string,unknown>,result:Record<string,unknown>={};
    for(const [key,child] of Object.entries(record))if(!['quote','source_quote','source_evidence','source_receipt'].includes(key))result[key]=visit(child);
    const quotes=['quote','source_quote'].filter(key=>Object.hasOwn(record,key));
    if(quotes.length)result.source_evidence=quotes.map(key=>{
      const evidence=sourceQuoteEvidence(source,record[key],start);const status=String(evidence.status);statuses[status]=(statuses[status]??0)+1;return evidence;
    });
    return result;
  }
  const summary={...visit(notes) as Record<string,unknown>,source_receipt:{attachment_id:attachmentId,content_hash:contentHash,start,end:start+source.length,chunk_sha256:createHash('sha256').update(source).digest('hex'),status:'completed_model_response_with_notes',notes_status:'model_claims_not_independently_verified',delivery_excerpt:{start,end:start+Math.min(160,source.length),text:source.slice(0,160)},quote_checks:statuses}};
  return summary;
}

/** Inference needs all facts and source references, not repeated storage receipts/hashes. */
export function documentNoteForModel(note:import('./document-memory').DocumentChunkNote) {
  let summary:unknown;
  try { const facts=JSON.parse(note.summary);delete facts.source_receipt;summary=facts; } catch { summary=note.summary; }
  return {start:note.start,end:note.end,observation_id:note.observationId,summary};
}
