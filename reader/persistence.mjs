import {randomBytes,scryptSync,createCipheriv,createDecipheriv} from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
function key(secret){if(!secret||secret.length<24)throw new Error('SESSION_KEY must be at least 24 characters');return scryptSync(secret,'sarraf-session-v1',32);}
export function seal(data,secret){const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key(secret),iv);const encrypted=Buffer.concat([cipher.update(JSON.stringify(data)),cipher.final()]);return JSON.stringify({v:1,iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),data:encrypted.toString('base64')});}
export function unseal(value,secret){const o=JSON.parse(value);if(o.v!==1)throw new Error('Unknown session format');const decipher=createDecipheriv('aes-256-gcm',key(secret),Buffer.from(o.iv,'base64'));decipher.setAuthTag(Buffer.from(o.tag,'base64'));return JSON.parse(Buffer.concat([decipher.update(Buffer.from(o.data,'base64')),decipher.final()]).toString('utf8'));}
export async function capture(dir){const files={};for(const entry of await fs.readdir(dir,{withFileTypes:true})){if(entry.isFile()&&entry.name.endsWith('.json'))files[entry.name]=await fs.readFile(path.join(dir,entry.name),'utf8');}return files;}
export async function restore(dir,files){await fs.mkdir(dir,{recursive:true});for(const [name,data] of Object.entries(files)){if(!/^[A-Za-z0-9_.-]+\.json$/.test(name)||name.includes('..')||typeof data!=='string')throw new Error('Unsafe session filename');await fs.writeFile(path.join(dir,name),data,{mode:0o600});}}
