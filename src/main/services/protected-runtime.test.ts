import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { ProtectedRuntimeRegistry, processIdentity } from './protected-runtime';

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function regression() {
  const directory = mkdtempSync(join(tmpdir(), 'lad-protected-registry-'));
  const registry = new ProtectedRuntimeRegistry(directory);
  const script = join(directory, 'run-local-ai-desktop-llama-cpp-mtp.sh');
  const listener = join(directory, 'listener.cjs');
  const stateFile = join(directory, 'llama-cpp-runtime-state.json');
  // Fixture launcher and listener, not the installed application's processes.
  writeFileSync(script, '#!/bin/bash\nnode "$1" --ctx-size 65536 --port 0 &\nwait\n');
  writeFileSync(listener, `const fs=require('node:fs'); const http=require('node:http');
    const identity=pid=>{ const s=fs.readFileSync('/proc/'+pid+'/stat','utf8'); return s.slice(s.lastIndexOf(') ')+2).trim().split(/\\s+/)[19]; };
    const server=http.createServer((q,r)=>r.end('fixture')).listen(0,'127.0.0.1',()=>fs.writeFileSync(${JSON.stringify(stateFile)},JSON.stringify({status:'ready',launcherPid:process.ppid,serverPid:process.pid,launcherStartTime:identity(process.ppid),serverStartTime:identity(process.pid),port:server.address().port})));`);
  let launcher: ReturnType<typeof spawn> | undefined;
  let serverPid: number | undefined;
  const start = async () => {
    launcher = spawn('/bin/bash', [script, listener], { stdio: 'ignore' });
    for (let attempt = 0; attempt < 100; attempt++) {
      try { const s=JSON.parse(readFileSync(stateFile,'utf8')); if (s.launcherPid===launcher.pid) { serverPid=s.serverPid; return s; } } catch { /* Wait for fixture. */ }
      await delay(20);
    }
    throw new Error('fixture listener did not start');
  };
  const stop = async () => {
    // Only PIDs created by this fixture; host control path remains available.
    if (serverPid) { try { process.kill(serverPid, 'SIGTERM'); } catch { /* Exited. */ } serverPid=undefined; }
    if (launcher && launcher.exitCode === null) { launcher.kill(); await new Promise(resolve => launcher!.once('exit', resolve)); }
  };
  try {
    const first=await start(); registry.register(process.pid,'electron-main');
    const records=registry.refresh();
    const server=records.find(p=>p.role==='llama-server')!;
    assert.equal(server.pid,first.serverPid); assert.equal(server.startTime,first.serverStartTime);
    assert(server.executable && server.ppid===first.launcherPid && server.pgid>0 && server.sessionId>0);
    assert(server.endpoints.includes(`tcp://127.0.0.1:${first.port}`),'actual ephemeral listener endpoint must be tracked');
    writeFileSync(stateFile,JSON.stringify({...first,serverStartTime:'wrong-start-time'}));
    assert(!registry.refresh().some(p=>p.role==='llama-server'),'PID reuse must not protect a different identity');
    writeFileSync(stateFile,JSON.stringify({...first,launcherStartTime:'wrong-launcher-time'}));
    assert(!registry.refresh().some(p=>p.role==='runtime-launcher'),'stale launcher must not authorize server identity');
    await stop(); const second=await start();
    const updated=registry.refresh().find(p=>p.role==='llama-server')!;
    assert.equal(updated.pid,second.serverPid); assert.equal(updated.startTime,second.serverStartTime);
    assert(updated.endpoints.includes(`tcp://127.0.0.1:${second.port}`));
    assert(!registry.refresh().some(p=>p.pid===first.serverPid),'retired server must disappear');
    registry.endpoint(`http://127.0.0.1:${second.port}/v1/chat/completions`); registry.refresh();
    assert(JSON.parse(readFileSync(registry.file,'utf8')).configuredEndpoints.length>0);
    writeFileSync(stateFile, '{}');
    assert(registry.refresh().some(p=>p.pid===second.serverPid && p.role==='model-serving-endpoint'),'configured local endpoint must be associated with its actual listener process');
    registry.endpoint('https://example.invalid/v1/chat/completions'); registry.refresh();
    assert(!registry.refresh().some(p=>p.role==='model-serving-endpoint'),'old endpoint identity must retire');
    const live=processIdentity(process.pid,'rust-agent')!; assert(live.startTime && live.executable);
    registry.register(process.pid,'rust-agent'); assert(registry.refresh().some(p=>p.role==='rust-agent'));
    registry.retire(process.pid); assert(!registry.refresh().some(p=>p.pid===process.pid));
    await stop(); assert(!registry.refresh().some(p=>p.role==='llama-server'));
    const events=readFileSync(join(directory,'protected-runtime-events.jsonl'),'utf8');
    assert(events.includes('"event":"registered"') && events.includes('"event":"retired"'));
    console.log('Protected runtime registry: PID/start identity, roles, relationships, actual variable endpoints, stale identity, restart/retirement and host controls passed.');
  } finally { registry.stop(); await stop(); rmSync(directory,{recursive:true,force:true}); }
}
if (require.main===module) void regression().catch(error=>{ console.error(error); process.exitCode=1; });
