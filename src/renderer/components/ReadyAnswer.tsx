import {useEffect,useState} from 'react';
import {Markdown} from './Markdown';
export function ReadyAnswer({text,readyAt,streaming,traceId}:{text:string;readyAt?:number;streaming:boolean;traceId?:string}) {
 const [clock,setClock]=useState(Date.now());
 useEffect(()=>{if(traceId&&typeof localStorage!=='undefined'&&localStorage.getItem('local-ai-stream-timing')==='1')performance.mark(`stream.react.${traceId}`,{detail:{chars:text.length}});},[traceId,text]);
 const duration=Math.min(2200,Math.max(400,text.length/8));
 const reduced=typeof matchMedia==='function'&&matchMedia('(prefers-reduced-motion: reduce)').matches;
 const fraction=readyAt&&!reduced?Math.min(1,Math.max(0,(clock-readyAt)/duration)):1;
 useEffect(()=>{if(!readyAt||reduced||Date.now()-readyAt>=duration)return;const timer=setInterval(()=>setClock(Date.now()),50);const end=setTimeout(()=>{clearInterval(timer);setClock(Date.now());},Math.max(0,readyAt+duration-Date.now()));return()=>{clearInterval(timer);clearTimeout(end);};},[readyAt,duration,reduced]);
 return <Markdown streaming={streaming||fraction<1}>{fraction===1?text:text.slice(0,Math.max(1,Math.floor(text.length*fraction)))}</Markdown>;
}
