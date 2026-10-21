// Actual launch-config CLI preflight with tiny real GGUF files. Does not start llama-server.
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
const root=await mkdtemp('/tmp/lad-feature-preflight-');await mkdir(join(root,'app-data'));
const u32=n=>{const b=Buffer.alloc(4);b.writeUInt32LE(n);return b;},u64=n=>{const b=Buffer.alloc(8);b.writeBigUInt64LE(BigInt(n));return b;},str=s=>Buffer.concat([u64(Buffer.byteLength(s)),Buffer.from(s)]);
const path=join(root,'text.gguf');await writeFile(path,Buffer.concat([Buffer.from('GGUF'),u32(3),u64(0),u64(1),str('general.architecture'),u32(8),str('gpt-oss')]));
const id='custom:123e4567-e89b-42d3-a456-426614174222';
await writeFile(join(root,'app-data/runtime-settings.json'),JSON.stringify({schemaVersion:2,modelsPath:root,gpuLayers:0,llamaServerPath:null,browserVision:'on',models:[{id,displayName:'Text preflight',modelPath:path,mmprojPath:'',gpuLayers:0,supportsTools:true,builtin:false,speculative:'none',mtpMode:'off',mtpDraft:{path:join(root,'missing-draft.gguf'),sha256:'a'.repeat(64),sizeBytes:1,maxDraftTokens:2}}]}));
const output=execFileSync(process.execPath,[resolve('dist/main/models/llama-launch-config.js'),id,'--preflight'],{env:{...process.env,LOCAL_AI_RUNTIME_ROOT:root,LOCAL_AI_MTP_MODE:'off'},encoding:'utf8',timeout:10000});
assert.match(output,/PROFILE_VISION_REQUIRED='0'/);assert.match(output,/SPECULATIVE_MODE='none'/);assert.match(output,/DRAFT_MODEL=''/);assert.match(output,/MMPROJ=''/);
console.log(JSON.stringify({result:'PASS',root,checks:['legacy global Vision On does not block text-model preflight','MTP Off ignores missing configured draft','actual CLI process, no server start']}));
