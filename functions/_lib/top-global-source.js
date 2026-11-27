export const SOURCES = {
  playlist: 'https://open.spotify.com/playlist/37i9dQZEVXbMDoHDwVN2tF',
  charts: 'https://charts.spotify.com/charts/view/regional-global-daily/latest',
};

export function chartCsvTracks(csv) {
  if (typeof csv !== 'string' || csv.length > 90000) throw Error('INVALID_CHART_CSV');
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i=0; i<csv.length; i++) {
    const c = csv[i];
    if (c === '"') {
      if (quoted && csv[i+1] === '"') { field += '"'; i++; }
      else quoted = !quoted;
    } else if (!quoted && (c === ',' || c === '\n')) {
      row.push(field); field = '';
      if (c === '\n') { rows.push(row); row=[]; }
    } else if (c !== '\r' || quoted) field += c;
  }
  if (quoted) throw Error('INVALID_CHART_CSV');
  rows.push([...row,field]);
  const columns = rows.shift().map(name => name.replace(/^\uFEFF/,'').trim().toLowerCase());
  const indexes = ['rank','track name','artist names','uri'].map(name => columns.indexOf(name));
  if (indexes.includes(-1)) throw Error('INVALID_CHART_CSV_HEADER');
  return rows.filter(row=>row.some(Boolean)).slice(0,50).map(row => {
    const [rank,title,artist,uri] = indexes.map(index=>row[index]);
    return {position:Number(rank),title,artist,spotify_id:uri?.match(/^spotify:track:([a-zA-Z0-9]{22})$/)?.[1]
      || uri?.match(/^https:\/\/open\.spotify\.com\/track\/([a-zA-Z0-9]{22})$/)?.[1]};
  });
}

export function validateRanking(input) {
  if (input?.authorized !== true || !Object.hasOwn(SOURCES, input.source)) throw Error('SOURCE_AUTHORIZATION_REQUIRED');
  const date = input.reference_date;
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
      !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date ||
      date > new Date().toISOString().slice(0, 10)) throw Error('INVALID_REFERENCE_DATE');
  if (!Array.isArray(input.tracks) || input.tracks.length !== 50) throw Error('EXPECTED_50_TRACKS');
  const ids = new Set();
  const tracks = input.tracks.map((track, index) => {
    const { position, spotify_id, lrclib_id, cover } = track || {};
    const title = typeof track?.title === 'string' ? track.title.trim() : '';
    const artist = typeof track?.artist === 'string' ? track.artist.trim() : '';
    if (position !== index + 1 || typeof spotify_id !== 'string' || !/^[a-zA-Z0-9]{22}$/.test(spotify_id) ||
        ids.has(spotify_id) || !title || title.length > 240 || !artist || artist.length > 240 ||
        (lrclib_id != null && !/^\d{1,12}$/.test(String(lrclib_id)))) throw Error('INVALID_TRACK');
    if (cover != null && (typeof cover !== 'string' || !/^https:\/\/i\.scdn\.co\/image\/[a-f\d]{40}$/i.test(cover))) throw Error('INVALID_COVER');
    ids.add(spotify_id);
    return {position, spotify_id, title, artist, cover: cover ?? null, lrclib_id: lrclib_id == null ? null : String(lrclib_id)};
  });
  return {source:input.source, reference_date:date, tracks};
}

export function trackMovement(previous, position, hasPrevious) {
  if (!hasPrevious) return [null, null];
  if (!previous) return ['NEW', null];
  if (previous.position == null) return ['RE', null];
  return ['change', previous.position - position];
}
