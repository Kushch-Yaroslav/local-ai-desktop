const{contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('localAi',{liveBrowser:{
 watch:(id,visible)=>ipcRenderer.invoke('live-browser:watch',id,visible),
 layout:(id,bounds)=>ipcRenderer.invoke('live-browser:layout',id,bounds),
 input:(id,input)=>ipcRenderer.invoke('live-browser:input',id,input),
 close:id=>ipcRenderer.invoke('live-browser:close',id),
 acknowledge:(id,seq)=>ipcRenderer.send('live-browser:ack',id,seq),
 onEvent:listener=>{const handler=(_e,value)=>listener(value);ipcRenderer.on('live-browser:event',handler);return()=>ipcRenderer.removeListener('live-browser:event',handler)}
}});
