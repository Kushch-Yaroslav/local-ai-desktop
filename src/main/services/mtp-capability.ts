import { execFile } from 'node:child_process';
import { createReadStream, realpathSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import type { MtpCapability, MtpMode } from '../../shared/types';
import { readGgufSpeculativeMetadata } from './gguf-speculative';
import { ggufArtifactPaths } from './gguf-artifacts';
import { executablePath } from './runtime-settings';
import { probeBackendFeatures } from './backend-capabilities';

/** Only graph families inspected/tested for embedded MTP, not ordinary draft models. */
export function embeddedMtpCapability(path: string): MtpCapability {
  try {
    const metadata = readGgufSpeculativeMetadata(path);
    const architecture = String(metadata.values['general.architecture'] ?? '');
    if (!['qwen35', 'qwen35moe'].includes(architecture)) return { supported: false, status: 'unsupported', architecture, reason: `Embedded MTP is not validated for architecture ${architecture || 'unknown'}.` };
    const heads = Number(metadata.values[`${architecture}.nextn_predict_layers`] ?? 0);
    if (heads !== 1) return { supported: false, status: heads === 0 ? 'requires-weights' : 'unsupported', architecture, heads, reason: heads === 0 ? 'This GGUF has no embedded MTP head. Compatible additional weights would be required; automatic downloads are disabled.' : 'This backend integration supports one Qwen MTP head.' };
    const block = Number(metadata.values[`${architecture}.block_count`]) - 1;
    const embedding = Number(metadata.values[`${architecture}.embedding_length`]);
    const tensors = Object.assign({}, ...ggufArtifactPaths(path).map(file => readGgufSpeculativeMetadata(file).tensors ?? {})) as Record<string, number[]>;
    const prefix = `blk.${block}.nextn.`;
    const projection = tensors[prefix + 'eh_proj.weight'];
    if (!tensors['blk.0.attn_norm.weight'] || !projection || projection[0] !== embedding * 2 || projection[1] !== embedding || !['enorm.weight', 'hnorm.weight'].every(name => tensors[prefix + name]?.[0] === embedding)) {
      return { supported: false, status: 'requires-weights', architecture, heads, reason: 'GGUF metadata declares MTP but the full target/embedded head tensors are missing or incompatible.' };
    }
    return { supported: true, status: 'available', architecture, heads, reason: 'Embedded Qwen MTP tensors verified. Activation still requires successful backend initialization.' };
  } catch (error) { return { supported: false, status: 'error', reason: `Cannot inspect MTP weights: ${error instanceof Error ? error.message : String(error)}` }; }
}
/** External draft-mtp is accepted only when the GGUF pair proves architecture, dimensions, context and tokenizer compatibility. */
export function externalMtpCompatibility(targetPath:string,draftPath:string):MtpCapability{
 try{
  const target=readGgufSpeculativeMetadata(targetPath),draft=readGgufSpeculativeMetadata(draftPath);
  const architecture=String(target.values['general.architecture']??''),draftArchitecture=String(draft.values['general.architecture']??'');
  if(!['qwen3next','qwen35','qwen35moe'].includes(architecture))return {supported:false,state:'unknown',status:'unsupported',architecture,reason:'External MTP graph/layout is not validated for this architecture.'};
  const targetEmbedding=Number(target.values[`${architecture}.embedding_length`]),draftOutput=Number(draft.values[`${draftArchitecture}.embedding_length_out`]??(Number(draft.values[`${draftArchitecture}.nextn_predict_layers`])>0?draft.values[`${draftArchitecture}.embedding_length`]:undefined));
  const draftContext=Number(draft.values[`${draftArchitecture}.context_length`]),targetContext=Number(target.values[`${architecture}.context_length`]);
  const heads=Number(draft.values[`${draftArchitecture}.nextn_predict_layers`]??0);
  if(!architecture||draftArchitecture!==architecture||!(targetEmbedding>0)||draftOutput!==targetEmbedding||!(heads>0)||!(draftContext>=targetContext))
   return {supported:false,state:'misconfigured',status:'unsupported',architecture: draftArchitecture||architecture,heads,reason:'MTP Draft не подтверждает совпадение архитектуры, embedding, nextn head и контекста с основной GGUF.'};
  const tensors=draft.tensors??{}, head=Object.keys(tensors).find(key=>/^blk\.\d+\.nextn\.eh_proj\.weight$/.test(key));
  const prefix=head?.replace('eh_proj.weight','');
  if(!head||tensors[head][0]!==targetEmbedding*2||tensors[head][1]!==targetEmbedding||!prefix||!['enorm.weight','hnorm.weight'].every(name=>tensors[prefix+name]?.[0]===targetEmbedding))
   return {supported:false,state:'misconfigured',status:'unsupported',architecture,heads,reason:'External MTP head tensor layout is missing or incompatible; metadata alone does not prove MTP weights.'};
  for(const key of ['model','tokens','merges','bos_token_id','add_bos_token']){
   const field=`tokenizer.ggml.${key}`;
   if(!target.tokenizer[field]||target.tokenizer[field]!==draft.tokenizer[field])return {supported:false,state:'misconfigured',status:'unsupported',architecture,heads,reason:`Несовместимый tokenizer MTP Draft: ${field}.`};
  }
  return {supported:true,status:'available',architecture,heads,reason:'External MTP-only GGUF matches model architecture, dimensions, context and tokenizer. Backend initialization is still required to confirm activation.'};
 }catch(error){return {supported:false,state:'misconfigured',status:'error',reason:`Cannot inspect external MTP Draft: ${error instanceof Error?error.message:String(error)}`};}
}
export async function prepareExternalMtpDraft(targetPath:string,draftPath:string,maxDraftTokens=2):Promise<{path:string;maxDraftTokens:number;sizeBytes:number;sha256:string}>{
 if(!Number.isInteger(maxDraftTokens)||maxDraftTokens<1||maxDraftTokens>16)throw new Error('MTP n-max must be an integer from 1 to 16.');
 const capability=externalMtpCompatibility(targetPath,draftPath);
 if(!capability.supported)throw new Error(`MTP Draft incompatible: ${capability.reason}`);
 const file=statSync(draftPath);if(!file.isFile())throw new Error(`MTP Draft is not a file: ${draftPath}`);
 const hash=createHash('sha256');for await(const chunk of createReadStream(draftPath))hash.update(chunk);
 return {path:draftPath,maxDraftTokens,sizeBytes:file.size,sha256:hash.digest('hex')};
}
export type BackendMtpProbe = { status: 'supported' | 'unsupported' | 'error'; path?: string; reason: string };
const probes = new Map<string, Promise<BackendMtpProbe>>();
/** Read the option's entire help block, including wrapped enum values. */
export function advertisesMtp(help: string): boolean {
  const block = /(?:^|\s)--spec-type\b([\s\S]*?)(?=\n\S|$)/.exec(help);
  return Boolean(block && /\bdraft-mtp\b/.test(block[1]));
}
export async function probeBackendMtp(input: string | null): Promise<BackendMtpProbe> {
  try {
    // Match runtimeSetup's PATH fallback rather than treating an unset override
    // as proof that the launcher cannot support MTP.
    const path = realpathSync(executablePath(input ?? 'llama-server')), file = statSync(path);
    const key = `${path}:${file.dev}:${file.ino}:${file.size}:${file.mtimeMs}:${file.ctimeMs}:${Math.floor(Date.now() / 60_000)}`;
    let result = probes.get(key);
    if (!result) {
      result = new Promise<BackendMtpProbe>(resolve => execFile(path, ['--help'], { timeout: 10_000, maxBuffer: 1024 * 1024, env: { ...process.env, LC_ALL: 'C' } }, (error, stdout, stderr) => {
        if (error) {
          resolve({ status: 'error', path, reason: `Cannot probe llama-server ${path}: ${error.message}. ${stderr.trim().slice(-1500)}` });
        } else {
          const supported = advertisesMtp(stdout + '\n' + stderr);
          resolve({ status: supported ? 'supported' : 'unsupported', path, reason: supported ? `llama-server ${path} advertises --spec-type draft-mtp.` : `llama-server ${path} --help does not advertise --spec-type draft-mtp.` });
        }
      }));
      probes.set(key, result);
      if (probes.size > 16) probes.delete(probes.keys().next().value!);
      // A transient timeout/exec failure is unknown capability, never a cached
      // negative. Share concurrent probes, allow the next request to recover.
      void result.then(value => { if (value.status === 'error' && probes.get(key) === result) probes.delete(key); });
    }
    return await result;
  } catch (error) { return { status: 'error', reason: `Cannot resolve llama-server: ${error instanceof Error ? error.message : String(error)}` }; }
}
export async function backendMtpCapability(input: string | null): Promise<boolean> {
  return (await probeBackendMtp(input)).status === 'supported';
}
export async function mtpCapability(path: string, server: string | null,draftPath?:string): Promise<MtpCapability> {
  if(draftPath)return externalMtpCapability(path,draftPath,server);
  const model = embeddedMtpCapability(path), backend = await probeBackendMtp(server);
  const backendSupported = backend.status === 'error' ? undefined : backend.status === 'supported';
  if (!model.supported) return { ...model, backendSupported };
  return backend.status === 'supported' ? { ...model, backendSupported }
    : { ...model, supported: false, backendSupported, status: backend.status === 'error' ? 'error' : 'unsupported', reason: backend.reason };
}
export async function externalMtpCapability(targetPath:string,draftPath:string,server:string|null):Promise<MtpCapability>{
 const pair=externalMtpCompatibility(targetPath,draftPath),backend=await probeBackendMtp(server);
 const backendSupported=backend.status==='error'?undefined:backend.status==='supported';
 if(!pair.supported)return {...pair,backendSupported};
 if(!backendSupported)return {supported:false,status:backend.status==='error'?'error':'unsupported',architecture:pair.architecture,heads:pair.heads,backendSupported,reason:backend.reason};
 const features=await probeBackendFeatures(server);
 const required=['--spec-type','--spec-draft-n-max','--spec-draft-model','--gpu-layers-draft'];
 const missing=required.filter(flag=>!features.flags.includes(flag));
 if(features.status!=='supported'||missing.length)return {supported:false,status:features.status==='error'?'error':'unsupported',architecture:pair.architecture,heads:pair.heads,backendSupported,reason:features.status==='error'?(features.reason??'Не удалось проверить CLI-возможности llama-server.'):`llama-server не сообщает флаги внешнего MTP draft: ${missing.join(', ')}.`};
 return {...pair,backendSupported};
}
export async function resolveMtpMode(mode: MtpMode, path: string, server: string | null,draftPath?:string): Promise<'mtp' | 'none'> {
  if (mode === 'off') return 'none';
  const capability = await mtpCapability(path, server,draftPath);
  if (mode === 'on' && !capability.supported) throw new Error(`MTP On unavailable: ${capability.reason}`);
  return capability.supported ? 'mtp' : 'none';
}
