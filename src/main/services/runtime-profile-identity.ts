import {createHash} from 'node:crypto';
import {statSync} from 'node:fs';
import type {RuntimeConfiguration} from '../../shared/types';
import {ggufArtifactPaths} from './gguf-artifacts';
import {effectiveRuntimeConfiguration} from './runtime-settings';
const identity=(path:string|null)=>{try{const s=statSync(path!);return [s.dev,s.ino,s.size,s.mtimeMs,s.ctimeMs];}catch{return null;}};
/** Request-only controls and names never dirty the backend launch configuration. */
export function runtimeProfileFingerprint(id:string,config:RuntimeConfiguration=effectiveRuntimeConfiguration()):string{
 const m=config.models.find(m=>m.id===id);if(!m)return '';
 return createHash('sha256').update(JSON.stringify({schema:1,server:config.llamaServerPath,serverIdentity:identity(config.llamaServerPath),model:m.modelPath,modelIdentity:ggufArtifactPaths(m.modelPath).map(path=>[path,identity(path)]),projector:m.mmprojPath,projectorIdentity:m.mmprojPath?identity(m.mmprojPath):null,gpuLayers:m.advanced?.mode==='automatic'?'auto':m.gpuLayers??config.gpuLayers,advanced:m.advanced??null,projectorDevice:config.imageProcessingDevice??m.projectorDevice??'auto',contextDefaults:{contextWindow:m.defaults?.contextWindow,kvCacheType:m.defaults?.kvCacheType,kvOffload:m.defaults?.kvOffload}})).digest('hex');
}
