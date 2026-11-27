import { refreshRanking } from '../../functions/_lib/ranking-refresh.js';

export default {
  async scheduled(_controller, env) {
    const result = await refreshRanking(env.MOOVIBE_RANKING);
    console.log(JSON.stringify({event:'ranking_refresh', ...result}));
    if (result.error) throw Error(result.error);
  }
};
