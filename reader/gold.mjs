import {normalizeDigits,parseNumber} from '../sarraf-preview/worker/src/parser.js';
export const GOLD_CODE='0029Vb7qbyB3AzNT8HM11t3B';
export function goldBulletins(messages,now=Date.now()){
  const ordered=[...new Map(messages.map(m=>[String(m.id),m])).values()].sort((a,b)=>Date.parse(a.post_time)-Date.parse(b.post_time));
  let context=null, latest=null;
  for(const m of ordered){
    const at=Date.parse(m.post_time);if(!Number.isFinite(at)||at>now+300000)continue;
    const text=normalizeDigits(m.text||'').replace(/[*_]/g,'');
    if(!/تسعير|تعديل|ذهب/.test(text))continue;
    const explicit=text.match(/عيار\s*(24|22|21|18|14)\b/);
    const inherited=!explicit&&context&&at-context.at<=24*3600000;
    const karat=explicit?Number(explicit[1]):inherited?context.karat:null;
    if(!karat)continue;
    let buy=null,sell=null;
    for(const line of text.split('\n')){
      if(!/\$|دولار|USD/i.test(line))continue;
      const number=line.match(/\d+(?:[.,]\d+)*/)?.[0];if(!number)continue;
      const v=parseNumber(number);if(!(v>0&&v<=5000))continue;
      if(/شراء/.test(line))buy=v;if(/مبيع|بيع/.test(line))sell=v;
    }
    if(buy===null||sell===null||buy>sell)continue;
    if(explicit)context={karat,at,id:String(m.id)};
    latest={source:'whatsapp-channel',channel:GOLD_CODE,post_id:String(m.id),post_time:new Date(at).toISOString(),fetched:new Date(now).toISOString(),currency:'USD',karat,buy,sell,karat_inherited:!explicit,karat_reference:explicit?String(m.id):context.id,unit:/غرام|جرام/.test(text)?'gram':'not-explicit-in-bulletin',stale:now-at>2*3600000,estimated:false};
  }
  return latest;
}
