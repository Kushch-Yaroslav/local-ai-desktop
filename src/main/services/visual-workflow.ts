import type { BrowserQaReport } from '../../shared/browser-qa';
import type { VisualRegion } from '../../shared/visual-debugging';

/** Scoped proof only: a general layout pass cannot prove a selected label fits. */
export function provesOriginalRegions(report:BrowserQaReport|undefined,regions:VisualRegion[]):boolean {
  if(!report||report.status!=='Verified'||report.functionalStatus!=='Verified'||report.errors?.length||!regions.length)return false;
  return regions.every(region=>report.scenarios?.some(s=>{
    let url:string;try{url=new URL(s.target,region.url).href;}catch{return false;}
    const v=s.viewport,a=region.anchors[0];
    return url===region.url&&v?.width===region.viewport.width&&v.height===region.viewport.height&&s.status==='Verified'
      &&s.assertion.source==='text_fit'&&s.assertion.selector===a?.selector&&s.assertion.operator==='equals'&&s.assertion.expected===0
      &&s.observations?.length>0&&s.observations.at(-1)?.value===0;
  }));
}
