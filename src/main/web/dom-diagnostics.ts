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
    return {inspection:{observedAt,documentVersion:{timeOrigin:performance.timeOrigin,hmrAppliedAt:Number((window as unknown as {__ladHmrAt?:number}).__ladHmrAt??0)},provenance:'current-browser-observation',anchorResolution:{...resolution,originalSelector:input.selector},url:location.href,viewport:{width:innerWidth,height:innerHeight},matches:all.length,page:{root:{clientWidth:document.documentElement.clientWidth,scrollWidth:document.documentElement.scrollWidth},body:document.body?{clientWidth:document.body.clientWidth,scrollWidth:document.body.scrollWidth}:null},elements:Array.from(all).slice(0,10).map(e=>{
      const r=e.getBoundingClientRect(),s=getComputedStyle(e);
      const containedAnchors=(input.anchorSelectors??[]).filter(selector=>{try{const hint=input.anchors?.find(a=>a.selector===selector),resolved=hint&&resolve?resolve(hint):{selector};const anchors=resolved.selector?document.querySelectorAll(resolved.selector):[];return anchors.length===1&&e.contains(anchors[0]);}catch{return false;}});
      return {containedAnchors,tag:e.tagName,text:text(e,300),rect:{x:r.x,y:r.y,width:r.width,height:r.height},clientWidth:e.clientWidth,clientHeight:e.clientHeight,scrollWidth:e.scrollWidth,scrollHeight:e.scrollHeight,styles:Object.fromEntries((input.properties??[]).map(p=>{const value=s.getPropertyValue(p);return [p,/url\s*\(/i.test(value)?'[URL omitted]':value.slice(0,120)];}))};
    })}};
  }
  return {documentVersion:{timeOrigin:performance.timeOrigin,viewport:{width:innerWidth,height:innerHeight}},title:document.title,url:location.href,content:document.body?text(document.body,12000):'',links:Array.from(document.querySelectorAll('a[href]')).slice(0,40).map(a=>({text:text(a,300),href:(a as HTMLAnchorElement).href}))};
}
