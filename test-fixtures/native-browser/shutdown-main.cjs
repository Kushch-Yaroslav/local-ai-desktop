const {app,BrowserWindow}=require('electron');
const {resolve,join}=require('node:path');
if(!process.env.LOCAL_AI_RUNTIME_ROOT?.startsWith('/tmp/'))throw Error('Temporary runtime required');
app.setPath('userData',join(process.env.LOCAL_AI_RUNTIME_ROOT,'electron'));
app.on('window-all-closed',()=>{});
const errors=[];
const record=error=>{errors.push(String(error?.stack??error));require('node:fs').writeFileSync(join(process.env.LOCAL_AI_RUNTIME_ROOT,'shutdown-errors.json'),JSON.stringify(errors));};
require('node:fs').writeFileSync(join(process.env.LOCAL_AI_RUNTIME_ROOT,'shutdown-errors.json'),'[]');
// Test-only recording: production keeps Electron's normal exception handling.
process.on('uncaughtException',record);
process.on('unhandledRejection',record);
app.whenReady().then(()=>{
 const {createNativeProjectPage}=require(resolve(process.env.LOCAL_AI_TEST_NATIVE_MODULE||'dist/main/web/native-project-page.js'));
 global.shutdownFixture={errors,async open(){
  const window=new BrowserWindow({width:900,height:700,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});
  await window.loadURL('data:text/html,<title>Shutdown fixture</title>');
  const native=await createNativeProjectPage(window.webContents,'http://127.0.0.1:19876');
  native.handleRequests(async()=>({status:200,headers:{'content-type':'text/html'},body:Buffer.from('<button>Shutdown fixture</button>')}));
  await native.page.goto('http://127.0.0.1:19876/');
  native.layout({x:10,y:10,width:800,height:600});
  await native.workspace({viewport:{width:1920,height:1080},scale:1,pan:{x:300,y:100}});native.ownership('user');
  this.window=window;this.native=native;this.children=window.contentView.children.slice();
  return native.contents.id;
 },async close(mode){
  const {native,window,children}=this;
  if(mode==='shield-first')await new Promise(resolve=>{const contents=children.at(-1).webContents;contents.once('destroyed',resolve);contents.close({waitForBeforeUnload:false});});
  if(mode==='active-pan-window'){native.contents.emit('before-mouse-event',{preventDefault(){}},{type:'mouseDown',button:'middle',x:100,y:100});window.destroy();}
  if(mode==='window-destroy')window.destroy();
  if(mode==='debugger-detach'&&native.contents.debugger.isAttached())native.contents.debugger.detach();
  const a=native.close(),b=native.close();
  const same=a===b;await Promise.all([a,b]);
  if(!window.isDestroyed())window.destroy();
  return {same,closed:native.contents.isDestroyed()};
 }};
}).catch(error=>{console.error(error);app.exit(1)});
