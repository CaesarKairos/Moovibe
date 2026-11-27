const MAX_BYTES=10*1024*1024;

function allowed(url) {
  return url.protocol==='https:' && (
    url.hostname==='image.tmdb.org' || url.hostname==='i.scdn.co' ||
    /^is\d+-ssl\.mzstatic\.com$/i.test(url.hostname)
  );
}
function invalid(status=400) { return new Response('Invalid image URL',{status,headers:{'cache-control':'no-store'}}); }
async function fetchImage(url, redirects=0) {
  if (!allowed(url) || redirects>2) throw Error('INVALID_URL');
  const response=await fetch(url,{redirect:'manual',signal:AbortSignal.timeout(12000),headers:{accept:'image/avif,image/webp,image/*'}});
  if (response.status>=300 && response.status<400) {
    const location=response.headers.get('location');
    if (!location) throw Error('REDIRECT');
    return fetchImage(new URL(location,url),redirects+1);
  }
  if (!response.ok) throw Error(`HTTP_${response.status}`);
  const type=(response.headers.get('content-type')||'').split(';')[0].toLowerCase(),length=Number(response.headers.get('content-length')||0);
  if (!type.startsWith('image/') || length>MAX_BYTES) throw Error('INVALID_IMAGE');
  const body=await response.arrayBuffer();
  if (body.byteLength>MAX_BYTES) throw Error('TOO_LARGE');
  return new Response(body,{headers:{'content-type':type,'cache-control':'public, max-age=86400, s-maxage=604800','x-content-type-options':'nosniff'}});
}
export async function onRequestGet({request}) {
  let target; try { target=new URL(new URL(request.url).searchParams.get('url')||''); } catch { return invalid(); }
  try { return await fetchImage(target); } catch { return invalid(502); }
}
