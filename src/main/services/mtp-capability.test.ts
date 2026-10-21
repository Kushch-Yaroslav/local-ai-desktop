import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { embeddedMtpCapability, externalMtpCompatibility, mtpCapability, resolveMtpMode, probeBackendMtp, advertisesMtp, prepareExternalMtpDraft } from './mtp-capability';
import { parseMtpMetrics } from './mtp-diagnostics';
const root = mkdtempSync(join(tmpdir(), 'mtp-capability-'));
const u32 = (n: number) => { const b=Buffer.alloc(4);b.writeUInt32LE(n);return b; };
const u64 = (n: number) => { const b=Buffer.alloc(8);b.writeBigUInt64LE(BigInt(n));return b; };
const text = (s: string) => Buffer.concat([u64(Buffer.byteLength(s)),Buffer.from(s)]);
function fixture(name: string, architecture='qwen35', heads=1, tensors=true, payload=true) {
  const items: Array<[string, string | number]>=[['general.architecture',architecture],[`${architecture}.block_count`,2],[`${architecture}.embedding_length`,4],[`${architecture}.nextn_predict_layers`,heads]];
  const tensorItems: Array<[string, number[], number]> = tensors ? [['blk.0.attn_norm.weight',[4],0],['blk.1.nextn.eh_proj.weight',[8,4],32],['blk.1.nextn.enorm.weight',[4],160],['blk.1.nextn.hnorm.weight',[4],192]]:[];
  const header=Buffer.concat([Buffer.from('GGUF'),u32(3),u64(tensorItems.length),u64(items.length),...items.flatMap(([key,value])=>[text(key),u32(typeof value==='string'?8:4),typeof value==='string'?text(value):u32(value)]),...tensorItems.flatMap(([key,shape,offset])=>[text(key),u32(shape.length),...shape.map(u64),u32(0),u64(offset)])]);
  const path=join(root,name);writeFileSync(path,Buffer.concat([header,Buffer.alloc((32-header.length%32)%32),Buffer.alloc(payload?224:0)]));return path;
}
function externalFixture(name:string,draft:boolean,token='same'){
 const architecture='qwen3next',fields:Array<[string,string|number|string[]]>=[['general.architecture',architecture],[`${architecture}.context_length`,65536],[`${architecture}.embedding_length`,4],['tokenizer.ggml.model','gpt2'],['tokenizer.ggml.tokens',['a','b']],['tokenizer.ggml.merges',['a b']],['tokenizer.ggml.bos_token_id',1],['tokenizer.ggml.add_bos_token',1],...(draft?[[`${architecture}.nextn_predict_layers`,1]] as Array<[string,number]>:[])];
 if(token!=='same')fields[fields.findIndex(([key])=>key==='tokenizer.ggml.model')][1]=token;
 const tensors:Array<[string,number[],number]>=draft?[['blk.48.nextn.eh_proj.weight',[8,4],0],['blk.48.nextn.enorm.weight',[4],128],['blk.48.nextn.hnorm.weight',[4],160]]:[];
 const header=Buffer.concat([Buffer.from('GGUF'),u32(3),u64(tensors.length),u64(fields.length),...fields.flatMap(([key,value])=>[text(key),typeof value==='string'?Buffer.concat([u32(8),text(value)]):typeof value==='number'?Buffer.concat([u32(4),u32(value)]):Buffer.concat([u32(9),u32(8),u64(value.length),...value.map(text)])]),...tensors.flatMap(([key,shape,offset])=>[text(key),u32(shape.length),...shape.map(u64),u32(0),u64(offset)])]);
 const path=join(root,name);writeFileSync(path,Buffer.concat([header,Buffer.alloc((32-header.length%32)%32),Buffer.alloc(draft?176:0)]));return path;
}
async function run(){try{
  const valid=fixture('valid.gguf'), metadataOnly=fixture('metadata.gguf','qwen35',1,false), truncated=fixture('truncated.gguf','qwen35',1,true,false);
  assert(embeddedMtpCapability(valid).supported);
  assert.equal(embeddedMtpCapability(metadataOnly).status,'requires-weights');
  assert(!embeddedMtpCapability(truncated).supported,'tensor headers without payload cannot prove weights');
  assert(!embeddedMtpCapability(fixture('unsupported.gguf','llama')).supported);
  assert(!embeddedMtpCapability(fixture('many-heads.gguf','qwen35',2)).supported);
  const server=join(root,'server');writeFileSync(server,"#!/bin/sh\nprintf '%s\\n' '--spec-type none,draft-mtp'\n",{mode:0o700});
  const plain=join(root,'plain');writeFileSync(plain,"#!/bin/sh\nprintf '%s\\n' '--model --ctx-size --port'\n",{mode:0o700});
  assert(advertisesMtp('--spec-type TYPE\n    allowed: none, draft-mtp\n--model FILE'));
  assert(!advertisesMtp('--spec-type none\n--other draft-mtp'));
  const flaky=join(root,'flaky'), sentinel=join(root,'attempt');
  writeFileSync(flaky,`#!/bin/sh\nif [ ! -f '${sentinel}' ]; then touch '${sentinel}'; echo 'transient CUDA initialization error' >&2; exit 1; fi\nprintf '%s\\n' '--spec-type none,draft-mtp'\n`,{mode:0o700});
  assert.equal((await probeBackendMtp(flaky)).status,'error');
  assert.equal((await probeBackendMtp(flaky)).status,'supported','failed help must be retried without changing binary');
  assert.equal((await probeBackendMtp(join(root,'missing'))).status,'error','missing executable is not lack of MTP support');
  assert((await mtpCapability(valid,server)).supported);
  assert.equal(await resolveMtpMode('auto',valid,server),'mtp');
  assert.equal(await resolveMtpMode('off',valid,server),'none');
  assert.equal(await resolveMtpMode('auto',valid,plain),'none');
  await assert.rejects(resolveMtpMode('on',valid,plain),/On unavailable/);
  await assert.rejects(resolveMtpMode('on',metadataOnly,server),/tensors/);
  const target=externalFixture('external-target.gguf',false),draft=externalFixture('external-draft.gguf',true),wrong=externalFixture('external-wrong.gguf',true,'different');
  assert(externalMtpCompatibility(target,draft).supported,'external MTP-only GGUF must pass the architecture/tokenizer checks');
  assert(!externalMtpCompatibility(target,wrong).supported,'an arbitrary MTP GGUF with a different tokenizer is rejected');
  const prepared=await prepareExternalMtpDraft(target,draft,2);assert.equal(prepared.maxDraftTokens,2);assert.equal(prepared.sizeBytes,statSync(draft).size);
  const externalServer=join(root,'external-server');writeFileSync(externalServer,"#!/bin/sh\nprintf '%s\\n' '--spec-type none,draft-mtp --spec-draft-n-max --spec-draft-model --gpu-layers-draft'\n",{mode:0o700});
  assert((await mtpCapability(target,externalServer,draft)).supported);
  assert.equal(await resolveMtpMode('auto',target,externalServer,draft),'mtp');assert.equal(await resolveMtpMode('on',target,externalServer,draft),'mtp');
  assert.equal(await resolveMtpMode('off',target,plain,draft),'none','MTP Off does not require or apply the external draft');
  assert.equal(await resolveMtpMode('auto',target,plain,draft),'none','Auto falls back when backend draft flags are absent');
  await assert.rejects(resolveMtpMode('on',target,plain,draft),/On unavailable/);
  const metrics=parseMtpMetrics('llamacpp:spec_decode_num_draft_tokens_total 20\nllamacpp:spec_decode_num_accepted_tokens_total 15\n');
  assert.equal(metrics?.acceptanceRate,.75);assert.equal(metrics?.scope,'server lifetime');
  assert.equal(parseMtpMetrics(''),undefined);
  assert.equal(parseMtpMetrics('llamacpp:spec_decode_num_draft_tokens_total 1\nllamacpp:spec_decode_num_accepted_tokens_total 2'),undefined);
  console.log('MTP capability: real tensor extents, architecture, backend flag, modes and truthful separate counters passed.');
}finally{rmSync(root,{recursive:true,force:true});}}
void run();
