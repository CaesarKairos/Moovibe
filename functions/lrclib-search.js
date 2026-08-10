/**
 * Moovibe - Autocomplete de música via LRCLIB.
 *
 * Rota dedicada: o Cloudflare Pages roteia automaticamente `/lrclib-search`
 * para este arquivo (por nome de arquivo), sem precisar de checagem manual
 * de pathname.
 */
import { LRCLIB_SEARCH_URL, lrclibHeaders, lrclibThrottle } from './_lib/lrclib.js';

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export async function onRequestGet(context) {
  const { request } = context;
  const url = new URL(request.url);
  const termo = (url.searchParams.get('q') || '').trim();
  if (!termo) return jsonResponse({ items: [] });

  try {
    await lrclibThrottle();
    const resp = await fetch(`${LRCLIB_SEARCH_URL}?q=${encodeURIComponent(termo)}`, { headers: lrclibHeaders() });
    if (!resp.ok) {
      const errorText = await resp.text().catch(() => 'Unknown error');
      console.error(`[LRCLIB-SEARCH] Falhou com status ${resp.status}:`, errorText.substring(0, 300));
      return jsonResponse({ items: [] });
    }
    const dados = await resp.json();
    if (!Array.isArray(dados)) return jsonResponse({ items: [] });

    // Filtragem e deduplicação: descarta instrumentais e deduplica por
    // track_name + artist_name. Para cada combinação, mantém o PRIMEIRO
    // item que tenha plainLyrics preenchido (senão o primeiro em geral).
    const porChave = new Map();
    for (const item of dados) {
      if (!item || item.instrumental === true) continue;
      const trackName = item.trackName || item.track_name || '';
      const artistName = item.artistName || item.artist_name || '';
      if (!trackName) continue;
      const chave = `${trackName.toLowerCase()}|${artistName.toLowerCase()}`;
      if (!porChave.has(chave)) {
        porChave.set(chave, []);
      }
      porChave.get(chave).push(item);
    }
    const itens = [];
    for (const grupo of porChave.values()) {
      const comLetra = grupo.find(g => g?.plainLyrics && g.plainLyrics.trim().length > 0) || grupo[0];
      itens.push({
        id: comLetra.id,
        trackName: comLetra.trackName || comLetra.track_name || '',
        artistName: comLetra.artistName || comLetra.artist_name || '',
      });
      if (itens.length >= 8) break;
    }
    console.log(`[LRCLIB-SEARCH] "${termo}" → ${itens.length} sugestões.`);
    return jsonResponse({ items: itens });
  } catch (err) {
    console.error('[LRCLIB-SEARCH] Erro:', err);
    return jsonResponse({ items: [] });
  }
}