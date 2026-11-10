import {expect,it} from 'vitest';
import {parseDiscoveryFailure,safeDiscoveryError} from './discoveryFailure';
it('decodes Electron IPC details without losing the primary stage and restore result',()=>{
 const details={runId:'run',stage:'generation',context:94208,kv:'q8_0',reason:'CUDA error: out of memory',restoration:'left-unloaded'};
 expect(parseDiscoveryFailure("Error invoking remote method 'gguf-discovery-run': Error: GGUF:discoveryFailed:"+JSON.stringify(details))).toEqual(details);
 expect(parseDiscoveryFailure('GGUF:discoveryFailed:{invalid')).toBeNull();
 expect(safeDiscoveryError('Bearer private-token')).not.toContain('private-token');
});
