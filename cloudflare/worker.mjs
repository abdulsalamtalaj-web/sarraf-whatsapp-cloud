const reply=(data,status=200,publicRoute=false)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':publicRoute?'public, max-age=30':'no-store','X-Content-Type-Options':'nosniff',...(publicRoute?{'Access-Control-Allow-Origin':'*'}:{})}});
async function authorized(req,env){
  if(!env.STORE_TOKEN)return false;
  const enc=new TextEncoder(),digest=async s=>new Uint8Array(await crypto.subtle.digest('SHA-256',enc.encode(s)));
  const [a,b]=await Promise.all([digest(req.headers.get('authorization')||''),digest('Bearer '+env.STORE_TOKEN)]);let diff=0;for(let i=0;i<a.length;i++)diff|=a[i]^b[i];return diff===0;
}
export default {async scheduled(event,env,ctx){
 if(!env.READER_URL||!env.STORE_TOKEN)return;
 const url=new URL('/poll',env.READER_URL);if(url.protocol!=='https:')return;
 ctx.waitUntil(fetch(url,{method:'POST',headers:{authorization:'Bearer '+env.STORE_TOKEN},signal:AbortSignal.timeout(90000)}).then(r=>{if(!r.ok)console.log('Reader poll unavailable');}).catch(()=>console.log('Reader unavailable')));
},async fetch(req,env){
 try{
  const url=new URL(req.url),now=Date.now();
  if(url.pathname==='/health')return reply({ok:true});
  if(url.pathname==='/rates'&&req.method==='GET'){
    const row=await env.DB.prepare('SELECT rates,updated_at FROM singleton WHERE id=1').first();
    if(!row?.rates)return reply({error:'لم تصل نشرة أسعار بعد'},503,true);
    const rates=JSON.parse(row.rates);if(!rates.usd_syp)return reply({error:'لم تصل نشرة أسعار عملات بعد'},503,true);rates.stale=!rates.post_time||now-Date.parse(rates.post_time)>7200000;
    if(rates.gold)rates.gold.stale=!rates.gold.post_time||now-Date.parse(rates.gold.post_time)>7200000;
    return reply(rates,200,true);
  }
  if(!url.pathname.startsWith('/admin/'))return reply({error:'not-found'},404);
  if(!await authorized(req,env))return reply({error:'unauthorized'},401);
  const owner=req.headers.get('x-reader-id');if(!/^[a-f0-9-]{36}$/.test(owner||''))return reply({error:'reader-id-required'},400);
  if(url.pathname==='/admin/lease'&&req.method==='POST'){
    const r=await env.DB.prepare('UPDATE singleton SET owner=?,lease_until=? WHERE id=1 AND (owner=? OR lease_until<?)').bind(owner,now+180000,owner,now).run();
    return reply({acquired:r.meta.changes===1},r.meta.changes===1?200:409);
  }
  const row=await env.DB.prepare('SELECT * FROM singleton WHERE id=1').first();
  if(row?.owner!==owner||row.lease_until<now)return reply({error:'lease-lost'},409);
  if(url.pathname==='/admin/state'&&req.method==='GET')return reply({encryptedSession:row.encrypted_session,rates:row.rates?JSON.parse(row.rates):null});
  if(url.pathname==='/admin/state'&&req.method==='PUT'){
    const body=await req.text();if(body.length>1800000)return reply({error:'too-large'},413);
    let state;try{state=JSON.parse(body);}catch{return reply({error:'invalid-json'},400);}
    if(typeof state.encryptedSession!=='string'||!state.encryptedSession||!state.rates||typeof state.rates!=='object')return reply({error:'invalid-state'},400);
    const r=await env.DB.prepare('UPDATE singleton SET encrypted_session=?,rates=?,updated_at=? WHERE id=1 AND owner=? AND lease_until>=?').bind(state.encryptedSession,JSON.stringify(state.rates),now,owner,now).run();
    return reply({saved:r.meta.changes===1},r.meta.changes===1?200:409);
  }
  if(url.pathname==='/admin/release'&&req.method==='POST'){
    await env.DB.prepare('UPDATE singleton SET lease_until=0 WHERE id=1 AND owner=?').bind(owner).run();return reply({released:true});
  }
  return reply({error:'not-found'},404);
 }catch{return reply({error:'storage-unavailable'},503);}
}};
