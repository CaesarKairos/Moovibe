export const APPLE_SNAPSHOT = 'ranking:apple:br:v1';
export const REFRESH_STATUS = 'ranking:apple:br:status:v1';
export const RANKING_CRON = '0 9 * * *';
const REGION = 'br';
const FEED = `https://rss.marketingtools.apple.com/api/v2/${REGION}/music/most-played/50/songs.json`;

function providerUrl(value, valid) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !valid(url)) {
    throw Error('INVALID_PROVIDER_URL');
  }
  return url.href;
}

export function normalizeAppleFeed(data, now = new Date()) {
  const feed = data?.feed;
  const published = new Date(feed?.updated);
  if (feed?.country !== REGION || !Array.isArray(feed.results) || feed.results.length !== 50 ||
      !Number.isFinite(+published) || +published > +now + 300000) throw Error('INVALID_APPLE_FEED');
  const ids = new Set();
  const tracks = feed.results.map((entry, index) => {
    const {id, name, artistName, url, artworkUrl100, kind} = entry || {};
    if (kind !== 'songs' || !/^\d{1,20}$/.test(id) || typeof id !== 'string' || ids.has(id) ||
        typeof name !== 'string' || !name.trim() || typeof artistName !== 'string' || !artistName.trim()) {
      throw Error('INVALID_APPLE_TRACK');
    }
    const trackUrl = providerUrl(url, u => u.hostname === 'music.apple.com' &&
      u.pathname.startsWith('/br/') && (u.searchParams.get('i') || u.pathname.split('/').at(-1)) === id);
    const cover = artworkUrl100 ? providerUrl(artworkUrl100, u => /^is\d+-ssl\.mzstatic\.com$/.test(u.hostname)) : null;
    ids.add(id);
    return {position:index+1, track_id:id, spotify_id:null, title:name.trim(), artist:artistName.trim(), url:trackUrl, cover, movie:null};
  });
  return {source:'apple', platform:'apple_music', region:'BR', source_url:'https://music.apple.com/br/browse/top-charts',
    reference_date:published.toISOString().slice(0,10), updated_at:published.toISOString(), collected_at:now.toISOString(), tracks};
}

export async function refreshRanking(kv, fetcher = fetch, now = new Date()) {
  const previous = await kv.get(APPLE_SNAPSHOT, 'json');
  const status = {source:'apple',region:'BR',last_attempt:now.toISOString(),last_success:previous?.collected_at ?? null,
    count:previous?.tracks?.length ?? 0,error:null,cron:RANKING_CRON};
  try {
    const response = await fetcher(FEED,{signal:AbortSignal.timeout(15000),redirect:'error'});
    if (!response.ok) throw Error(`APPLE_HTTP_${response.status}`);
    const candidate = normalizeAppleFeed(await response.json(),now);
    if (previous?.updated_at && previous.updated_at > candidate.updated_at) throw Error('STALE_APPLE_FEED');
    if (!previous || previous.updated_at !== candidate.updated_at) {
      if (previous) {
        const positions = new Map(previous.tracks.map(track => [track.track_id,track.position]));
        for (const track of candidate.tracks) {
          const position = positions.get(track.track_id);
          if (position) Object.assign(track,{movement:'change',delta:position-track.position});
        }
      }
      await kv.put(APPLE_SNAPSHOT,JSON.stringify(candidate));
    }
    status.last_success = now.toISOString();
    status.count = candidate.tracks.length;
  } catch (error) {
    status.error = /^(APPLE_HTTP_\d{3}|INVALID_[A-Z_]+|STALE_APPLE_FEED)$/.test(error?.message)
      ? error.message : 'APPLE_REFRESH_FAILED';
  }
  await kv.put(REFRESH_STATUS,JSON.stringify(status));
  return status;
}
