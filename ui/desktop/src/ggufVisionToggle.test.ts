// Local AI Desktop: disabling Vision changes launch configuration, never the stored projector path.
import {describe,it,expect} from 'vitest';
import {buildArguments} from './ggufConfig';
import type {GgufProfile} from './ggufTypes';
const p:GgufProfile={name:'Qwen fixture',model:'/models/target.gguf',projector:'/models/projector.gguf',executable:'/runtime/llama-server',gpuLayers:10,context:8192,draftTokens:3};
describe('Vision activation arguments',()=>{
 it('preserves legacy projector loading when the setting is unspecified',()=>{expect(buildArguments(p,1234)).toContain('--mmproj');});
 it('keeps the projector path but omits projector flags when explicitly disabled',()=>{const off={...p,visionEnabled:false,projectorCpu:true};const args=buildArguments(off,1234);expect(args).not.toContain('--mmproj');expect(args).not.toContain('--no-mmproj-offload');expect(off.projector).toBe(p.projector);expect(off.context).toBe(8192);});
 it.each(['off','mtp-embedded'] as const)('preserves MTP mode %s independently of Vision',mode=>{for(const visionEnabled of [false,true]){const args=buildArguments({...p,visionEnabled,speculativeMode:mode},1234);expect(args.includes('--mmproj')).toBe(visionEnabled);expect(args.includes('draft-mtp')).toBe(mode==='mtp-embedded');}});
});
