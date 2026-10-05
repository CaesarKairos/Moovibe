const SECRET_KEYS=/authorization|cookie|token|secret|api[-_]?key|credential/i;
const SECRET_VALUE=/(bearer\s+[\w.-]+|AIza[\w-]{20,}|sk-[\w-]{16,})/gi;
export function sanitizeAudit(value,depth=0) {
  if(depth>8)return '[TRUNCATED]';
  if(typeof value==='string')return value.replace(SECRET_VALUE,'[REDACTED]').slice(0,50000);
  if(Array.isArray(value))return value.slice(0,200).map(v=>sanitizeAudit(v,depth+1));
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,SECRET_KEYS.test(k)?'[REDACTED]':sanitizeAudit(v,depth+1)]));
  return value;
}
export async function writeAudit(env,trace) {
  if(!env.AI_AUDIT_LOGS)return false;
  const safe=sanitizeAudit(trace); const timestamp=safe.timestamp||new Date().toISOString();
  const key=`${timestamp.slice(0,10)}/${timestamp}/${safe.request_id||crypto.randomUUID()}-${safe.stage||'unknown'}.json`;
  await env.AI_AUDIT_LOGS.put(key,JSON.stringify(safe),{httpMetadata:{contentType:'application/json'}}); return true;
}
