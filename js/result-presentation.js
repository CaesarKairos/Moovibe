export const POSTER_CROP_POSITIONS=['44% 18%','50% 50%','56% 82%'];

export function buildMediaSlots(stills,poster){
  const real=(Array.isArray(stills)?stills:[]).filter(Boolean).slice(0,3).map(src=>({src,source:'still',position:'50% 50%'}));
  while(real.length<3&&poster){const index=real.length;real.push({src:poster,source:'poster-crop',position:POSTER_CROP_POSITIONS[index]});}
  return real;
}
