import { SNAPSHOT } from '../_lib/top-global.js';
import { APPLE_SNAPSHOT } from '../_lib/ranking-refresh.js';

export async function onRequestGet({env}) {
  try {
    const ranking = env.MOOVIBE_RANKING || env.MOOVIBE_DB;
    const snapshot = await ranking.get(SNAPSHOT,'json')
      || await (env.MOOVIBE_RANKING ? env.MOOVIBE_DB?.get(SNAPSHOT,'json').catch(()=>null) : null)
      || await ranking.get(APPLE_SNAPSHOT,'json');
    if (snapshot) return Response.json(snapshot,{headers:{'cache-control':'public, max-age=300'}});
  } catch {}
  return Response.json(null,{status:503,headers:{'cache-control':'no-store'}});
}
