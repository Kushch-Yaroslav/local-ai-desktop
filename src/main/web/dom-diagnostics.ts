import type {VisualAnchor} from '../../shared/visual-debugging';
import type {resolveBrowserAnchor} from '../../shared/browser-anchor';
/** Self-contained browser function: never reads input values or executable paths. */
export function inspectBrowserDom(input:{selector?:string;properties?:string[];anchorSelectors?:string[];anchors?:Array<Pick<VisualAnchor,'selector'|'tag'|'identity'>>},resolve?:typeof resolveBrowserAnchor) {
  const privateSelector='input,textarea,select,[contenteditable],[data-private],[data-sensitive],script,style';
  const text=(root:Element,limit:number)=>{
    if(root.closest(privateSelector))return '[private]';
    const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);let output='',node:Node|null,count=0;
    while((node=walker.nextNode())&&count++<2000&&output.length<limit){
      const parent=node.parentElement;if(!parent||parent.closest(privateSelector))continue;
      const style=getComputedStyle(parent);if(style.display==='none'||style.visibility==='hidden'||Number(style.opacity)===0)continue;
      output+=' '+(node.textContent??'');
    }
    return output.trim().slice(0,limit);
  };
  if(input.selector!==undefined){
    const hint=input.anchors?.find(a=>a.selector===input.selector);
    const resolution=hint&&resolve?resolve(hint):{selector:input.selector};
    const all=resolution.selector?document.querySelectorAll(resolution.selector):[];
    const observedAt=new Date().toISOString();
    const ancestorId=/^#([A-Za-z_][\w-]*)/.exec(input.selector)?.[1];
    const ancestor=!all.length&&ancestorId?document.getElementById(ancestorId):null;
    const selectorHint=(e:Element)=>{
      if(e.id){const value='#'+CSS.escape(e.id);try{if(document.querySelectorAll(value).length===1)return value;}catch{/* A malformed DOM identifier cannot provide a selector hint. */}}
      const testId=e.getAttribute('data-testid');if(testId){const value=`[data-testid="${testId.replaceAll('"','\\"')}"]`;try{if(document.querySelectorAll(value).length===1)return value;}catch{/* A malformed test id cannot provide a selector hint. */}}
      const classes=Array.from(e.classList).slice(0,3).map(name=>'.'+CSS.escape(name)).join('');
      if(classes){const value=e.tagName.toLowerCase()+classes;try{if(document.querySelectorAll(value).length===1)return value;}catch{/* A malformed CSS Modules class is omitted. */}}
      if(ancestor?.id&&ancestor.contains(e)){
        let current:Element|null=e;const path:string[]=[];
        for(let depth=0;current&&current!==ancestor&&depth<6;depth++){
          const tag=current.tagName.toLowerCase(),siblings=Array.from(current.parentElement?.children??[]).filter(sibling=>sibling.tagName===current!.tagName);path.unshift(tag+`:nth-of-type(${siblings.indexOf(current)+1})`);current=current.parentElement;
        }
        if(current===ancestor&&path.length){const value='#'+CSS.escape(ancestor.id)+' > '+path.join(' > ');if(document.querySelectorAll(value).length===1)return value;}
      }
      return e.tagName.toLowerCase();
    };
    const facts=(e:Element)=>{const r=e.getBoundingClientRect();return {tag:e.tagName.toLowerCase(),id:e.id||undefined,classes:Array.from(e.classList).slice(0,6),testId:e.getAttribute('data-testid')||undefined,selectorHint:selectorHint(e),text:text(e,220),rect:{x:r.x,y:r.y,width:r.width,height:r.height},visible:r.width>0&&r.height>0&&getComputedStyle(e).visibility!=='hidden'};};
    const elements=Array.from(all).slice(0,10).map(e=>{
      const s=getComputedStyle(e);
      const containedAnchors=(input.anchorSelectors??[]).filter(selector=>{try{const hint=input.anchors?.find(a=>a.selector===selector),resolved=hint&&resolve?resolve(hint):{selector};const anchors=resolved.selector?document.querySelectorAll(resolved.selector):[];return anchors.length===1&&e.contains(anchors[0]);}catch{return false;}});
      return {...facts(e),containedAnchors,clientWidth:e.clientWidth,clientHeight:e.clientHeight,scrollWidth:e.scrollWidth,scrollHeight:e.scrollHeight,styles:Object.fromEntries((input.properties??[]).map(p=>{const value=s.getPropertyValue(p);return [p,/url\s*\(/i.test(value)?'[URL omitted]':value.slice(0,120)];}))};
    });
    const candidates=all.length?[]:(ancestor?[ancestor,...Array.from(ancestor.querySelectorAll('*')).slice(0,80)]:Array.from(document.querySelectorAll('main,main > *,section,article,[data-testid],h1,h2,h3'))).filter(e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0&&getComputedStyle(e).visibility!=='hidden';}).slice(0,24).map(facts);
    return {inspection:{observedAt,documentVersion:{timeOrigin:performance.timeOrigin,hmrAppliedAt:Number((window as unknown as {__ladHmrAt?:number}).__ladHmrAt??0)},provenance:'current-browser-observation',anchorResolution:{...resolution,originalSelector:input.selector},url:location.href,viewport:{width:innerWidth,height:innerHeight},matches:all.length,page:{root:{clientWidth:document.documentElement.clientWidth,scrollWidth:document.documentElement.scrollWidth},body:document.body?{clientWidth:document.body.clientWidth,scrollWidth:document.body.scrollWidth}:null},elements,candidate_context:ancestor?{selector:'#'+CSS.escape(ancestor.id),basis:'existing selector ancestor'}:undefined,candidate_elements:candidates}};
  }
  const structure=Array.from(document.querySelectorAll('main,section,article,aside,[role=region]')).filter(e=>!e.closest('[data-private],[data-sensitive],input,textarea,select,[contenteditable]')).slice(0,24).map(e=>{
    let selector:string|undefined;
    const id=e.id?'#'+CSS.escape(e.id):undefined;
    if(id&&document.querySelectorAll(id).length===1)selector=id;
    if(!selector){const classes=Array.from(e.classList).slice(0,3).map(c=>'.'+CSS.escape(c)).join(''),candidate=e.tagName.toLowerCase()+classes;if(document.querySelectorAll(candidate).length===1)selector=candidate;}
    if(!selector){let current:Element|null=e;const parts:string[]=[];for(let depth=0;current&&depth<6;depth++){
      const siblings=Array.from(current.parentElement?.children??[]).filter(node=>node.tagName===current!.tagName);parts.unshift(current.tagName.toLowerCase()+`:nth-of-type(${siblings.indexOf(current)+1})`);const candidate=parts.join(' > ');if(document.querySelectorAll(candidate).length===1){selector=candidate;break;}current=current.parentElement;
    }}
    const r=e.getBoundingClientRect();return {tag:e.tagName.toLowerCase(),selector,text:text(e,90),children:e.childElementCount,height:Math.round(r.height),visible:r.width>0&&r.height>0};
  });
  return {structure,diagnostic_guidance:'The outline includes empty semantic containers. If expected content is absent, inspect conditional rendering and its actual provider/data transformation before guessing more selectors or adding another component. read returns page text/outline; use inspect with a returned unique selector for targeted facts.',documentVersion:{timeOrigin:performance.timeOrigin,viewport:{width:innerWidth,height:innerHeight}},title:document.title,url:location.href,content:document.body?text(document.body,12000):'',links:Array.from(document.querySelectorAll('a[href]')).slice(0,40).map(a=>({text:text(a,300),href:(a as HTMLAnchorElement).href}))};
}
