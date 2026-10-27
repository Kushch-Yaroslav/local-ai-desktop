import {isAbsolute,relative,resolve,sep} from 'node:path';
import type {AgentPlan} from '../../shared/types';
import {qaViewport} from './responsive-qa';

export type VerificationRouteScope={deliverable_id:string;criterion_id:string;target:string;viewport:{width:number;height:number}};
/** Only validated, persisted task criteria for this project's source paths. */
export function verificationRouteScopes(memory:AgentPlan['taskMemory'],root:string):VerificationRouteScope[]{
  const inside=(path:string)=>{const rel=relative(resolve(root),resolve(path));return isAbsolute(path)&&rel!=='..'&&!rel.startsWith('..'+sep)&&!isAbsolute(rel);};
  return (memory?.deliverables?.items??[]).filter(item=>item.status!=='dropped'&&Boolean(item.paths?.length)&&item.paths!.every(inside)).flatMap(item=>(item.criteria??[]).flatMap(criterion=>{
    const spec=criterion.scenario;if(!spec?.target||!spec.viewport)return [];
    try{return [{deliverable_id:item.id,criterion_id:criterion.id,target:spec.target,viewport:qaViewport(spec.viewport)}];}catch{return [];}
  }));
}
