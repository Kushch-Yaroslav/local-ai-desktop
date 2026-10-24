/** Self-contained browser function: never reads input values or executable paths. */
export function inspectBrowserDom(input:{selector?:string;properties?:string[]}) {
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
    const all=document.querySelectorAll(input.selector);
    return {inspection:{url:location.href,viewport:{width:innerWidth,height:innerHeight},matches:all.length,elements:Array.from(all).slice(0,10).map(e=>{
      const r=e.getBoundingClientRect(),s=getComputedStyle(e);
      return {tag:e.tagName,text:text(e,300),rect:{x:r.x,y:r.y,width:r.width,height:r.height},clientWidth:e.clientWidth,clientHeight:e.clientHeight,scrollWidth:e.scrollWidth,scrollHeight:e.scrollHeight,styles:Object.fromEntries((input.properties??[]).map(p=>[p,s.getPropertyValue(p).slice(0,120)]))};
    })}};
  }
  return {title:document.title,url:location.href,content:document.body?text(document.body,12000):'',links:Array.from(document.querySelectorAll('a[href]')).slice(0,40).map(a=>({text:text(a,300),href:(a as HTMLAnchorElement).href}))};
}
