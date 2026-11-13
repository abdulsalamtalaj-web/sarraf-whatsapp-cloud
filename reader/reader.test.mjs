import test from 'node:test';import assert from 'node:assert/strict';import {candidate,textOf} from './reader.mjs';
const now=Date.now(),jid='123@newsletter',input={jid,expectedJid:jid,text:'الدولار الأمريكي\nشراء 145\nمبيع 146',timestamp:now/1000,id:'1'};
test('accept allowlisted fresh valid bulletin, preserve publication time',()=>{const r=candidate(input,null,now);assert.equal(r.rates.usd_syp.buy,145);assert.equal(Date.parse(r.rates.post_time),now);});
test('reject personal chat and other channel',()=>{assert.equal(candidate({...input,jid:'123@s.whatsapp.net'},null,now).error,'wrong-channel');assert.equal(candidate({...input,jid:'other@newsletter'},null,now).error,'wrong-channel');});
test('reject future and missing times; preserve old valid with stale label',()=>{for(const timestamp of [0,now/1000+1000])assert(candidate({...input,timestamp},null,now).error);assert.equal(candidate({...input,timestamp:now/1000-10000},null,now).rates.stale,true);});
test('reject invalid and duplicate bulletin',()=>{assert(candidate({...input,text:'مرحبا'},null,now).error);assert.equal(candidate(input,candidate(input,null,now).rates,now).error,'duplicate-or-older');});
test('hold >10% jump',()=>{const prior={usd_syp:{buy:100,sell:101},post_time:new Date(now-10000).toISOString()};assert.equal(candidate(input,prior,now).error,'jump-needs-confirmation');});
test('extract caption, never invent text',()=>{assert.equal(textOf({imageMessage:{caption:'نشرة'}}),'نشرة');assert.equal(textOf({audioMessage:{}}),'');});
