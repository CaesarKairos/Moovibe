const TRACK_ID=/^[A-Za-z0-9]{22}$/;

export function spotifyTrackUrl(provider,providerId){return provider==='spotify'&&TRACK_ID.test(String(providerId||''))?`https://open.spotify.com/track/${providerId}`:null;}
export function spotifyEmbedUrl(provider,providerId){const trackUrl=spotifyTrackUrl(provider,providerId);return trackUrl?trackUrl.replace('/track/','/embed/track/'):null;}
export function spotifyArtwork(song){return song?.provider==='spotify'&&song?.album_image_url?String(song.album_image_url):'';}
