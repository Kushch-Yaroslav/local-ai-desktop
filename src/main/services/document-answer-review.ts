/** Application-owned block IDs avoid asking a model to reproduce exact text for edits. */
export function documentAnswerBlocks(answer:string) { return answer.split('\n\n').map((text,id)=>({id,text})); }
export function applyDocumentAnswerEdits(answer:string,value:unknown) {
  if(!value||typeof value!=='object'||!Array.isArray((value as {edits?:unknown}).edits))throw new Error('Document answer review returned invalid edits. Source progress is saved.');
  const blocks=documentAnswerBlocks(answer),seen=new Set<number>();
  for(const edit of (value as {edits:unknown[]}).edits) {
    if(!edit||typeof edit!=='object')throw new Error('Invalid document review edit.');
    const {block_id,replacement}=edit as {block_id:number;replacement:string};
    if(!Number.isSafeInteger(block_id)||block_id<0||block_id>=blocks.length||seen.has(block_id)||typeof replacement!=='string')throw new Error('Invalid or duplicate document review block ID. Source progress is saved.');
    seen.add(block_id);blocks[block_id].text=replacement;
  }
  const content=blocks.map(b=>b.text).join('\n\n');
  if(!content.trim())throw new Error('Document answer review produced an empty answer. Source progress is saved.');
  return {content,editedBlocks:seen.size};
}

/** A chapter-summary request does not authorize presenting extra model themes as plot facts. */
export function trimUnrequestedInterpretations(answer:string,lastChapterTitle:string) {
  const number=/(?:Глава|Chapter)\s+(\d+)/iu.exec(lastChapterTitle)?.[1];
  if(!number)return answer;
  const blocks=answer.split('\n\n');
  const chapter=blocks.findIndex(block=>new RegExp(`^(?:[#*\\s]*)(?:Глава|Chapter)\\s+${number}(?!\\d)`,'iu').test(block));
  if(chapter<0)return answer;
  const relative=blocks.slice(chapter+1).findIndex(block=>/^#{1,6}[^\n]*(?:иде[яи]|смысл|интерпрет|тем[аы]|themes?|meaning)/iu.test(block));
  if(relative<0)return answer;
  let cut=chapter+1+relative;if(/^\s*(?:---|\*\*\*)\s*$/.test(blocks[cut-1]??''))cut--;
  return blocks.slice(0,cut).join('\n\n').trimEnd();
}

function quantities(text:string) {
  const numbers:Record<string,string>={один:'1',одна:'1',одно:'1',два:'2',две:'2',три:'3',четыре:'4',пять:'5',шесть:'6',семь:'7',восемь:'8',девять:'9',десять:'10',пару:'2',пара:'2'};
  return [...text.toLowerCase().matchAll(/(\d+|один|одна|одно|два|две|три|четыре|пять|шесть|семь|восемь|девять|десять|пару|пара)\s+(секунд[а-яё]*|минут[а-яё]*|час[а-яё]*|день|дня|дней|недел[а-яё]*|месяц[а-яё]*|год[а-яё]*|лет)/gu)].map(m=>`${numbers[m[1]]??m[1]}:${/^(день|дня|дней)$/.test(m[2])?'day':m[2].startsWith('недел')?'week':m[2].startsWith('месяц')?'month':/^(год|лет)/.test(m[2])?'year':m[2].startsWith('час')?'hour':m[2].startsWith('минут')?'minute':'second'}`);
}
/** Narrow deterministic check: a review must not introduce new unsupported time quantities in the ending. */
export function unsupportedClosingQuantities(answer:string,edits:unknown,lastChapterTitle:string,closingSource:string) {
  const number=/(?:Глава|Chapter)\s+(\d+)/iu.exec(lastChapterTitle)?.[1];if(!number)return [];
  const blocks=documentAnswerBlocks(answer),allowed=new Set(quantities(closingSource)),issues:string[]=[];
  const heading=new RegExp(`(?:Глава|Chapter)\\s+${number}(?!\\d)`,'iu');
  for(const edit of (edits as {edits?:Array<{block_id:number;replacement:string}>})?.edits??[]) {
    const prior=blocks[edit.block_id]?.text;if(!prior||!heading.test(prior)||typeof edit.replacement!=='string')continue;
    const existing=new Set(quantities(prior));
    for(const quantity of quantities(edit.replacement))if(!allowed.has(quantity)&&!existing.has(quantity))issues.push(`block ${edit.block_id}: ${quantity}`);
  }
  return [...new Set(issues)];
}
