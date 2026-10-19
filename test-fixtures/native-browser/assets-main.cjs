// Production native transport without Playwright Electron's second global CDP client.
const {app,BrowserWindow}=require('electron');
const {join,resolve}=require('node:path');
const {writeFile,mkdir,readFile}=require('node:fs/promises');
const assert=require('node:assert/strict');
const root=process.env.LOCAL_AI_RUNTIME_ROOT,project=process.env.LOCAL_AI_TEST_PROJECT_ROOT;
app.setPath('userData',join(root,'electron'));
if(process.env.LOCAL_AI_TEST_SOFTWARE==='1')app.disableHardwareAcceleration();
app.whenReady().then(async()=>{
 let browser,window;const owned=new Map();const rememberProcesses=async()=>{for(const metric of app.getAppMetrics()){try{const stat=await readFile('/proc/'+metric.pid+'/stat','utf8'),startTime=stat.slice(stat.lastIndexOf(')')+2).split(' ')[19];owned.set(metric.pid,{pid:metric.pid,startTime})}catch(error){if(!['ENOENT','ESRCH'].includes(error.code))throw error}}};const result={tests:[],noGlobalDebugPort:!process.argv.some(arg=>/remote-debugging|inspect/.test(arg))};
 try{
  assert(result.noGlobalDebugPort);
  window=new BrowserWindow({width:1000,height:800,webPreferences:{sandbox:true,nodeIntegration:false,contextIsolation:true}});
  await window.loadURL('data:text/html,<h1>Native asset fixture</h1>');
  const{ProjectBrowserSession}=require(resolve('dist/main/web/project-browser.js'));
  const{liveBrowsers}=require(resolve('dist/main/web/live-browser.js'));
  liveBrowsers.watch(window.webContents,'assets',true);
  browser=new ProjectBrowserSession(project,join(root,'captures'),undefined,liveBrowsers.observer(window.webContents,'assets','asset-run'));
  const opened=await browser.execute({action:'open'},new AbortController().signal,async()=>({approved:true}));assert(!opened.error,JSON.stringify(opened));assert.match(opened.browser_check,/native Electron.*headed/);
  browser.native.layout({x:0,y:70,width:1000,height:700});const page=browser.page;result.projectPageCount=browser.context.pages().length;assert.equal(result.projectPageCount,1);await rememberProcesses();
  assert.equal(await page.locator('#js').textContent(),'JS v1');await page.waitForTimeout(500);assert(!page.isClosed());result.tests.push('external JavaScript/CSS loads on one native Page without a global debug port');
  const wait=async(predicate)=>{for(let i=0;i<100;i++){assert(!page.isClosed(),'native project Page crashed');try{if(await predicate())return}catch{/* reload swaps context */}await new Promise(r=>setTimeout(r,50))}throw Error('Auto-reload did not produce expected state')};
  await writeFile(join(project,'index.html'),'<link rel="stylesheet" href="assets/style.css"><h1>HTML v2</h1><p id="js"></p><canvas></canvas><script src="assets/app.js"></script>');
  await wait(async()=>await page.locator('h1').textContent()==='HTML v2');
  await writeFile(join(project,'assets/style.css'),'body{background:rgb(90,40,120)}');await wait(async()=>await page.evaluate(()=>globalThis.getComputedStyle(globalThis.document.body).backgroundColor)==='rgb(90, 40, 120)');
  await writeFile(join(project,'assets/app.js'),"document.querySelector('#js').textContent='JS v2';let n=0,c=document.querySelector('canvas').getContext('2d');function draw(){c.fillStyle='hsl('+(n++%360)+' 60% 50%)';c.fillRect(0,0,300,150);requestAnimationFrame(draw)}draw()");await wait(async()=>await page.locator('#js').textContent()==='JS v2');
  result.tests.push('file watcher automatically reloads external HTML/CSS/JS');
  const a=await page.screenshot();await page.waitForTimeout(100);assert(!(await page.screenshot()).equals(a));result.tests.push('actual Canvas remains animated after external JS reload');
  await rememberProcesses();await browser.close();assert.equal(window.contentView.children.length,0);result.result='PASS';
 }catch(error){result.error={message:String(error),stack:error.stack};result.result='FAIL'}finally{
  await browser?.close();await rememberProcesses();result.ownedProcesses=[...owned.values()];await mkdir(root,{recursive:true});await writeFile(join(root,'native-assets-result.json'),JSON.stringify(result,null,2));app.quit();
 }
}).catch(error=>{console.error(error);app.exit(1)});
