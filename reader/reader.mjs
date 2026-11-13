import { parseBulletin } from '../sarraf-preview/worker/src/parser.js';
export const CHANNEL_CODE = '0029VaDTI11HbFUzPstXcF2n';
export function textOf(message) {
  return message?.conversation || message?.extendedTextMessage?.text || message?.imageMessage?.caption || message?.videoMessage?.caption || '';
}
export function candidate({jid, expectedJid, text, timestamp, id}, previous=null, now=Date.now()) {
  if (!expectedJid || jid !== expectedJid || !jid.endsWith('@newsletter')) return {error:'wrong-channel'};
  const at=Number(timestamp)*1000;
  if(!Number.isFinite(at)||at<=0||at>now+300000)return {error:'unknown-time'};
  if(previous && at<=Date.parse(previous.post_time))return {error:'duplicate-or-older'};
  if(typeof text!=='string'||!text.trim()||text.length>12000)return {error:'non-text-or-too-long'};
  const rates=parseBulletin(text);
  if(!rates?.usd_syp)return {error:'no-valid-dollar-pair'};
  if(previous?.usd_syp){const a=(rates.usd_syp.buy+rates.usd_syp.sell)/2,b=(previous.usd_syp.buy+previous.usd_syp.sell)/2;if(Math.abs(a-b)/b>.10)return {error:'jump-needs-confirmation'};}
  return {rates:{...rates,post_time:new Date(at).toISOString(),fetched:new Date(now).toISOString(),stale:now-at>2*3600000,source:'whatsapp-channel',post_id:String(id||''),channel:CHANNEL_CODE}};
}
