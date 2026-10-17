const { app, BrowserWindow, ipcMain } = require('electron');
const { resolve, join } = require('node:path');
const { mkdir, writeFile } = require('node:fs/promises');
app.disableHardwareAcceleration();
const sessions = new Map();
app.whenReady().then(async () => {
  const root = process.env.LOCAL_AI_RUNTIME_ROOT;
  const model = process.env.LOCAL_AI_TEST_MODEL ?? 'qwen3.6:35b-a3b-ud-q4_k_m';
  const hardware = require(resolve('dist/main/services/hardware.js'));const readHardware=hardware.getHardwareStats;
  const fixture = await require(resolve('dist/main/ipc/context-profiles.test.js')).contextProfileFixture(root, true, model);
  hardware.getHardwareStats=readHardware;ipcMain.removeHandler('hardware:get');ipcMain.handle('hardware:get',readHardware);
  const project = process.env.LOCAL_AI_TEST_PROJECT_ROOT ?? join(root,'project'); await mkdir(project,{recursive:true});
  await writeFile(join(project,'index.html'),`<!doctype html><meta charset="utf-8"><title>ORBIT Studio</title><style>*{box-sizing:border-box}body{margin:0;background:#101929;color:#eef4ff;font:16px system-ui}header{padding:32px 50px;display:flex;justify-content:space-between;border-bottom:1px solid #ffffff20}a{color:#b0cdff;padding:12px}main{padding:50px}h1{font-size:60px;margin:20px 0}p{color:#a3b6d4}canvas{border-radius:20px;width:100%;height:320px}input{padding:12px;border-radius:8px}footer{margin-top:1000px}</style><header><b>◉ ORBIT</b><nav><a id="home" href="#home">Home</a><a id="explore" href="#explore">Explore</a></nav></header><main><p>CREATIVE TECHNOLOGY STUDIO</p><h1>Ideas in motion.</h1><p>A small world, always moving. Built locally with your AI agent.</p><canvas width="1100" height="320"></canvas><input id="message" placeholder="Your next idea"><footer>More to explore</footer></main><script>const c=document.querySelector('canvas').getContext('2d');let t=0;function frame(){t+=.025;c.fillStyle='#1d2b46';c.fillRect(0,0,1100,320);for(let i=0;i<35;i++){let x=(i*93+t*30)%1100,y=160+Math.sin(t+i)*100;c.beginPath();c.arc(x,y,4+i%8,0,Math.PI*2);c.fillStyle='hsl('+(i*13+t*10)+' 70% 70%)';c.fill()}requestAnimationFrame(frame)}frame();window.pageIdentity=Math.random();</script>`);
  fixture.db.updateConversation(fixture.chat.id,{title:'Live Browser workspace',mode:'agent',workingDirectory:project,webMode:'auto',contextWindow:65536});
  fixture.db.addMessage(fixture.chat.id,'assistant','I will check the navigation, then review the page in the browser.',undefined,[],{thinking:'Review the page while preserving the existing project boundaries.\n'.repeat(24)});
  const second=fixture.db.createConversation(model);fixture.db.updateConversation(second.id,{title:'Separate chat'});fixture.db.addMessage(second.id,'user','A separate conversation with no browser.');
  const window = new BrowserWindow({width:1480,height:960,webPreferences:{preload:resolve('dist/preload/index.js'),contextIsolation:true,nodeIntegration:false,sandbox:true}});
  const {ProjectBrowserSession}=require(resolve('dist/main/web/project-browser.js'));
  const {liveBrowsers}=require(resolve('dist/main/web/live-browser.js'));
  const approve=async()=>({approved:true});
  global.liveFixture={ chat:fixture.chat.id,second:second.id,project,model,
    async open(id=fixture.chat.id){ const old=sessions.get(id);await old?.close();const session=new ProjectBrowserSession(project,join(root,'captures'),undefined,liveBrowsers.observer(window.webContents,id,'fixture-'+Date.now()));sessions.set(id,session);return session.execute({action:'open'},new AbortController().signal,approve); },
    async action(args,id=fixture.chat.id){return sessions.get(id).execute(args,new AbortController().signal,approve);},
    async edit(){await writeFile(join(project,'style.css'),'body{background:#345; color:white}');await writeFile(join(project,'edited.html'),'<title>Updated ORBIT</title><style>body{background:#473652;color:white;font:40px system-ui;padding:50px}</style><h1>Revision two</h1>');return sessions.get(fixture.chat.id).execute({action:'open',path:'edited.html'},new AbortController().signal,approve);},
    async finish(){await sessions.get(fixture.chat.id).finishRun();},
    async begin(){const session=sessions.get(fixture.chat.id);session.beginRun(liveBrowsers.observer(window.webContents,fixture.chat.id,'interactive-next-run'));return session.execute({action:'read'},new AbortController().signal,approve);},
    async interactiveSetup(){const page=sessions.get(fixture.chat.id).page;await page.evaluate(()=>{globalThis.previewKeys=[];const canvas=document.querySelector('canvas');canvas.tabIndex=0;canvas.addEventListener('keydown',event=>globalThis.previewKeys.push(event.key));});},
    async interactiveTargets(){return sessions.get(fixture.chat.id).page.evaluate(()=>Object.fromEntries(['canvas','#message','#explore'].map(selector=>{const rect=document.querySelector(selector).getBoundingClientRect();return [selector,{x:rect.x+rect.width/2,y:rect.y+rect.height/2}];})));},
    async interactiveSnapshot(){return sessions.get(fixture.chat.id).page.evaluate(()=>({keys:globalThis.previewKeys,input:document.querySelector('#message')?.value,url:location.href,scroll:scrollY,identity:globalThis.pageIdentity}));},
    async close(){await Promise.all([...sessions.values()].map(s=>s.close()));},
    async autoSetup(){
      await mkdir(join(project,'assets'),{recursive:true});
      await writeFile(join(project,'assets/style.css'),'body{margin:0;background:rgb(20,30,40);color:white;font:28px system-ui}h1{padding:30px}');
      await writeFile(join(project,'assets/app.js'),`document.querySelector('#js').textContent='JS v1';let n=0,c=document.querySelector('canvas').getContext('2d');function draw(){c.fillStyle='hsl('+(n++%360)+' 60% 50%)';c.fillRect(0,0,300,150);requestAnimationFrame(draw)}draw()`);
      await writeFile(join(project,'index.html'),'<title>Automatic updates</title><link rel="stylesheet" href="assets/style.css"><h1>HTML v1</h1><p id="js"></p><canvas></canvas><script src="assets/app.js"></script>');
      await this.open();let loads=0;const page=sessions.get(fixture.chat.id).page;page.on('load',()=>loads++);this.autoLoads=()=>loads;
    },
    async autoEdit(kind){
      if(kind==='html'||kind==='hidden')await writeFile(join(project,'index.html'),'<title>Automatic updates</title><link rel="stylesheet" href="assets/style.css"><h1>'+(kind==='hidden'?'HTML hidden':'HTML v2')+'</h1><p id="js"></p><canvas></canvas><script src="assets/app.js"></script>');
      else if(kind==='css')await writeFile(join(project,'assets/style.css'),'body{margin:0;background:rgb(90,40,120);color:white;font:28px system-ui}h1{padding:30px}');
      else if(kind==='js')await writeFile(join(project,'assets/app.js'),`document.querySelector('#js').textContent='JS v2';let n=0,c=document.querySelector('canvas').getContext('2d');function draw(){c.fillStyle='hsl('+(n++%360)+' 60% 50%)';c.fillRect(0,0,300,150);requestAnimationFrame(draw)}draw()`);
    },
    async autoSnapshot(){const page=sessions.get(fixture.chat.id).page;return {loads:this.autoLoads(),...(await page.evaluate(()=>({heading:globalThis.document.querySelector('h1').textContent,js:globalThis.document.querySelector('#js').textContent,color:globalThis.getComputedStyle(globalThis.document.body).backgroundColor})))};},
    async prepareQwen(){await this.close();return {conversationId:fixture.chat.id,model};}
  };
  await window.loadFile(resolve('dist/renderer/index.html'));
}).catch(error=>{console.error(error);app.exit(1);});
let shutting=false;app.on('before-quit',event=>{if(shutting)return;event.preventDefault();shutting=true;void Promise.all([require(resolve('dist/main/ipc/register-ipc.js')).shutdownRuntime(),...Array.from(sessions.values(),s=>s.close())]).finally(()=>app.quit());});
