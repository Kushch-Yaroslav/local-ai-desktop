// Inspect an extracted local RC without installing it or running maintainer hooks.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, lstat, rm, writeFile } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
const version='0.3.0';
const artifact=resolve(process.argv[2] ?? `release/local-ai-desktop_${version}_amd64.deb`);
const root=await mkdtemp(join(tmpdir(),'lad-rc-inspect-'));
const run=(program,args,options={})=>execFileSync(program,args,{encoding:'utf8',maxBuffer:32*1024*1024,timeout:30000,...options});
try {
  assert.equal(artifact.split('/').at(-1),`local-ai-desktop_${version}_amd64.deb`);
  assert.equal(run('dpkg-deb',['-f',artifact,'Package']).trim(),'local-ai-desktop');
  assert.equal(run('dpkg-deb',['-f',artifact,'Version']).trim(),version);
  assert.equal(run('dpkg-deb',['-f',artifact,'Architecture']).trim(),'amd64');
  const dependencies=run('dpkg-deb',['-f',artifact,'Depends']);
  for(const pattern of [/apparmor \(>= 4\.0\.0\)/,/bubblewrap \(>= 0\.9\.0\)/,/adduser/,/libcap2-bin/])assert.match(dependencies,pattern);
  const contents=run('dpkg-deb',['-c',artifact]);
  assert(!/runtime-settings\.json|local-ai-desktop\.db|\.gguf$|resources\/app\/runtime\//m.test(contents),'no user configuration, database, weights or runtime data');
  await mkdir(join(root,'control'));run('dpkg-deb',['-e',artifact,join(root,'control')]);run('dpkg-deb',['-x',artifact,root]);
  const app=join(root,'opt/local-ai-desktop/resources/app');
  const json=JSON.parse(await readFile(join(app,'package.json'),'utf8'));assert.equal(json.version,version);assert.equal(json.main,'dist/main/bootstrap.js');
  const dependencyTree=JSON.parse(run('npm',['ls','--all','--omit=dev','--json'],{cwd:app,env:{...process.env,NODE_PATH:''}}));
  assert.deepEqual(dependencyTree.problems ?? [],[],'packaged production dependency tree has no missing runtime packages');
  const info=JSON.parse(await readFile(join(app,'BUILD_INFO.json'),'utf8'));assert.equal(info.version,version);
  const manifest=JSON.parse(await readFile(resolve(dirname(artifact),'../../source-manifest.json'),'utf8'));
  const files=manifest.files;const identity={...manifest};delete identity.files;delete identity.excluded;delete identity.deleted;
  assert.deepEqual(info,identity,'packaged BUILD_INFO must match the complete frozen build identity');
  assert.equal(createHash('sha256').update(JSON.stringify(files)).digest('hex'),info.sourceManifestSha256,'source identity derives from the full manifest');
  for(const file of files) {
    const bytes=await readFile(resolve(dirname(artifact),'../',file.path));
    assert.equal(createHash('sha256').update(bytes).digest('hex'),file.sha256,'frozen source changed: '+file.path);
  }
  for(const name of ['src/renderer/components/Toolbar.tsx','src/renderer/components/AgentTimeline.tsx','packaging/sandbox-lifecycle.sh','rust-agent/src/process/runner.rs'])assert(files.some(file=>file.path===name),'RC fixes must be part of the frozen identity: '+name);
  for(const name of ['src/renderer/components/ContextUsage.tsx','src/main/services/chat-readonly-tools.ts','src/main/services/attachment-service.ts','docs/releases/v0.3.0.md','docs/releases/v0.3.0.ru.md'])assert(files.some(file=>file.path===name),'v0.3.0 release content must be in the frozen identity: '+name);
  assert(manifest.files.some(file=>file.path==='src/main/services/context-discovery-conditions.ts'),'GPU-fit fix is in the source identity');
  const binary=join(root,'opt/local-ai-desktop/resources/agent/local-ai-agent-runtime');
  assert.equal(run(binary,['--version']).trim(),`local-ai-agent-runtime ${version}`);
  assert.match(run('file',[binary]),/static(?:ally|-pie) linked/);
  for(const suffix of ['opt/local-ai-desktop/chrome-sandbox','opt/local-ai-desktop/local-ai-desktop','opt/local-ai-desktop/resources/agent/local-ai-agent-runtime']) {
    const line=contents.split('\n').find(line=>line.endsWith('./'+suffix));
    assert.match(line??'',/^-rwxr-xr-x 0\/0 /,suffix+' must be root-owned 0755, not setuid');
  }
  const conffiles=await readFile(join(root,'control/conffiles'),'utf8');
  for(const name of ['local-ai-desktop-bwrap','local-ai-desktop']) {
    assert(conffiles.split('\n').includes('/etc/apparmor.d/'+name),'dpkg-managed conffile '+name);
    const bytes=await readFile(join(root,'etc/apparmor.d',name));
    assert.deepEqual(bytes,await readFile(join(app,'assets/apparmor',name)));
    assert.equal((await lstat(join(root,'etc/apparmor.d',name))).mode&0o777,0o644);
  }
  for(const hook of ['postinst','prerm','postrm']) {
    const script=join(root,'control',hook);run('bash',['-n',script]);const text=await readFile(script,'utf8');
    assert(!text.includes('chmod 4755') && !text.includes('--remove "$policy"'),'no new SUID or unloading of live payload profiles');
  }
  const smokeApp=join(root,'electron-main-smoke');await mkdir(smokeApp);
  await writeFile(join(smokeApp,'package.json'),JSON.stringify({name:'local-ai-package-main-smoke',version:'1.0.0',main:'main.cjs'}));
  await writeFile(join(smokeApp,'main.cjs'),`
const { app } = require('electron');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const appRoot = ${JSON.stringify(app)};
const appRequire = createRequire(path.join(appRoot, 'package.json'));
const loaded = [];
const failures = [];
async function attempt(name, load) {
  try { await load(); loaded.push(name); }
  catch (error) { failures.push(name + ': ' + (error.stack || String(error))); }
}
app.whenReady().then(async () => {
  if (process.type !== 'browser') throw new Error('Smoke harness did not run in the Electron main process.');
  await attempt('mammoth', () => appRequire('mammoth'));
  await attempt('@keep-lts/xlsx', () => appRequire('@keep-lts/xlsx'));
  await attempt('pdfjs-dist', () => import(pathToFileURL(appRequire.resolve('pdfjs-dist/legacy/build/pdf.mjs')).href));
  await attempt('playwright-core', () => appRequire('playwright-core'));
  await attempt('attachment-service', () => appRequire('./dist/main/services/attachment-service.js'));
  await attempt('rust-agent-runtime', () => appRequire('./dist/main/services/rust-agent-runtime.js'));
  const result = { electron: process.versions.electron, processType: process.type, loaded, failures };
  process.stdout.write(JSON.stringify(result) + '\\n', () => app.exit(failures.length ? 1 : 0));
}).catch(error => process.stderr.write((error.stack || String(error)) + '\\n', () => app.exit(1)));
`);
  const smokeEnv={...process.env,NODE_PATH:'',LOCAL_AI_RUNTIME_ROOT:join(root,'test-runtime'),XDG_CONFIG_HOME:join(root,'xdg/config'),XDG_DATA_HOME:join(root,'xdg/data'),XDG_CACHE_HOME:join(root,'xdg/cache'),XDG_STATE_HOME:join(root,'xdg/state')};
  const runtimeSmoke=run(join(root,'opt/local-ai-desktop/local-ai-desktop'),['--no-sandbox','--headless','--disable-gpu',smokeApp],{env:smokeEnv,timeout:45000});
  const runtimeResult=JSON.parse(runtimeSmoke.trim().split('\n').at(-1));
  assert.equal(runtimeResult.processType,'browser','runtime modules load in Electron main, not a Node-only probe');
  assert.deepEqual(runtimeResult.failures,[],'all packaged main-process dependency graphs load');
  for(const name of ['mammoth','@keep-lts/xlsx','pdfjs-dist','playwright-core','attachment-service','rust-agent-runtime'])assert(runtimeResult.loaded.includes(name),'packaged runtime load: '+name);
  assert.match(await readFile(join(root,'control/triggers'),'utf8'),/interest(?:-noawait)? \/usr\/bin\/bwrap/);
  for(const name of ['LICENSE','THIRD_PARTY_NOTICES.md','licenses/Jan-LICENSE.txt','CHANGELOG.md','docs/README.md','docs/releases/v0.3.0.md','docs/releases/v0.3.0.ru.md','docs/releases/v0.2.1.md','docs/releases/v0.2.1.ru.md','docs/releases/v0.2.0.md','docs/releases/v0.2.0.ru.md','docs/archive/releases/v0.2.0-checklist.md','docs/bwrap-installation-acceptance.md','docs/archive/noop-loader-validation-2026-10-13.md'])await readFile(join(app,name));
  const screenshots=await readdir(join(app,'docs/img/releases/v0.2.0'));assert.deepEqual(screenshots.filter(name=>name.endsWith('.png')).sort(),['ask.png','big-thinking2.png','context-info.png','context.png','continue.png','select-autonomy.png']);
  let localLinks=0;
  const check=async file=>{
    const body=(await readFile(file,'utf8')).replace(/```[\s\S]*?```/g,'');
    for(const match of body.matchAll(/!?\[[^\]]*\]\((<[^>]+>|[^)]+)\)/g)) {
      const target=match[1].replace(/^<|>$/g,'');if(/^[a-z][a-z0-9+.-]*:|^#/i.test(target))continue;
      await lstat(resolve(dirname(file),decodeURIComponent(target.split('#')[0])));localLinks++;
    }
  };
  const walk=async directory=>{for(const entry of await readdir(directory,{withFileTypes:true})){const path=join(directory,entry.name);if(entry.isDirectory())await walk(path);else if(entry.name.endsWith('.md'))await check(path);}};
  await walk(join(app,'docs'));for(const name of ['README.md','README.ru.md','CHANGELOG.md'])await check(join(app,name));
  const desktop=await readFile(join(root,'usr/share/applications/local-ai-desktop.desktop'),'utf8');assert.match(desktop,/Exec=\/opt\/local-ai-desktop\/local-ai-desktop %U/);
  console.log(JSON.stringify({result:'PASS',version:json.version,architecture:'amd64',bundledRust:`${version} static`,electronMainRuntime:runtimeResult,conffiles:2,screenshots:screenshots.filter(name=>name.endsWith('.png')).length,localDocumentationLinks:localLinks,sha256:createHash('sha256').update(await readFile(artifact)).digest('hex')},null,2));
} finally {await rm(root,{recursive:true,force:true});}
