import makeWASocket,{useMultiFileAuthState,DisconnectReason,Browsers,proto} from 'baileys';
import pino from 'pino';import QRCode from 'qrcode';import {createServer} from 'node:http';
import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import {randomUUID,createHash,timingSafeEqual} from 'node:crypto';
import {candidate,textOf,CHANNEL_CODE} from './reader.mjs';
import {goldBulletins,GOLD_CODE} from './gold.mjs';
import {capture,restore,seal,unseal} from './persistence.mjs';
const {STORE_URL,STORE_TOKEN,SESSION_KEY,ADMIN_PASSWORD}=process.env;
if(!STORE_URL?.startsWith('https://')||!STORE_TOKEN||!SESSION_KEY||SESSION_KEY.length<24||!ADMIN_PASSWORD||ADMIN_PASSWORD.length<24)throw new Error('Set STORE_URL (https), STORE_TOKEN, SESSION_KEY and ADMIN_PASSWORD (24+ characters).');
const storeBase=new URL(STORE_URL);if(storeBase.username||storeBase.password)throw new Error('Do not put credentials in STORE_URL');
const owner=randomUUID(),dir=await fs.mkdtemp(path.join(os.tmpdir(),'sarraf-auth-'));
let socket=null,qr=null,fxJid=null,goldJid=null,currency=null,gold=null,probes=[],busy=false,active=false,stopping=false,mutation=Promise.resolve(),pollTimer=null,renewTimer=null,reconnectTimer=null;
const status={connection:'starting',fx:'not-resolved',gold:'not-resolved',lastPoll:null,lastSave:null,error:null};
const same=(a,b)=>timingSafeEqual(createHash('sha256').update(a).digest(),createHash('sha256').update(b).digest());
async function remote(route,method='GET',body){const res=await fetch(new URL(route,storeBase),{method,headers:{authorization:'Bearer '+STORE_TOKEN,'x-reader-id':owner,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(25000)});if(!res.ok)throw new Error(res.status===409?'lease-lost':'store-unavailable');return res.json();}
function rates(){
 if(!currency)return {};
 const out={...currency,city:currency.city||null,remit:null,derived:[],gold:null};
 if(gold)out.gold={source:'whatsapp-hamwi',channel:GOLD_CODE,post_time:gold.post_time,post_id:gold.post_id,estimated:false,karat:gold.karat,quotes_usd:{[gold.karat]:{buy:gold.buy,sell:gold.sell}},karat_inherited:gold.karat_inherited,karat_reference:gold.karat_reference,unit:gold.unit,usd:{},syp:null};
 return out;
}
async function persist(){
 if(!active)return;
 const auth=await capture(dir);if(!Object.keys(auth).length)return;
 await remote('/admin/state','PUT',{encryptedSession:seal({auth,currency,gold,probes},SESSION_KEY),rates:rates()});status.lastSave=new Date().toISOString();
}
function enqueue(fn){mutation=mutation.then(fn).catch(e=>{status.error=e.message;void stop(1);});return mutation;}
async function handle(jid,message,time,id){
 const text=textOf(message);if(!text||text.length>12000)return;
 if(jid===fxJid){const result=candidate({jid,expectedJid:fxJid,text,timestamp:Number(time),id},currency);if(result.rates)currency=result.rates;else status.lastCurrencyResult=result.error;}
 if(jid===goldJid){const at=Number(time)*1000;if(!Number.isFinite(at)||at<=0||at>Date.now()+300000)return;probes=probes.filter(p=>String(p.id)!==String(id));probes.push({id,text,post_time:new Date(at).toISOString()});probes.sort((a,b)=>Date.parse(a.post_time)-Date.parse(b.post_time));probes=probes.slice(-40);gold=goldBulletins(probes)||gold;}
}
async function walk(n,jid){if(!n||typeof n!=='object')return;if(n.tag==='message'&&Array.isArray(n.content))for(const child of n.content)if(child.tag==='plaintext'&&child.content instanceof Uint8Array){try{await handle(jid,proto.Message.decode(child.content),n.attrs.t,n.attrs.server_id||n.attrs.id);}catch{status.error='message-decode-failed';}}if(Array.isArray(n.content))for(const child of n.content)await walk(child,jid);}
async function poll(){
 if(busy||status.connection!=='open'||!active)return;busy=true;status.lastPoll=new Date().toISOString();
 try{
  for(const [kind,invite] of [['fx',CHANNEL_CODE],['gold',GOLD_CODE]]){
   try{
    let jid=kind==='fx'?fxJid:goldJid;
    if(!jid){const meta=await socket.newsletterMetadata('invite',invite);if(!meta?.id?.endsWith('@newsletter'))throw new Error();jid=meta.id;if(kind==='fx')fxJid=jid;else goldJid=jid;status[kind]='resolved';}
    const response=await socket.query({tag:'iq',attrs:{id:socket.generateMessageTag(),type:'get',to:'s.whatsapp.net',xmlns:'newsletter'},content:[{tag:'messages',attrs:{type:'jid',jid,count:'10'}}]});
    await walk(response,jid);status[kind]='read';
   }catch{status[kind]='request-failed';}
  }
  await enqueue(persist);
 }finally{busy=false;}
}
async function connect(){
 if(stopping||!active)return;
 const {state,saveCreds}=await useMultiFileAuthState(dir),set=state.keys.set.bind(state.keys);
 state.keys.set=data=>enqueue(async()=>{await set(data);await persist();});
 socket=makeWASocket({auth:state,logger:pino({level:'silent'}),browser:Browsers.ubuntu('Chrome'),syncFullHistory:false,markOnlineOnConnect:false,shouldSyncHistoryMessage:()=>false,shouldIgnoreJid:jid=>!jid.endsWith('@newsletter'),getMessage:async()=>undefined,connectTimeoutMs:30000,defaultQueryTimeoutMs:25000});
 socket.ev.on('creds.update',()=>enqueue(async()=>{await saveCreds();await persist();}));
 socket.ev.on('connection.update',async u=>{
  if(stopping)return;
  if(u.qr){qr=await QRCode.toBuffer(u.qr,{width:320,margin:2});status.connection='waiting-for-scan';}
  if(u.connection==='open'){qr=null;status.connection='open';void poll();clearInterval(pollTimer);pollTimer=setInterval(poll,120000);}
  if(u.connection==='close'){qr=null;clearInterval(pollTimer);fxJid=null;goldJid=null;const code=u.lastDisconnect?.error?.output?.statusCode;status.connection=code===DisconnectReason.loggedOut?'logged-out':'reconnecting';if(code!==DisconnectReason.loggedOut){clearTimeout(reconnectTimer);reconnectTimer=setTimeout(()=>connect().catch(()=>{status.error='connection-failed';}),15000);}}
 });
 socket.ev.on('messages.upsert',({messages})=>enqueue(async()=>{for(const m of messages||[])if(m.key?.remoteJid===fxJid||m.key?.remoteJid===goldJid)await handle(m.key.remoteJid,m.message,Number(m.messageTimestamp),m.key.id);await persist();}));
}
async function start(){
 await remote('/admin/lease','POST');active=true;
 renewTimer=setInterval(async()=>{try{await remote('/admin/lease','POST');}catch{status.error='lease-renew-failed';await stop(1);}},60000);
 const saved=await remote('/admin/state');
 if(saved.encryptedSession){const data=unseal(saved.encryptedSession,SESSION_KEY);await restore(dir,data.auth);currency=data.currency||null;gold=data.gold||null;probes=data.probes||[];}
 await connect();
}
const html=`<!doctype html><html lang="ar" dir="rtl"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>إدارة صرّاف</title><style>body{font:18px system-ui;max-width:640px;padding:24px;margin:auto;background:#edf5ef;color:#173b25}img{max-width:100%;display:block;margin:auto}pre{direction:ltr;white-space:pre-wrap;font-size:13px}</style><h1>قارئ صرّاف المستضاف</h1><p>هذه صفحة المدير فقط. امسح الرمز من الرقم المخصص عند الحاجة. المستخدمون لا يحتاجون واتساب أو هذه الصفحة.</p><img id="qr" alt="رمز ربط واتساب"><p id="message"></p><pre id="status"></pre><script>async function update(){const s=await(await fetch('/status')).json();document.getElementById('status').textContent=JSON.stringify(s,null,2);const q=document.getElementById('qr');q.hidden=s.connection!=='waiting-for-scan';if(!q.hidden)q.src='/qr.png?t='+Date.now();document.getElementById('message').textContent=s.connection==='open'?'واتساب متصل':'حالة الاتصال: '+s.connection;}update();setInterval(update,3000)</script></html>`;
const server=createServer((req,res)=>{
 res.setHeader('Cache-Control','no-store');res.setHeader('X-Frame-Options','DENY');res.setHeader('X-Content-Type-Options','nosniff');
 if(req.url==='/health'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({alive:true,ready:active}));return;}
 if(req.url==='/poll'&&req.method==='POST'&&same(req.headers.authorization||'','Bearer '+STORE_TOKEN)){void poll();res.writeHead(202);res.end();return;}
 if(!same(req.headers.authorization||'','Basic '+Buffer.from('admin:'+ADMIN_PASSWORD).toString('base64'))){res.setHeader('WWW-Authenticate','Basic realm="Sarraf admin", charset="UTF-8"');res.writeHead(401);res.end('Authentication required');return;}
 if(req.method!=='GET'){res.writeHead(405);res.end();return;}
 if(req.url==='/status'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({...status,lastCurrencyPublication:currency?.post_time,lastGoldPublication:gold?.post_time}));return;}
 if(req.url.startsWith('/qr.png')&&qr){res.setHeader('Content-Type','image/png');res.end(qr);return;}
 if(req.url==='/'){res.setHeader('Content-Type','text/html; charset=utf-8');res.end(html);return;}
 res.writeHead(404);res.end();
});
server.listen(Number(process.env.PORT)||10000,'0.0.0.0',()=>{console.log('Sarraf cloud reader listening');start().catch(e=>{status.error=e.message;void stop(1);});});
async function stop(code=0){if(stopping)return;stopping=true;clearInterval(pollTimer);clearInterval(renewTimer);clearTimeout(reconnectTimer);socket?.end(undefined);if(active){active=false;try{await remote('/admin/release','POST');}catch{}}server.close();process.exit(code);}
process.on('SIGTERM',()=>void stop());process.on('SIGINT',()=>void stop());
