/** Only Vite's authenticated, same-port root HMR endpoint. Never general sockets. */
export function allowedViteSocket(raw:string,origin:string,enabled:boolean):boolean {
  try{const u=new URL(raw),base=new URL(origin);return enabled&&base.protocol==='http:'&&['localhost','127.0.0.1'].includes(base.hostname)&&u.protocol==='ws:'&&u.host===base.host&&!u.username&&!u.password&&u.pathname==='/'&&u.searchParams.size===1&&/^[\w-]{8,128}$/.test(u.searchParams.get('token')??'');}catch{return false;}
}

/** Vite needs heartbeat and module invalidation only, not arbitrary client events. */
export function viteClientMessage(raw:string):string|undefined {
  if(raw.length>2048)return;
  try{const m=JSON.parse(raw);
    if(m.type==='ping'&&Object.keys(m).length===1)return '{"type":"ping"}';
    if(m.type==='custom'&&m.event==='vite:invalidate'&&typeof m.data?.path==='string'&&/^\/(?!\/)[\w/.-]{1,500}$/.test(m.data.path)&&!m.data.path.includes('..'))return JSON.stringify({type:'custom',event:'vite:invalidate',data:{path:m.data.path,message:'Native preview module invalidated'}});
  }catch{/* Reject unknown protocol messages. */}
}
