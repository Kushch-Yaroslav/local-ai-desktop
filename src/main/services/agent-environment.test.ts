import assert from 'node:assert/strict';
import { agentRuntimeEnvironment, payloadEnvironmentKeys, systemExecutablePath } from './agent-environment';
const poisoned: NodeJS.ProcessEnv = {
  PATH:'/project/venv/bin:/usr/bin', HOME:'/home/fixture', HTTPS_PROXY:'http://proxy.invalid', CARGO_HOME:'/project/cargo',
  LD_AUDIT:'/project/audit.so', LD_PRELOAD:'/project/preload.so', LD_LIBRARY_PATH:'/project', LD_DEBUG:'all',
  LD_ORIGIN_PATH:'/project', LD_PROFILE:'libc.so.6', GLIBC_TUNABLES:'hostile', GCONV_PATH:'/project',
  LOCPATH:'/project', NLSPATH:'/project', BASH_ENV:'/project/startup', ENV:'/project/startup',
  NODE_OPTIONS:'--require /project/startup.js', PYTHONPATH:'/project', JAVA_TOOL_OPTIONS:'hostile',
  TMPDIR:'/project', LOCAL_AI_PROTECTED_PATHS:'model-supplied', UNKNOWN_FUTURE_LOADER_HOOK:'hostile',
};
const runtime=agentRuntimeEnvironment(poisoned);
assert.deepEqual(Object.keys(runtime).sort(),['PATH','LANG','LC_ALL','HOME','USER','LOGNAME','LOCAL_AI_AGENT_PAYLOAD_ENV'].sort());
assert.equal(runtime.PATH,systemExecutablePath);assert.equal(runtime.LC_ALL,'C');
const payload=JSON.parse(runtime.LOCAL_AI_AGENT_PAYLOAD_ENV!) as Record<string,string>;
assert(Object.keys(payload).every(key=>payloadEnvironmentKeys.includes(key as typeof payloadEnvironmentKeys[number])));
assert.equal(payload.PATH,poisoned.PATH);assert.equal(payload.HTTPS_PROXY,poisoned.HTTPS_PROXY);
assert.equal(payload.CARGO_HOME,poisoned.CARGO_HOME);
for(const key of Object.keys(poisoned))if(!payloadEnvironmentKeys.includes(key as typeof payloadEnvironmentKeys[number])){
  assert.equal(runtime[key],undefined);assert.equal(payload[key],undefined);
}
assert.equal(JSON.parse(agentRuntimeEnvironment(poisoned,true).LOCAL_AI_AGENT_PAYLOAD_ENV!).PATH,systemExecutablePath);
assert.throws(()=>agentRuntimeEnvironment({HOME:'bad\0value'}));
assert.throws(()=>agentRuntimeEnvironment({HOME:'x'.repeat(16_385)}));
assert.throws(()=>agentRuntimeEnvironment({HOME:'я'.repeat(8_193)}));
console.log('Agent environment: closed host allowlist, opaque payload transport, loader/module/shell hook rejection, development settings and restricted PATH passed.');
