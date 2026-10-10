export function formatLyricsPreview(text,maxChars=280){
  const limit=Math.max(1,Number(maxChars)||280);
  const normalized=String(text||'').replace(/\r\n?/g,'\n').split('\n').map(line=>line.replace(/[ \t]+$/g,'')).join('\n').replace(/^\n+|\n+$/g,'').replace(/\n{3,}/g,'\n\n');
  if(normalized.length<=limit)return normalized;
  const lines=normalized.split('\n'),kept=[];
  for(const line of lines){const current=kept.join('\n'),separator=kept.length?'\n':'';if(current.length+separator.length+line.length<=limit-1){kept.push(line);continue;}const available=limit-current.length-separator.length;if(available>1){let part=line.slice(0,available-1).trimEnd();const boundary=part.lastIndexOf(' ');if(boundary>Math.floor(part.length*.55))part=part.slice(0,boundary);kept.push(`${part.trimEnd()}…`);}else if(kept.length){const last=kept.length-1;kept[last]=`${kept[last].slice(0,Math.max(0,kept[last].length-1)).trimEnd()}…`;}break;}
  return kept.join('\n').slice(0,limit);
}
