const FIELDS=['provider','providerId','artist','artists','lrclibId','album','albumId','albumName','albumReleaseDate','albumReleaseYear','albumImageUrl','albumSpotifyUrl','spotifyUrl','spotifyUri','explicit','duration'];

export function getTrackSelection(input){
  if(!input?.classList.contains('identity-confirmed'))return null;
  return {title:input.value.trim(),artist:input.dataset.artist||'',artists:JSON.parse(input.dataset.artists||'[]'),provider:input.dataset.provider||'',provider_id:input.dataset.providerId||'',lrclib_id:input.dataset.lrclibId||null,album:input.dataset.album||null,album_id:input.dataset.albumId||'',album_name:input.dataset.albumName||'',album_release_date:input.dataset.albumReleaseDate||'',album_release_year:input.dataset.albumReleaseYear||'',album_image_url:input.dataset.albumImageUrl||'',album_spotify_url:input.dataset.albumSpotifyUrl||'',spotify_url:input.dataset.spotifyUrl||'',spotify_uri:input.dataset.spotifyUri||'',explicit:input.dataset.explicit==='true',duration:Number(input.dataset.duration)||null};
}

export function clearTrackSelection(input,{preserveText=true,focus=false}={}){
  if(!input)return;
  for(const field of FIELDS)delete input.dataset[field];
  input.classList.remove('identity-confirmed');
  input.closest('.autocomplete-group')?.classList.remove('is-confirmed');
  input.removeAttribute('aria-hidden'); input.removeAttribute('tabindex'); input.setCustomValidity('');
  input.parentElement?.querySelector('.selected-track-card')?.remove();
  if(!preserveText)input.value='';
  if(focus)input.focus();
}

export function setTrackSelection(input,track,{changeLabel='Change song',confirmedLabel='Confirmed song',onChange}={}){
  clearTrackSelection(input,{preserveText:true});
  input.value=track.title||'';
  input.dataset.provider=track.provider||''; input.dataset.providerId=String(track.provider_id||'');
  input.dataset.artist=track.artist||''; input.dataset.lrclibId=String(track.lrclib_id||'');
  input.dataset.album=track.album||''; input.dataset.duration=String(track.duration||'');
  input.dataset.artists=JSON.stringify(track.artists||[track.artist].filter(Boolean));input.dataset.albumId=track.album_id||'';input.dataset.albumName=track.album_name||track.album||'';input.dataset.albumReleaseDate=track.album_release_date||'';input.dataset.albumReleaseYear=track.album_release_year||'';input.dataset.albumImageUrl=track.album_image_url||'';input.dataset.albumSpotifyUrl=track.album_spotify_url||'';input.dataset.spotifyUrl=track.spotify_url||'';input.dataset.spotifyUri=track.spotify_uri||'';input.dataset.explicit=String(Boolean(track.explicit));
  input.classList.add('identity-confirmed'); input.closest('.autocomplete-group')?.classList.add('is-confirmed');
  input.setAttribute('aria-hidden','true'); input.setAttribute('tabindex','-1'); input.setCustomValidity('');
  const card=document.createElement('div'); card.className='selected-track-card'; card.setAttribute('role','group'); card.setAttribute('aria-label',`${confirmedLabel}: ${track.title} — ${track.artist}`);
  const copy=document.createElement('div'); copy.className='selected-track-copy';
  const title=document.createElement('strong'); title.textContent=track.title||'';
  const metadata=document.createElement('span'),seconds=Number(track.duration)||0;
  const duration=seconds?`${Math.floor(seconds/60)}:${String(Math.round(seconds%60)).padStart(2,'0')}`:'';
  metadata.textContent=[track.artist,track.album,duration].filter(Boolean).join(' · ');
  const change=document.createElement('button'); change.type='button'; change.className='change-track-btn'; change.textContent=changeLabel; change.setAttribute('aria-label',`${changeLabel}: ${track.title}`);
  change.addEventListener('click',()=>{clearTrackSelection(input,{preserveText:true,focus:true});onChange?.(input);});
  copy.append(title,metadata); card.append(copy,change); input.insertAdjacentElement('afterend',card);
  return card;
}

export function resetTrackField(input){clearTrackSelection(input,{preserveText:false});}
