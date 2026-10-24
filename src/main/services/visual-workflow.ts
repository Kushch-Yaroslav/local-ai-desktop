import type { BrowserQaReport } from '../../shared/browser-qa';
import type { VisualRegion } from '../../shared/visual-debugging';

/** Scoped proof only: a general layout pass cannot prove a selected label fits. */
export function provesOriginalRegions(report:BrowserQaReport|undefined,regions:VisualRegion[]):boolean {
  if(!report||report.status!=='Verified'||report.functionalStatus!=='Verified'||report.errors?.length||!regions.length)return false;
  return regions.every(region=>report.scenarios?.some(s=>{
    let url:string;try{url=new URL(s.target,region.url).href;}catch{return false;}
    const v=s.viewport,a=region.anchors[0];
    return Boolean(a&&a.confidence>=.8)&&url===region.url&&v?.width===region.viewport.width&&v.height===region.viewport.height&&s.status==='Verified'
      &&s.assertion.selector===a?.selector&&s.assertion.operator==='equals'&&(s.assertion.source==='text_fit'&&s.assertion.expected===0||s.assertion.source==='style'&&Boolean(a?.styles[s.assertion.path??''])&&s.assertion.expected!==a?.styles[s.assertion.path??'']&&!a?.findings?.some(f=>f.category==='text-clipping'))
      &&s.observations?.length>0&&s.observations.at(-1)?.value===s.assertion.expected;
  }));
}
