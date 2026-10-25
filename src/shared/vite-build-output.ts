/** Literal configuration inspection only. Never executes JS/TS or follows imports. */
export function literalViteOutputs(source:string):{present:boolean;directories:string[]}{
  const tokens:Array<{value:string;literal?:boolean}>=[];
  for(let i=0;i<source.length;){
    const c=source[i];
    if(/\s/.test(c)){i++;continue;}
    if(source.startsWith('//',i)){const end=source.indexOf('\n',i+2);i=end<0?source.length:end+1;continue;}
    if(source.startsWith('/*',i)){const end=source.indexOf('*/',i+2);i=end<0?source.length:end+2;continue;}
    if(c==='"'||c==="'"||c==='`'){
      let value='',escaped=false;i++;
      while(i<source.length&&source[i]!==c){if(source[i]==='\\'){escaped=true;i+=2;}else value+=source[i++];}
      i++;tokens.push({value, literal:c!=='`'&&!escaped});continue;
    }
    const word=source.slice(i).match(/^[\w$]+/);
    if(word){tokens.push({value:word[0]});i+=word[0].length;}
    else {tokens.push({value:c});i++;}
  }
  const directories=new Set<string>();let present=false;
  for(let i=0;i<tokens.length-2;i++){
    if(tokens[i].value!=='build'||tokens[i+1].value!==':'||tokens[i+2].value!=='{')continue;
    let depth=1;
    for(let j=i+3;j<tokens.length&&depth;j++){
      if(tokens[j].value==='{')depth++;
      else if(tokens[j].value==='}')depth--;
      else if(depth===1&&tokens[j].value==='outDir'&&tokens[j+1]?.value===':'){
        present=true;const token=tokens[j+2];
        if(token?.literal){const dir=token.value.replace(/^\.\//,'').replace(/\/$/,'');if(dir.split('/').every(part=>/^[\w-]+$/.test(part)))directories.add(dir);}
      }
    }
  }
  return {present,directories:[...directories]};
}
