import { SNAPSHOT } from './_lib/top-global.js';

export async function onRequestGet({env}) {
  try {
    const snapshot = await env.MOOVIBE_DB.get(SNAPSHOT,'json');
    if (snapshot) return Response.json(snapshot,{headers:{'cache-control':'public, max-age=300'}});
  } catch {}
  return Response.json(null,{status:503,headers:{'cache-control':'no-store'}});
}
