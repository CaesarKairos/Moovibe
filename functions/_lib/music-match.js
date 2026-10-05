const NOISE=/\b(official\s*(music\s*)?(video|audio)|lyric(s)?(\s*video)?|visuali[sz]er|audio|video|hd|4k)\b/gi;
const VERSION=/\b(remaster(ed)?|radio edit|album version|single version|live)\b/gi;
export function normalizeMusicText(value,{stripVersion=true}={}) {
  let text=String(value||'').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
  text=text.replace(NOISE,' ');
  if(stripVersion) text=text.replace(VERSION,' ');
  return text.replace(/\b(feat(?:uring)?|ft)\.?\s+[^()[\]-]+/g,' ').replace(/[^a-z0-9]+/g,' ').replace(/\s+/g,' ').trim();
}
const tokens=value=>new Set(normalizeMusicText(value).split(' ').filter(Boolean));
function similarity(a,b) {
  const na=normalizeMusicText(a),nb=normalizeMusicText(b); if(!na||!nb)return 0;if(na===nb)return 1;
  const aa=tokens(a),bb=tokens(b),intersection=[...aa].filter(x=>bb.has(x)).length;
  return intersection/Math.max(aa.size,bb.size);
}
export function scoreTrackMatch(wanted,candidate) {
  const title=similarity(wanted.title,candidate.title); const artist=similarity(wanted.artist,candidate.artist);
  if(title<0.82||artist<0.72)return 0;
  const album=wanted.album?similarity(wanted.album,candidate.album):0.75;
  const duration=wanted.duration&&candidate.duration?Math.max(0,1-Math.abs(Number(wanted.duration)-Number(candidate.duration))/20):0.75;
  return title*.55+artist*.30+album*.08+duration*.07;
}
export function selectBestTrack(wanted,candidates,threshold=.82) {
  return (candidates||[]).map(item=>({item,score:scoreTrackMatch(wanted,item)})).filter(x=>x.score>=threshold).sort((a,b)=>b.score-a.score)[0]?.item||null;
}

