import type {VisualAnchor} from './visual-debugging';
/** Self-contained bounded DOM lookup. Never reads input values or guesses from coordinates. */
export function resolveBrowserAnchor(anchor:Pick<VisualAnchor,'selector'|'tag'|'identity'>&{text?:string},lookup:(selector:string)=>ArrayLike<Element>=s=>document.querySelectorAll(s)):{selector?:string;reason?:string;rebound?:boolean}{
  try{
    const text=(root:Element)=>{const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);let result='',node:Node|null,count=0;while((node=walker.nextNode())&&count++<200&&result.length<240)if(!node.parentElement?.closest('input,textarea,select,[contenteditable],[data-private],[data-sensitive],script,style'))result+=' '+node.textContent;return result.replace(/\s+/g,' ').trim().slice(0,240);};
    const identity=anchor.identity??(anchor.text?{text:anchor.text,context:''}:undefined);
    const exact=lookup(anchor.selector);
    if(exact.length>1)return {reason:'ambiguous-anchor'};
    if(exact.length===1){const e=exact[0];return e.tagName.toLowerCase()===anchor.tag&&(!identity||text(e)===identity.text&&(!identity.context||text(e.parentElement??e)===identity.context))?{selector:anchor.selector}:{reason:'anchor-identity-changed'};}
    const classes=Array.from(anchor.selector.matchAll(/\.(_[a-zA-Z][\w-]*?_[a-z0-9]+_\d+)(?=$|[\s.:#]|\[)/g),m=>m[1]);
    if(!classes.length||!identity||!anchor.tag.match(/^[a-z][a-z0-9-]*$/))return {reason:'element-missing'};
    const stem=(s:string)=>s.replace(/_[a-z0-9]+_\d+$/,'_');
    const candidates=lookup(anchor.tag+'[class]');if(candidates.length>200)return {reason:'anchor-search-limit'};
    const matches=Array.from(candidates).filter(e=>classes.some(c=>Array.from(e.classList).some(v=>/^_[a-zA-Z][\w-]*?_[a-z0-9]+_\d+$/.test(v)&&stem(v)===stem(c)))&&text(e)===identity.text&&(!identity.context||text(e.parentElement??e)===identity.context));
    if(matches.length!==1)return {reason:matches.length?'ambiguous-anchor':'element-missing'};
    const e=matches[0],name=Array.from(e.classList).find(v=>classes.some(c=>stem(v)===stem(c)))!,selector=anchor.tag+'.'+CSS.escape(name);
    return lookup(selector).length===1?{selector,rebound:true}:{reason:'ambiguous-anchor'};
  }catch{return {reason:'invalid-selector'};}
}
