import makeWASocket, {useMultiFileAuthState, DisconnectReason, proto, Browsers} from 'baileys';
import pino from 'pino';
import QRCode from 'qrcode';
import {createServer} from 'node:http';
import fs from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {CHANNEL_CODE,candidate,textOf} from './reader.mjs';
import {parseBulletin,parseGold} from '../sarraf-preview/worker/src/parser.js';
import {goldBulletins,GOLD_CODE} from './gold.mjs';
const root=path.dirname(fileURLToPath(import.meta.url));
const priv=path.join(root,'private');await fs.mkdir(priv,{recursive:true});
let qrImage=null, socket=null, pollTimer=null, reconnectTimer=null, expectedJid=null, busy=false, latest=null, stopped=false;
let goldJid=null;
const goldProbe=[];
try{goldProbe.push(...JSON.parse(await fs.readFile(path.join(priv,'gold-probe.json'),'utf8')).slice(-40));}catch{}
const status={connection:'starting',channel:'not-resolved',lastCheck:null,lastText:null,accepted:0,rejected:0,lastResult:null};
status.gold={channel:'not-resolved',textCount:0};
async function ingestGold(jid,message,timestamp,id){
  if(jid!==goldJid)return;
  const text=textOf(message);if(!text)return;
  const at=Number(timestamp)*1000;if(!Number.isFinite(at)||at<=0)return;
  const record={text,post_time:new Date(at).toISOString(),id};
  const old=goldProbe.findIndex(p=>String(p.id)===String(id));if(old>=0)goldProbe.splice(old,1);goldProbe.push(record);
  goldProbe.sort((a,b)=>Date.parse(a.post_time)-Date.parse(b.post_time));if(goldProbe.length>40)goldProbe.splice(0,goldProbe.length-40);
  await fs.writeFile(path.join(priv,'gold-probe.json'),JSON.stringify(goldProbe,null,2));
  status.gold.textCount++;if(!status.gold.latestPublication||at>Date.parse(status.gold.latestPublication)){status.gold.latestPublication=record.post_time;status.gold.parserRecognized=!!parseGold(text);}
}
try{latest=JSON.parse(await fs.readFile(path.join(priv,'candidate.json'),'utf8'));}catch{}
async function ingest(jid,message,timestamp,id){
  if(jid!==expectedJid)return;
  const text=textOf(message);if(!text)return;
  const at=Number(timestamp)*1000;
  if(Number.isFinite(at)&&(!status.latestPublication||at>Date.parse(status.latestPublication))){status.latestPublication=new Date(at).toISOString();status.latestTextHasRates=!!parseBulletin(text);await fs.writeFile(path.join(priv,'latest-bulletin.txt'),text);}
  status.lastText=new Date().toISOString();
  const r=candidate({jid,expectedJid,text,timestamp,id},latest);
  if(r.error){status.rejected++;status.lastResult=r.error;return;}
  latest=r.rates;status.accepted++;status.lastResult='candidate-saved-not-published';
  const file=path.join(priv,'candidate.json');await fs.writeFile(file+'.tmp',JSON.stringify(latest,null,2));await fs.rename(file+'.tmp',file);
}
async function walk(node,handler=ingest,jid=expectedJid){
  if(!node||typeof node!=='object')return;
  if(node.tag==='message'&&Array.isArray(node.content)){
    for(const child of node.content)if(child.tag==='plaintext'&&child.content instanceof Uint8Array){
      try{await handler(jid,proto.Message.decode(child.content),node.attrs?.t||node.attrs?.timestamp,node.attrs?.server_id||node.attrs?.id);}catch{status.lastResult='decode-failed';}
    }
  }
  if(Array.isArray(node.content))for(const child of node.content)await walk(child,handler,jid);
}
async function pollGold(){
  try{
    if(!goldJid){const meta=await socket.newsletterMetadata('invite',GOLD_CODE);if(!meta?.id?.endsWith('@newsletter'))throw new Error();goldJid=meta.id;status.gold.channel='resolved';}
    const response=await socket.query({tag:'iq',attrs:{id:socket.generateMessageTag(),type:'get',to:'s.whatsapp.net',xmlns:'newsletter'},content:[{tag:'messages',attrs:{type:'jid',jid:goldJid,count:'10'}}]});
    status.gold.lastCheck=new Date().toISOString();await walk(response,ingestGold,goldJid);
    const gold=goldBulletins(goldProbe);
    if(gold){await fs.writeFile(path.join(priv,'gold-candidate.json'),JSON.stringify(gold,null,2));status.gold.latestRate=gold;status.gold.parserRecognized=true;status.gold.lastResult='candidate-saved-not-published';}
  }catch{status.gold.lastResult='channel-request-failed';}
}
async function poll(){
  if(busy||status.connection!=='open')return;busy=true;status.lastCheck=new Date().toISOString();
  try{
    if(!expectedJid){const meta=await socket.newsletterMetadata('invite',CHANNEL_CODE);if(!meta?.id?.endsWith('@newsletter'))throw new Error('metadata-unavailable');expectedJid=meta.id;status.channel='resolved';}
    const response=await socket.query({tag:'iq',attrs:{id:socket.generateMessageTag(),type:'get',to:'s.whatsapp.net',xmlns:'newsletter'},content:[{tag:'messages',attrs:{type:'jid',jid:expectedJid,count:'10'}}]});
    const shape=[];
    const inspect=(n,depth=0)=>{if(!n||typeof n!=='object'||depth>5||shape.length>=24)return;shape.push({tag:n.tag,attributes:Object.keys(n.attrs||{}),bytes:n.content instanceof Uint8Array?n.content.length:undefined,children:Array.isArray(n.content)?n.content.length:undefined});if(Array.isArray(n.content))n.content.forEach(c=>inspect(c,depth+1));};
    inspect(response);status.responseShape=shape;
    await walk(response);if(!status.lastResult)status.lastResult='poll-complete-no-text-yet';
  }catch{status.lastResult='channel-request-failed';}finally{await pollGold();busy=false;}
}
async function connect(){
  if(stopped)return;
  const {state,saveCreds}=await useMultiFileAuthState(path.join(priv,'auth'));
  socket=makeWASocket({auth:state,logger:pino({level:'silent'}),browser:Browsers.ubuntu('Chrome'),syncFullHistory:false,markOnlineOnConnect:false,shouldSyncHistoryMessage:()=>false,shouldIgnoreJid:jid=>!jid.endsWith('@newsletter'),getMessage:async()=>undefined,connectTimeoutMs:30000,defaultQueryTimeoutMs:25000});
  socket.ev.on('creds.update',saveCreds);
  socket.ev.on('connection.update',async u=>{
    if(u.qr){qrImage=await QRCode.toBuffer(u.qr,{width:320,margin:2});status.connection='waiting-for-scan';}
    if(u.connection==='open'){qrImage=null;status.connection='open';await poll();clearInterval(pollTimer);pollTimer=setInterval(poll,120000);}
    if(u.connection==='close'){
      qrImage=null;clearInterval(pollTimer);expectedJid=null;goldJid=null;
      const code=u.lastDisconnect?.error?.output?.statusCode;
      status.connection=code===DisconnectReason.loggedOut?'logged-out':'reconnecting';
      if(code!==DisconnectReason.loggedOut&&!stopped){clearTimeout(reconnectTimer);reconnectTimer=setTimeout(()=>connect().catch(()=>{status.connection='connection-failed';}),15000);}
    }
  });
  socket.ev.on('messages.upsert',async({messages})=>{
    for(const m of messages||[])if(m.key?.remoteJid===expectedJid){try{await ingest(m.key.remoteJid,m.message,Number(m.messageTimestamp),m.key.id);}catch{status.lastResult='processing-failed';}}
    for(const m of messages||[])if(m.key?.remoteJid===goldJid){try{await ingestGold(m.key.remoteJid,m.message,Number(m.messageTimestamp),m.key.id);}catch{status.gold.lastResult='processing-failed';}}
  });
}
const html=`<!doctype html><html lang="ar" dir="rtl"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>ربط قارئ صرّاف</title><style>body{font:18px system-ui;background:#eff5f1;color:#173b25;max-width:640px;margin:30px auto;padding:20px}main{background:white;padding:24px;border-radius:20px}img{display:block;max-width:100%;margin:auto}p{line-height:1.8}pre{direction:ltr;white-space:pre-wrap;background:#f0f4f1;padding:16px;font-size:13px}</style><main><h1>ربط قارئ صرّاف التجريبي</h1><p>استخدم الرقم المنفصل: واتساب ← الإعدادات أو القائمة ← الأجهزة المرتبطة ← ربط جهاز. امسح الرمز من شاشة الكمبيوتر. لا ترسل أي رمز تحقق.</p><img id="qr" alt="رمز ربط واتساب يظهر عند جاهزية الاتصال"><p id="msg"></p><p>اتبع قناة الأسعار من الرقم المنفصل أيضاً. هذا اختبار قراءة محلي غير رسمي؛ لن ينشر أسعاراً ولن يرسل رسائل. أبقِ الكمبيوتر متصلاً أثناء الاختبار.</p><pre id="status"></pre></main><script>async function update(){try{const s=await(await fetch('/status')).json();document.getElementById('status').textContent=JSON.stringify(s,null,2);document.getElementById('msg').textContent=s.connection==='open'?'تم الربط. جارٍ اختبار منشورات القناة.':s.connection==='waiting-for-scan'?'الرمز جاهز للمسح.':'جارٍ الاتصال…';const q=document.getElementById('qr');q.hidden=s.connection!=='waiting-for-scan';if(!q.hidden)q.src='/qr.png?t='+Date.now();}catch{document.getElementById('msg').textContent='الخدمة متوقفة';}}update();setInterval(update,2500);</script></html>`;
const server=createServer((req,res)=>{
  if(!['127.0.0.1:9498','localhost:9498'].includes(req.headers.host)||req.method!=='GET'){res.writeHead(403);res.end();return;}
  res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('X-Frame-Options','DENY');
  if(req.url==='/status'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify(status));return;}
  if(req.url?.startsWith('/qr.png')&&qrImage){res.setHeader('Content-Type','image/png');res.end(qrImage);return;}
  if(req.url==='/'){res.setHeader('Content-Type','text/html; charset=utf-8');res.end(html);return;}
  res.writeHead(404);res.end();
});
server.listen(9498,'127.0.0.1',()=>{console.log('Local pairing page: http://127.0.0.1:9498');connect().catch(()=>{status.connection='connection-failed';});});
function stop(){stopped=true;clearTimeout(reconnectTimer);clearInterval(pollTimer);socket?.end(undefined);server.close();process.exit(0);}
process.on('SIGINT',stop);process.on('SIGTERM',stop);
