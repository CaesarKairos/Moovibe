const enc=new TextEncoder();
const b64=bytes=>btoa(String.fromCharCode(...bytes)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
const unb64=value=>Uint8Array.from(atob(value.replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0));
async function key(secret){return crypto.subtle.importKey('raw',enc.encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign','verify']);}
export function safeEqual(a,b){const aa=enc.encode(String(a||'')),bb=enc.encode(String(b||''));let diff=aa.length^bb.length;const length=Math.max(aa.length,bb.length);for(let i=0;i<length;i++)diff|=(aa[i%Math.max(aa.length,1)]||0)^(bb[i%Math.max(bb.length,1)]||0);return diff===0;}
export async function createAdminSession(secret,ttl=43200){const payload=b64(enc.encode(JSON.stringify({v:1,exp:Math.floor(Date.now()/1000)+ttl,nonce:crypto.randomUUID()})));const sig=b64(new Uint8Array(await crypto.subtle.sign('HMAC',await key(secret),enc.encode(payload))));return `${payload}.${sig}`;}
export async function verifyAdminSession(secret,value){try{const [payload,sig]=String(value||'').split('.');if(!payload||!sig)return false;const valid=await crypto.subtle.verify('HMAC',await key(secret),unb64(sig),enc.encode(payload));if(!valid)return false;const data=JSON.parse(new TextDecoder().decode(unb64(payload)));return data.v===1&&Number(data.exp)>Date.now()/1000;}catch{return false;}}
export async function createCsrfToken(secret,session){return b64(new Uint8Array(await crypto.subtle.sign('HMAC',await key(secret),enc.encode(`csrf:${session}`))));}
export async function verifyCsrfToken(secret,session,token){try{return crypto.subtle.verify('HMAC',await key(secret),unb64(String(token||'')),enc.encode(`csrf:${session}`));}catch{return false;}}
export function cookieValue(request,name){const raw=request.headers.get('cookie')||'';for(const part of raw.split(';')){const [key,...rest]=part.trim().split('=');if(key===name)return rest.join('=');}return '';}

