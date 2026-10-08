const FIELDS=['provider','providerId','artist','lrclibId','album','duration'];

export function getTrackSelection(input){
  if(!input?.classList.contains('identity-confirmed'))return null;
  return {title:input.value.trim(),artist:input.dataset.artist||'',provider:input.dataset.provider||'',provider_id:input.dataset.providerId||'',lrclib_id:input.dataset.lrclibId||null,album:input.dataset.album||null,duration:Number(input.dataset.duration)||null};
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
