import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { embeddedMtpCapability, mtpCapability, resolveMtpMode, probeBackendMtp, advertisesMtp } from './mtp-capability';
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
  const metrics=parseMtpMetrics('llamacpp:spec_decode_num_draft_tokens_total 20\nllamacpp:spec_decode_num_accepted_tokens_total 15\n');
  assert.equal(metrics?.acceptanceRate,.75);assert.equal(metrics?.scope,'server lifetime');
  assert.equal(parseMtpMetrics(''),undefined);
  assert.equal(parseMtpMetrics('llamacpp:spec_decode_num_draft_tokens_total 1\nllamacpp:spec_decode_num_accepted_tokens_total 2'),undefined);
  console.log('MTP capability: real tensor extents, architecture, backend flag, modes and truthful separate counters passed.');
}finally{rmSync(root,{recursive:true,force:true});}}
void run();
