var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// .wrangler/tmp/pages-e7Zm4N/functionsWorker-0.11251635149196604.mjs
var __defProp2 = Object.defineProperty;
var __name2 = /* @__PURE__ */ __name((target, value) => __defProp2(target, "name", { value, configurable: true }), "__name");
var SITE_URL = "https://moovibe.pages.dev";
function escaparHtml(texto) {
  if (typeof texto !== "string") return "";
  return texto.replace(/&/g, "&#38;").replace(/</g, "&#60;").replace(/>/g, "&#62;").replace(/"/g, "&#34;");
}
__name(escaparHtml, "escaparHtml");
__name2(escaparHtml, "escaparHtml");
async function onRequestGet(context) {
  const { request, env, params } = context;
  const slug = params && params.slug ? String(params.slug) : "";
  if (!slug) {
    try {
      const resp = await env.ASSETS.fetch(request);
      return new Response(resp.body, {
        status: resp.status,
        headers: { "Content-Type": "text/html" }
      });
    } catch (err) {
      return new Response("Not found", { status: 404 });
    }
  }
  let shareData = null;
  try {
    const kv = env.MOOVIBE_DB;
    if (kv) {
      shareData = await kv.get("share:" + slug, "json");
    }
  } catch (err) {
    console.error("[SHARE-OG] Falha ao ler KV:", err);
    shareData = null;
  }
  if (!shareData) {
    try {
      const resp = await env.ASSETS.fetch(request);
      return new Response(resp.body, {
        status: resp.status,
        headers: { "Content-Type": "text/html" }
      });
    } catch (err) {
      return new Response("Not found", { status: 404 });
    }
  }
  const indexResp = await env.ASSETS.fetch(request);
  let html = await indexResp.text();
  const movie = shareData.movie || {};
  const song = shareData.song || "";
  const artist = shareData.artist || "";
  const tituloFilme = movie.title || "Moovibe";
  const anoFilme = movie.release_year || "";
  const poster = movie.poster_url || "";
  const ogImage = poster || `${SITE_URL}/images/og-image.png`;
  let descricao = movie.synopsis || "";
  if (!descricao || descricao === "Sem sinopse disponivel.") {
    const ai = movie.ai_explanation || "";
    descricao = ai.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  }
  if (!descricao) {
    descricao = `O Moovibe conectou a m\xFAsica "${song}" de ${artist} ao filme ${tituloFilme}${anoFilme ? ` (${anoFilme})` : ""}.`;
  }
  descricao = descricao.substring(0, 300);
  const ogTitle = `${tituloFilme}${anoFilme ? ` (${anoFilme})` : ""} \u2014 Moovibe`;
  const shareUrl = `${SITE_URL}/share/${encodeURIComponent(slug)}`;
  const substituicoes = [
    [/<title>[^<]*<\/title>/i, `<title>${ogTitle}</title>`],
    [/<meta property="og:title" content="[^"]*"/i, `<meta property="og:title" content="${escaparHtml(ogTitle)}"`],
    [/<meta property="og:description" content="[^"]*"/i, `<meta property="og:description" content="${escaparHtml(descricao)}"`],
    [/<meta property="og:url" content="[^"]*"/i, `<meta property="og:url" content="${shareUrl}"`],
    [/<meta property="og:image" content="[^"]*"/i, `<meta property="og:image" content="${escaparHtml(ogImage)}"`],
    [/<meta name="twitter:title" content="[^"]*"/i, `<meta name="twitter:title" content="${escaparHtml(ogTitle)}"`],
    [/<meta name="twitter:description" content="[^"]*"/i, `<meta name="twitter:description" content="${escaparHtml(descricao)}"`],
    [/<meta name="twitter:image" content="[^"]*"/i, `<meta name="twitter:image" content="${escaparHtml(ogImage)}"`],
    [/<link rel="canonical" href="[^"]*"/i, `<link rel="canonical" href="${shareUrl}"`]
  ];
  for (const [pattern, replacement] of substituicoes) {
    html = html.replace(pattern, replacement);
  }
  return new Response(html, {
    status: 200,
    headers: { "Content-Type": "text/html" }
  });
}
__name(onRequestGet, "onRequestGet");
__name2(onRequestGet, "onRequestGet");
var LRCLIB_URL = "https://lrclib.net/api";
var LRCLIB_GET_URL = `${LRCLIB_URL}/get`;
var LRCLIB_SEARCH_URL = `${LRCLIB_URL}/search`;
var LRCLIB_THROTTLE_MS = 250;
var MOOVIBE_VERSION = "1.0";
var MOOVIBE_USER_AGENT = `Moovibe/${MOOVIBE_VERSION} (mailto:cesarbatistasantos08@gmail.com)`;
var lrclibLastRequest = 0;
function lrclibThrottle() {
  const now = Date.now();
  const wait = Math.max(0, LRCLIB_THROTTLE_MS - (now - lrclibLastRequest));
  lrclibLastRequest = now + wait;
  return wait > 0 ? new Promise((resolve) => setTimeout(resolve, wait)) : Promise.resolve();
}
__name(lrclibThrottle, "lrclibThrottle");
__name2(lrclibThrottle, "lrclibThrottle");
function lrclibHeaders() {
  return {
    "User-Agent": MOOVIBE_USER_AGENT,
    "X-User-Agent": MOOVIBE_USER_AGENT
  };
}
__name(lrclibHeaders, "lrclibHeaders");
__name2(lrclibHeaders, "lrclibHeaders");
function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}
__name(jsonResponse, "jsonResponse");
__name2(jsonResponse, "jsonResponse");
async function onRequestGet2(context) {
  const { request } = context;
  const url = new URL(request.url);
  const termo = (url.searchParams.get("q") || "").trim();
  if (!termo) return jsonResponse({ items: [] });
  try {
    await lrclibThrottle();
    const resp = await fetch(`${LRCLIB_SEARCH_URL}?q=${encodeURIComponent(termo)}`, { headers: lrclibHeaders() });
    if (!resp.ok) {
      const errorText = await resp.text().catch(() => "Unknown error");
      console.error(`[LRCLIB-SEARCH] Falhou com status ${resp.status}:`, errorText.substring(0, 300));
      return jsonResponse({ items: [] });
    }
    const dados = await resp.json();
    if (!Array.isArray(dados)) return jsonResponse({ items: [] });
    const porChave = /* @__PURE__ */ new Map();
    for (const item of dados) {
      if (!item || item.instrumental === true) continue;
      const trackName = item.trackName || item.track_name || "";
      const artistName = item.artistName || item.artist_name || "";
      if (!trackName) continue;
      const chave = `${trackName.toLowerCase()}|${artistName.toLowerCase()}`;
      if (!porChave.has(chave)) {
        porChave.set(chave, []);
      }
      porChave.get(chave).push(item);
    }
    const itens = [];
    for (const grupo of porChave.values()) {
      const comLetra = grupo.find((g) => g?.plainLyrics && g.plainLyrics.trim().length > 0) || grupo[0];
      itens.push({
        id: comLetra.id,
        trackName: comLetra.trackName || comLetra.track_name || "",
        artistName: comLetra.artistName || comLetra.artist_name || ""
      });
      if (itens.length >= 8) break;
    }
    console.log(`[LRCLIB-SEARCH] "${termo}" \u2192 ${itens.length} sugest\xF5es.`);
    return jsonResponse({ items: itens });
  } catch (err) {
    console.error("[LRCLIB-SEARCH] Erro:", err);
    return jsonResponse({ items: [] });
  }
}
__name(onRequestGet2, "onRequestGet2");
__name2(onRequestGet2, "onRequestGet");
var OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
var TMDB_BUSCA_URL = "https://api.themoviedb.org/3/search/movie";
var TMDB_BASE_URL = "https://api.themoviedb.org/3/movie";
var WIKIPEDIA_PT_API = "https://pt.wikipedia.org/api/rest_v1/page/summary/";
var WIKIPEDIA_EN_API = "https://en.wikipedia.org/api/rest_v1/page/summary/";
var GENIUS_BASE_URL = "https://api.genius.com";
var GENIUS_SEARCH_URL = `${GENIUS_BASE_URL}/search`;
var GENIUS_SONGS_URL = `${GENIUS_BASE_URL}/songs`;
var DUCKDUCKGO_URL = "https://api.duckduckgo.com/";
var MOOVIBE_VERSION2 = "1.0";
var MOOVIBE_USER_AGENT2 = `Moovibe/${MOOVIBE_VERSION2} (mailto:cesarbatistasantos08@gmail.com)`;
var OPENROUTER_MODEL = "openrouter/free";
var BROWSER_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
function jsonResponse2(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}
__name(jsonResponse2, "jsonResponse2");
__name2(jsonResponse2, "jsonResponse");
function slugify(texto) {
  if (!texto) return "";
  let slug = texto.toLowerCase();
  slug = slug.replace(/ & /g, " e ");
  slug = slug.replace(/ \/ /g, " ");
  slug = slug.replace(/[áàâãäå]/g, "a");
  slug = slug.replace(/[éèêë]/g, "e");
  slug = slug.replace(/[íìîï]/g, "i");
  slug = slug.replace(/[óòôõö]/g, "o");
  slug = slug.replace(/[úùûü]/g, "u");
  slug = slug.replace(/[ç]/g, "c");
  slug = slug.replace(/[ñ]/g, "n");
  slug = slug.replace(/[^a-z0-9\s-]/g, "");
  slug = slug.replace(/[\s]+/g, "-");
  slug = slug.replace(/-+/g, "-");
  slug = slug.replace(/^-+|-+$/g, "");
  return slug;
}
__name(slugify, "slugify");
__name2(slugify, "slugify");
function limparTermoMusica(termo) {
  if (!termo) return termo;
  let t = termo;
  t = t.replace(/\(\d{4}\)/g, "");
  t = t.replace(/\[\d{4}\]/g, "");
  t = t.replace(/\([^)]*(?:official|music\s*video|remaster|remastered|audio|lyric|video|visualizer|live|feat\.?|ft\.?|prod\.?|explicit|clean|edit|version|4k|hd|360|clip|single|lyrics|audio|official\s*audio)[^)]*\)/gi, "");
  t = t.replace(/\[[^\]]*(?:official|music\s*video|remaster|remastered|audio|lyric|video|visualizer|live|feat\.?|ft\.?|prod\.?|explicit|clean|edit|version|4k|hd|360|clip|single|lyrics|audio|official\s*audio)[^\]]*\]/gi, "");
  t = t.replace(/\s+(?:feat\.?|ft\.?)\..*$/i, "");
  t = t.replace(/\s+[\(\[].*?(?:feat\.?|ft\.?).*?[\)\]]/gi, "");
  return t.trim();
}
__name(limparTermoMusica, "limparTermoMusica");
__name2(limparTermoMusica, "limparTermoMusica");
function sanitizarTituloFilme(titulo) {
  if (!titulo || typeof titulo !== "string") return "";
  let t = titulo.trim();
  t = t.replace(/\s+(?:19|20)\d{2}\s*$/, "");
  t = t.replace(/\s*[\(\[]\s*(?:19|20)\d{2}\s*[\)\]]\s*$/, "");
  t = t.replace(/\s*[-–—]\s*(?:19|20)\d{2}\s*$/, "");
  return t.trim();
}
__name(sanitizarTituloFilme, "sanitizarTituloFilme");
__name2(sanitizarTituloFilme, "sanitizarTituloFilme");
function extrairJSON(texto) {
  if (!texto || typeof texto !== "string") return null;
  const Limpo = texto.replace(/```json/g, "").replace(/```/g, "").trim();
  const match2 = Limpo.match(/\{[\s\S]*\}/);
  if (match2) {
    try {
      return JSON.parse(match2[0]);
    } catch (e) {
      console.error("[OPENROUTER] Regex JSON parse falhou:", e);
    }
  }
  return null;
}
__name(extrairJSON, "extrairJSON");
__name2(extrairJSON, "extrairJSON");
function extrairQuotesDaLetra(letra, maxQuotes = 3) {
  if (!letra || typeof letra !== "string") return [];
  const linhas = letra.split("\n");
  const quotes = [];
  const estruturas = /^\[.*?\]$|^\(.*?\)$|^[A-Za-z\s]+:$|^---.*?---$/i;
  for (const linha of linhas) {
    const limpa = linha.trim();
    if (!limpa) continue;
    if (estruturas.test(limpa)) continue;
    if (limpa.length < 15 || limpa.length > 120) continue;
    quotes.push(limpa);
    if (quotes.length >= maxQuotes) break;
  }
  return quotes;
}
__name(extrairQuotesDaLetra, "extrairQuotesDaLetra");
__name2(extrairQuotesDaLetra, "extrairQuotesDaLetra");
function extrairDuasPrimeirasFrases(texto) {
  if (!texto) return "";
  const textoLimpo = texto.replace(/\s+/g, " ").trim();
  const frases = textoLimpo.split(/(?<=[.!?])\s+/).filter(Boolean);
  if (frases.length >= 2) return `${frases[0]} ${frases[1]}`;
  if (frases.length === 1) return frases[0];
  return textoLimpo.substring(0, 500);
}
__name(extrairDuasPrimeirasFrases, "extrairDuasPrimeirasFrases");
__name2(extrairDuasPrimeirasFrases, "extrairDuasPrimeirasFrases");
function validarContexto(texto, letra) {
  if (!texto || typeof texto !== "string") return false;
  if (!letra || typeof letra !== "string") return true;
  const trechoLetra = letra.replace(/\s+/g, " ").trim().substring(0, 180);
  const trechoContexto = texto.replace(/\s+/g, " ").trim().substring(0, 180);
  if (trechoContexto === trechoLetra) return false;
  if (/\b(lyrics|letra)\b/i.test(texto)) return false;
  if (/\[.*?\]|\(.*?\)/.test(texto)) return false;
  return true;
}
__name(validarContexto, "validarContexto");
__name2(validarContexto, "validarContexto");
function extrairDiretorWikipedia(extract) {
  if (!extract) return "Dispon\xEDvel na Wikip\xE9dia";
  const matchPT = extract.match(/(?:dirigido\s+por|dire[cç][aã]o\s+(?:de\s+)?|diretor[:\s]+)\s+([A-ZÀ-Ú][A-Za-zÀ-Ú0-9'\-\s]+?)(?=(?:,|\.|\s+e\s+|\s+\(|\s*$))/i);
  if (matchPT) {
    let nome = matchPT[1].trim();
    nome = nome.replace(/\s+e\s+.*$/, "").trim();
    if (nome.length > 2) return nome;
  }
  const matchEN = extract.match(/(?:directed\s+by|director[:\s]+)\s+([A-Z][A-Za-z0-9'\-\s]+?)(?=(?:,|\.|\s+and\s+|\s+\(|\s*$))/i);
  if (matchEN) {
    let nome = matchEN[1].trim();
    nome = nome.replace(/\s+and\s+.*$/, "").trim();
    if (nome.length > 2) return nome;
  }
  return "Dispon\xEDvel na Wikip\xE9dia";
}
__name(extrairDiretorWikipedia, "extrairDiretorWikipedia");
__name2(extrairDiretorWikipedia, "extrairDiretorWikipedia");
async function buscarBrave(query, origem = "") {
  try {
    const url = `https://search.brave.com/search?q=${encodeURIComponent(query)}`;
    const resp = await fetch(url, {
      headers: {
        "User-Agent": BROWSER_USER_AGENT
      }
    });
    if (!resp.ok) {
      const errorText = await resp.text().catch(() => "Unknown error");
      console.error(`[BRAVE] Falhou com status ${resp.status}:`, errorText.substring(0, 300));
      return null;
    }
    const html = await resp.text();
    let texto = html.replace(/<script[^>]*>.*?<\/script>/gis, "");
    texto = texto.replace(/<style[^>]*>.*?<\/style>/gis, "");
    texto = texto.replace(/<[^>]+>/g, "");
    texto = texto.replace(/\s+/g, " ").trim();
    texto = texto.substring(0, 5e3);
    const marcadoresResiduais = [
      "@font-face",
      "usestrict",
      "cdn.search.brave.com",
      "_app/immutable",
      'format("woff2',
      "unicode-range:"
    ];
    const temMarcadorResidual = marcadoresResiduais.some((m) => texto.includes(m));
    const densidadeCaracteres = (texto.match(/[{};]/g) || []).length / Math.max(1, texto.length);
    if (texto && (temMarcadorResidual || densidadeCaracteres > 0.05)) {
      console.warn("[BRAVE] Texto rejeitado: ainda cont\xE9m markup residual");
      return null;
    }
    if (texto) {
      const rotulo = origem ? ` (origem=${origem})` : "";
      console.log(`[BRAVE] OK!${rotulo} ${texto.length} chars obtidos.`);
      return texto;
    }
    return null;
  } catch (err) {
    console.error("[BRAVE] Erro:", err);
    return null;
  }
}
__name(buscarBrave, "buscarBrave");
__name2(buscarBrave, "buscarBrave");
async function buscarLetraPorIdLrclib(id) {
  if (!id) return null;
  console.log("[LETRA] CAMADA 0: LRCLIB /api/get/{id}...");
  try {
    await lrclibThrottle();
    const resp = await fetch(`${LRCLIB_URL}/get/${encodeURIComponent(id)}`, { headers: lrclibHeaders() });
    if (resp.status === 429) {
      const retryAfter = parseInt(resp.headers.get("Retry-After") || "2", 10);
      console.log(`[LETRA] LRCLIB /api/get/{id} rate limited. Aguardando ${retryAfter}s...`);
      await new Promise((resolve) => setTimeout(resolve, retryAfter * 1e3));
      const retryResp = await fetch(`${LRCLIB_URL}/get/${encodeURIComponent(id)}`, { headers: lrclibHeaders() });
      if (retryResp.ok) {
        const data = await retryResp.json();
        if (data?.plainLyrics) {
          console.log("[LETRA] LRCLIB /api/get/{id}: Letra encontrada (apos retry)!");
          return data.plainLyrics.substring(0, 5e3);
        }
      }
    } else if (resp.ok) {
      const data = await resp.json();
      if (data?.plainLyrics) {
        console.log("[LETRA] LRCLIB /api/get/{id}: Letra encontrada!");
        return data.plainLyrics.substring(0, 5e3);
      }
    }
  } catch (err) {
    console.error("[LETRA] LRCLIB /api/get/{id} erro:", err);
  }
  return null;
}
__name(buscarLetraPorIdLrclib, "buscarLetraPorIdLrclib");
__name2(buscarLetraPorIdLrclib, "buscarLetraPorIdLrclib");
async function buscarLetraMusica(nomeMusica, artista, env, lrclibId = null) {
  const nomeLimpo = limparTermoMusica(nomeMusica);
  const artistaLimpo = limparTermoMusica(artista) || artista;
  if (lrclibId) {
    const letraPorId = await buscarLetraPorIdLrclib(lrclibId);
    if (letraPorId) return letraPorId;
    console.log("[LETRA] CAMADA 0 falhou, seguindo para as demais camadas...");
  }
  console.log("[LETRA] CAMADA 1: LRCLIB /api/get...");
  try {
    await lrclibThrottle();
    const params = new URLSearchParams({ track_name: nomeLimpo, artist_name: artistaLimpo });
    const resp = await fetch(`${LRCLIB_GET_URL}?${params}`, { headers: lrclibHeaders() });
    if (resp.status === 429) {
      const retryAfter = parseInt(resp.headers.get("Retry-After") || "2", 10);
      console.log(`[LETRA] LRCLIB rate limited. Aguardando ${retryAfter}s...`);
      await new Promise((resolve) => setTimeout(resolve, retryAfter * 1e3));
      const retryResp = await fetch(`${LRCLIB_GET_URL}?${params}`, { headers: lrclibHeaders() });
      if (retryResp.ok) {
        const data = await retryResp.json();
        if (data?.plainLyrics) {
          console.log("[LETRA] LRCLIB /api/get: Letra encontrada (apos retry)!");
          return data.plainLyrics.substring(0, 5e3);
        }
      }
    } else if (resp.ok) {
      const data = await resp.json();
      if (data?.plainLyrics) {
        console.log("[LETRA] LRCLIB /api/get: Letra encontrada!");
        return data.plainLyrics.substring(0, 5e3);
      }
    }
  } catch (err) {
    console.error("[LETRA] LRCLIB /api/get erro:", err);
  }
  console.log("[LETRA] CAMADA 1b: LRCLIB /api/search (fallback)...");
  try {
    await lrclibThrottle();
    const paramsSearch = new URLSearchParams({ track_name: nomeLimpo, artist_name: artistaLimpo });
    const respSearch = await fetch(`${LRCLIB_SEARCH_URL}?${paramsSearch}`, { headers: lrclibHeaders() });
    if (respSearch.status === 429) {
      const retryAfter = parseInt(respSearch.headers.get("Retry-After") || "2", 10);
      console.log(`[LETRA] LRCLIB search rate limited. Aguardando ${retryAfter}s...`);
      await new Promise((resolve) => setTimeout(resolve, retryAfter * 1e3));
      const retryResp = await fetch(`${LRCLIB_SEARCH_URL}?${paramsSearch}`, { headers: lrclibHeaders() });
      if (retryResp.ok) {
        const dados = await retryResp.json();
        const comLetra = Array.isArray(dados) ? dados.find((item) => item?.plainLyrics && item.plainLyrics.trim().length > 0) : null;
        if (comLetra) {
          console.log("[LETRA] LRCLIB /api/search: Letra encontrada (apos retry)!");
          return comLetra.plainLyrics.substring(0, 5e3);
        }
      }
    } else if (respSearch.ok) {
      const dados = await respSearch.json();
      const comLetra = Array.isArray(dados) ? dados.find((item) => item?.plainLyrics && item.plainLyrics.trim().length > 0) : null;
      if (comLetra) {
        console.log("[LETRA] LRCLIB /api/search: Letra encontrada!");
        return comLetra.plainLyrics.substring(0, 5e3);
      }
    }
  } catch (err) {
    console.error("[LETRA] LRCLIB /api/search erro:", err);
  }
  console.log("[LETRA] CAMADA 2: Genius...");
  const geniusKey = env?.GENIUS_API_KEY;
  if (geniusKey) {
    try {
      const query = encodeURIComponent(`${nomeLimpo} ${artistaLimpo}`);
      const resp = await fetch(`https://api.genius.com/search?q=${query}`, {
        headers: { Authorization: `Bearer ${geniusKey}`, "User-Agent": MOOVIBE_USER_AGENT2 }
      });
      if (!resp.ok) {
        const errorText = await resp.text().catch(() => "Unknown error");
        console.error(`[GENIUS] Falhou com status ${resp.status}:`, errorText.substring(0, 300));
        return null;
      }
      const dados = await resp.json();
      const hit = dados?.response?.hits?.[0]?.result;
      if (hit?.url) {
        const pageResp = await fetch(hit.url, { headers: { "User-Agent": MOOVIBE_USER_AGENT2 } });
        if (!pageResp.ok) {
          const errorText = await pageResp.text().catch(() => "Unknown error");
          console.error(`[GENIUS] P\xE1gina falhou com status ${pageResp.status}:`, errorText.substring(0, 300));
          return null;
        }
        const html = await pageResp.text();
        const containersLyrics = html.match(/<div[^>]*data-lyrics-container="true"[^>]*>[\s\S]*?<\/div>/gi) || [];
        if (containersLyrics.length > 0) {
          const letraGeniusConcatenada = containersLyrics.join(" ");
          console.log(`[LETRA] Genius: Letra encontrada (${containersLyrics.length} container(s))!`);
          return limparHTML(letraGeniusConcatenada).substring(0, 5e3);
        }
        const lyricsMatch = html.match(/<div[^>]*class="lyrics"[^>]*>([\s\S]*?)<\/div>/i);
        if (lyricsMatch) {
          console.log('[LETRA] Genius: Letra encontrada (seletor legado class="lyrics")!');
          return limparHTML(lyricsMatch[1]).substring(0, 5e3);
        }
      }
    } catch (err) {
      console.error("[LETRA] Genius erro:", err);
    }
  }
  console.log("[LETRA] CAMADA 3: Brave Search...");
  const letraBrave = await buscarBrave(`${nomeLimpo} ${artistaLimpo} lyrics`, "LETRA");
  if (letraBrave) {
    console.log("[LETRA] Brave Search: Letra encontrada!");
    return letraBrave.substring(0, 5e3);
  }
  console.log("[LETRA] Todas as camadas falharam.");
  return "";
}
__name(buscarLetraMusica, "buscarLetraMusica");
__name2(buscarLetraMusica, "buscarLetraMusica");
function extrairTextoGeniusDOM(no) {
  if (no === null || no === void 0) return "";
  if (typeof no === "string") return no;
  if (Array.isArray(no)) return no.map(extrairTextoGeniusDOM).join("");
  if (typeof no === "object") {
    if (no.children) return no.children.map(extrairTextoGeniusDOM).join("");
    if (no.text) return String(no.text);
    return "";
  }
  return "";
}
__name(extrairTextoGeniusDOM, "extrairTextoGeniusDOM");
__name2(extrairTextoGeniusDOM, "extrairTextoGeniusDOM");
async function buscarDuckDuckGo(query) {
  try {
    const url = `${DUCKDUCKGO_URL}?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
    const resp = await fetch(url, { headers: { "User-Agent": MOOVIBE_USER_AGENT2 } });
    if (!resp.ok) {
      const errorText = await resp.text().catch(() => "Unknown error");
      console.error(`[DUCKDUCKGO] Falhou com status ${resp.status}:`, errorText.substring(0, 300));
      return null;
    }
    const dados = await resp.json();
    let texto = dados?.AbstractText || "";
    if (!texto) texto = dados?.Answer || "";
    if (!texto) {
      console.log("[DUCKDUCKGO] Sem resultado (AbstractText e Answer vazios).");
      return null;
    }
    texto = texto.replace(/\s+/g, " ").trim();
    console.log(`[DUCKDUCKGO] OK! ${texto.length} chars obtidos.`);
    return texto.substring(0, 2e3);
  } catch (err) {
    console.error("[DUCKDUCKGO] Erro:", err);
    return null;
  }
}
__name(buscarDuckDuckGo, "buscarDuckDuckGo");
__name2(buscarDuckDuckGo, "buscarDuckDuckGo");
async function buscarContextoMusica(nomeMusica, artista, env, letra, lang = "en") {
  const nomeLimpo = limparTermoMusica(nomeMusica);
  const artistaLimpo = limparTermoMusica(artista) || artista;
  const termoBusca = `${nomeLimpo} ${artistaLimpo}`;
  console.log("[CONTEXTO] CAMADA 1: Genius (descricao via /songs/{id})...");
  if (env.GENIUS_API_KEY) {
    try {
      const query = encodeURIComponent(`${nomeLimpo} ${artistaLimpo}`);
      const resp = await fetch(`${GENIUS_SEARCH_URL}?q=${query}`, {
        headers: { Authorization: `Bearer ${env.GENIUS_API_KEY}`, "User-Agent": MOOVIBE_USER_AGENT2 }
      });
      if (!resp.ok) {
        const errorText = await resp.text().catch(() => "Unknown error");
        console.error(`[GENIUS] Falhou com status ${resp.status}:`, errorText.substring(0, 300));
      } else {
        const dados = await resp.json();
        const hit = dados?.response?.hits?.[0]?.result;
        if (hit?.id) {
          console.log(`[CONTEXTO] Genius: song id = ${hit.id}`);
          const songResp = await fetch(`${GENIUS_SONGS_URL}/${hit.id}`, {
            headers: { Authorization: `Bearer ${env.GENIUS_API_KEY}`, "User-Agent": MOOVIBE_USER_AGENT2 }
          });
          if (!songResp.ok) {
            const errorText = await songResp.text().catch(() => "Unknown error");
            console.error(`[GENIUS] /songs falhou com status ${songResp.status}:`, errorText.substring(0, 300));
          } else {
            const songData = await songResp.json();
            const descDom = songData?.response?.song?.description?.dom;
            if (descDom) {
              const textoDesc = extrairTextoGeniusDOM(descDom).replace(/\s+/g, " ").trim();
              if (textoDesc && textoDesc.length >= 30 && textoDesc.trim() !== "?") {
                console.log("[CONTEXTO] FONTE=GENIUS");
                console.log("[CONTEXTO] Genius: Descricao oficial encontrada!");
                return textoDesc.substring(0, 2e3);
              } else {
                console.log("[CONTEXTO] Genius: descricao vazia/placeholder, seguindo para pr\xF3xima camada.");
              }
            } else {
              console.log("[CONTEXTO] Genius: description.dom vazio/ausente, seguindo para pr\xF3xima camada.");
            }
          }
        }
      }
    } catch (err) {
      console.error("[CONTEXTO] Genius erro:", err);
    }
  }
  console.log("[CONTEXTO] CAMADA 2: DuckDuckGo Instant Answer...");
  const ctxDdg = await buscarDuckDuckGo(`${nomeLimpo} ${artistaLimpo} song meaning`);
  if (ctxDdg) {
    console.log("[CONTEXTO] FONTE=DUCKDUCKGO");
    console.log("[CONTEXTO] DuckDuckGo: Contexto encontrado!");
    return ctxDdg.substring(0, 2e3);
  }
  console.log("[CONTEXTO] CAMADA 3: Wikipedia...");
  const wikiApiCtx = lang === "pt" ? WIKIPEDIA_PT_API : WIKIPEDIA_EN_API;
  try {
    const url = `${wikiApiCtx}${encodeURIComponent(termoBusca)}`;
    const resp = await fetch(url, { headers: { "User-Agent": MOOVIBE_USER_AGENT2 } });
    if (!resp.ok) {
      const errorText = await resp.text().catch(() => "Unknown error");
      console.error(`[WIKIPEDIA] Falhou com status ${resp.status}:`, errorText.substring(0, 300));
    } else {
      const dados = await resp.json();
      if (dados.type !== "disambiguation" && dados.extract) {
        console.log("[CONTEXTO] FONTE=WIKIPEDIA");
        console.log("[CONTEXTO] Wikipedia: Contexto encontrado!");
        return dados.extract.substring(0, 2e3);
      }
    }
  } catch (err) {
    console.error("[CONTEXTO] Wikipedia erro:", err);
  }
  console.log("[CONTEXTO] CAMADA 4: Brave Search...");
  const ctxBrave = await buscarBrave(`significado da musica ${nomeLimpo} ${artistaLimpo}`, "CONTEXTO");
  if (ctxBrave && validarContexto(ctxBrave, letra)) {
    console.log("[CONTEXTO] FONTE=BRAVE");
    console.log("[CONTEXTO] Brave Search: Contexto encontrado!");
    return ctxBrave.substring(0, 2e3);
  }
  console.log("[CONTEXTO] CAMADA 5: OpenRouter (mini-IA)...");
  if (env.OPENROUTER_API_KEY) {
    try {
      const idiomaPrompt = lang === "pt" ? "em portugu\xEAs" : "in English";
      const prompt = `Pesquise na web a hist\xF3ria real, inspira\xE7\xE3o e o significado da m\xFAsica '${nomeLimpo}' de '${artistaLimpo}'. Retorne apenas um par\xE1grafo curto ${idiomaPrompt} explicando o contexto.`;
      const payload = {
        model: OPENROUTER_MODEL,
        temperature: 0.3,
        max_tokens: 300,
        messages: [{ role: "user", content: prompt }]
      };
      console.log("\n[DEBUG] Enviando Payload para OpenRouter (CONTEXTO):", JSON.stringify(payload, null, 2));
      console.log(`[CONTEXTO] Tentando modelo: ${OPENROUTER_MODEL}...`);
      const resp = await fetch(OPENROUTER_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "https://moovibe.pages.dev",
          "X-Title": "Moovibe"
        },
        body: JSON.stringify(payload)
      });
      if (!resp.ok) {
        const errorText = await resp.text().catch(() => "Unknown error");
        console.error(`[OPENROUTER CONTEXTO] Falhou com status ${resp.status}:`, errorText.substring(0, 300));
      } else {
        const dados = await resp.json();
        const aiContent = dados?.choices?.[0]?.message?.content;
        if (!aiContent) {
          console.error("[OPENROUTER CONTEXTO] OpenRouter n\xE3o retornou escolhas v\xE1lidas.");
        } else {
          const texto = aiContent.trim();
          console.log(`[CONTEXTO] Resposta Bruta: ${texto.substring(0, 300)}...`);
          if (texto && validarContexto(texto, letra)) {
            console.log("[CONTEXTO] FONTE=IA");
            console.log("[CONTEXTO] OpenRouter: Contexto gerado via IA!");
            return texto.substring(0, 2e3);
          }
        }
      }
    } catch (err) {
      console.error("[CONTEXTO] OpenRouter erro:", err);
    }
  }
  console.log("[CONTEXTO] Todas as camadas falharam.");
  return null;
}
__name(buscarContextoMusica, "buscarContextoMusica");
__name2(buscarContextoMusica, "buscarContextoMusica");
async function buscarCapaMusica(nomeMusica, artista) {
  try {
    const query = encodeURIComponent(`${nomeMusica} ${artista}`);
    const url = `https://itunes.apple.com/search?term=${query}&entity=song&limit=1`;
    const resp = await fetch(url, {
      headers: { "User-Agent": MOOVIBE_USER_AGENT2 }
    });
    if (!resp.ok) {
      const errorText = await resp.text().catch(() => "Unknown error");
      console.error(`[APPLE MUSIC] Falhou com status ${resp.status}:`, errorText.substring(0, 300));
      return { coverUrl: null, previewUrl: null };
    }
    const dados = await resp.json();
    const track = dados?.results?.[0];
    let coverUrl = null;
    if (track?.artworkUrl100) coverUrl = track.artworkUrl100.replace("100x100bb", "1000x1000bb");
    const previewUrl = track?.previewUrl || null;
    return { coverUrl, previewUrl };
  } catch (err) {
    console.error("[APPLE MUSIC] Erro:", err);
    return { coverUrl: null, previewUrl: null };
  }
}
__name(buscarCapaMusica, "buscarCapaMusica");
__name2(buscarCapaMusica, "buscarCapaMusica");
async function obterCacheMusica(nomeMusica, artista, env) {
  try {
    const kv = env.MOOVIBE_DB;
    if (!kv) return null;
    const key = `cache:${slugify(nomeMusica)}:${slugify(artista || "")}`;
    const cached = await kv.get(key, "json");
    if (cached) {
      console.log(`[CACHE] Cache encontrado para chave: ${key}`);
      return cached;
    }
    return null;
  } catch (err) {
    console.error("[CACHE] Falha ao ler cache:", err);
    return null;
  }
}
__name(obterCacheMusica, "obterCacheMusica");
__name2(obterCacheMusica, "obterCacheMusica");
async function gravarCacheMusica(nomeMusica, artista, letra, contextoExtra, env) {
  try {
    const kv = env.MOOVIBE_DB;
    if (!kv) return;
    const key = `cache:${slugify(nomeMusica)}:${slugify(artista || "")}`;
    const payload = { letra, contexto: contextoExtra };
    await kv.put(key, JSON.stringify(payload), { expirationTtl: 60 * 60 * 24 * 30 });
    console.log(`[CACHE] Cache gravado para chave: ${key}`);
  } catch (err) {
    console.error("[CACHE] Falha ao gravar cache:", err);
  }
}
__name(gravarCacheMusica, "gravarCacheMusica");
__name2(gravarCacheMusica, "gravarCacheMusica");
async function obterRecomendacaoIA(nomeMusica, artista, letra, contextoExtra, apiKey, filmesExcluidosGlobais = [], filmesExcluidosMusica = [], lang = "en") {
  if (!apiKey) return null;
  let regraGlobal = "";
  if (Array.isArray(filmesExcluidosGlobais) && filmesExcluidosGlobais.length > 0) {
    regraGlobal = `REGRA DE DIVERSIFICA\xC7\xC3O GLOBAL: N\xC3O recomende nenhum destes filmes sob nenhuma hip\xF3tese: ${filmesExcluidosGlobais.join(", ")}.

`;
  }
  let regraEspecifica = "";
  if (Array.isArray(filmesExcluidosMusica) && filmesExcluidosMusica.length > 0) {
    regraEspecifica = `REGRA ESPEC\xCDFICA DA M\xDASICA: Para esta m\xFAsica espec\xEDfica, os seguintes filmes j\xE1 foram recomendados recentemente e est\xE3o PROIBIDOS de serem repetidos: ${filmesExcluidosMusica.join(", ")}. Escolha algo novo.

`;
  }
  const idiomaJustificativa = lang === "pt" ? "em portugu\xEAs, at\xE9 4 frases" : "in English, up to 4 sentences";
  const promptSistema = `Voce e um curador de cinema genial. O usuario vai te passar uma musica e voce deve sugerir EXATAMENTE UM filme que compartilhe exatamente da mesma atmosfera emocional, paleta de cores subtendida, ritmo psicologico ou alma lirica dessa musica. Nao se limite a conexoes obvias. Pense na vibe.

${regraGlobal}${regraEspecifica}CRITICO: Voce DEVE sugerir um filme REAL existente no banco de dados do TMDb. PROIBIDO inventar titulos de filmes. Use APENAS o titulo original ou oficial em ingles/portugues. NAO use caracteres asiaticos (como chines, japones, coreano) a menos que seja um filme autenticamente asiatico com titulo original nesses caracteres. Se nao tiver certeza, escolha um filme classico e bem conhecido.

REGRA ABSOLUTA: No campo 'filme', retorne APENAS o nome comercial puro do filme (em ingles ou portugues). E terminantemente PROIBIDO embutir o ano ao lado do nome do filme nesse campo. Por exemplo, retorne 'The Great Gatsby' e NUNCA 'The Great Gatsby 2013'. O ano de lancamento deve habitar estritamente e apenas o campo 'ano' do JSON.

TAREFA EXTRA: Usando a letra da musica fornecida, extraia 3 trechos curtos (cada um entre 15 e 80 caracteres) que melhor capturem a vibe e a conexao emocional com o filme sugerido. Retorne esses trechos no campo 'citacoes' como um array de 3 strings.

Sua resposta DEVE ser estritamente um formato JSON valido (sem qualquer tipo de formatacao markdown, apenas as chaves brutas). O JSON deve conter as seguintes chaves exatas:
{
  "filme": "Nome exato do filme (de preferencia o titulo original em ingles ou o mais conhecido, SEM o ano)",
  "ano": "Ano de lancamento do filme sugerido (Apenas os 4 digitos numericos, ex: 2002)",
  "justificativa": "Uma explicacao poetica, profunda e envolvente (${idiomaJustificativa}) conectando sentimentos da musica/letra com o filme.",
  "citacoes": ["Trecho 1 da letra que conecta com o filme", "Trecho 2 da letra que conecta com o filme", "Trecho 3 da letra que conecta com o filme"],
  "vibe_title": "Um titulo CURTO e impactante em MAIUSCULAS (2-3 palavras) que capture a vibe, ex: 'OPERATIC CHAOS' ou 'MELANCHOLIC DREAM'",
  "tags": ["Array de 4 tags em MAIUSCULAS descrevendo a vibe, ex: GRANDIOSE, TRAGICOMIC, CATHARTIC, MOSAIC"]
}`;
  let conteudoUsuario = `Musica: '${nomeMusica}' do artista '${artista}'.
`;
  if (letra) {
    conteudoUsuario += `Use a letra da musica para capturar a essencia poetica profunda:
${letra}

`;
  } else {
    conteudoUsuario += "(Nao encontramos a letra no banco de dados, baseie-se no tema geral da musica).\nComo nao temos a letra, gere 3 citacoes genericas sobre cinema ou inspiracao que combinem com o filme.\n\n";
  }
  if (contextoExtra) {
    conteudoUsuario += `Contexto historico, significado e fatos adicionais sobre a musica para te ajudar na escolha:
${contextoExtra}
`;
  }
  try {
    const body = {
      model: OPENROUTER_MODEL,
      temperature: 0.3,
      max_tokens: 2e3,
      reasoning: { effort: "low", exclude: true },
      messages: [
        { role: "system", content: promptSistema },
        { role: "user", content: conteudoUsuario }
      ]
    };
    console.log("\n[DEBUG] Enviando Payload para OpenRouter (RECOMENDACAO):", JSON.stringify(body, null, 2));
    console.log(`[OPENROUTER] Tentando modelo: ${OPENROUTER_MODEL}`);
    let resp = await fetch(OPENROUTER_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://moovibe.pages.dev",
        "X-Title": "Moovibe"
      },
      body: JSON.stringify(body)
    });
    if (resp.status === 400) {
      const errorText = await resp.text().catch(() => "");
      if (errorText.toLowerCase().includes("reasoning")) {
        console.log("[OPENROUTER] Modelo rejeitou parametro reasoning, tentando sem ele...");
        const { reasoning, ...bodySemReasoning } = body;
        console.log("[DEBUG] Payload sem reasoning:", JSON.stringify(bodySemReasoning, null, 2));
        resp = await fetch(OPENROUTER_URL, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
            "HTTP-Referer": "https://moovibe.pages.dev",
            "X-Title": "Moovibe"
          },
          body: JSON.stringify(bodySemReasoning)
        });
      }
    }
    if (!resp.ok) {
      const errorText = await resp.text().catch(() => "Unknown error");
      console.error(`[OPENROUTER RECOMENDACAO] Falhou com status ${resp.status}:`, errorText.substring(0, 300));
      if (resp.status === 429) {
        return { _errorCode: "RATE_LIMITED" };
      }
      return { _errorCode: "AI_UNAVAILABLE" };
    }
    const dados = await resp.json();
    const aiContent = dados?.choices?.[0]?.message?.content;
    if (!aiContent) {
      console.error("[OPENROUTER RECOMENDACAO] OpenRouter n\xE3o retornou escolhas v\xE1lidas. Payload:", JSON.stringify(dados).substring(0, 500));
      return { _errorCode: "AI_UNAVAILABLE" };
    }
    let textoIA = aiContent.trim();
    console.log(`[OPENROUTER] Resposta Bruta:
${textoIA}
`);
    if (!textoIA) return null;
    textoIA = textoIA.replace(/```json/g, "").replace(/```/g, "").trim();
    const isSafety = /User Safety/i.test(textoIA);
    if (!isSafety) {
      const parsed = extrairJSON(textoIA);
      if (parsed && typeof parsed === "object" && parsed.filme) {
        parsed.filme = sanitizarTituloFilme(parsed.filme || parsed.filme_sugerido || "");
        if (!parsed.citacoes || !Array.isArray(parsed.citacoes) || parsed.citacoes.length < 3) {
          const quotes = extrairQuotesDaLetra(letra, 3);
          parsed.citacoes = quotes.length >= 3 ? quotes : [];
        }
        return parsed;
      }
    }
    if (isSafety) {
      for (let tentativa = 1; tentativa <= 2; tentativa++) {
        console.log(`[OPENROUTER] Resposta de seguranca detectada, tentando novamente (tentativa ${tentativa}/3)...`);
        await new Promise((r) => setTimeout(r, 1500 * tentativa));
        try {
          const respRetry = await fetch(OPENROUTER_URL, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${apiKey}`,
              "Content-Type": "application/json",
              "HTTP-Referer": "https://moovibe.pages.dev",
              "X-Title": "Moovibe"
            },
            body: JSON.stringify(body)
          });
          if (!respRetry.ok) continue;
          const dadosRetry = await respRetry.json();
          const textoRetry = (dadosRetry?.choices?.[0]?.message?.content || "").trim();
          if (!textoRetry) continue;
          const textoRetryLimpo = textoRetry.replace(/```json/g, "").replace(/```/g, "").trim();
          const parsedRetry = extrairJSON(textoRetryLimpo);
          if (parsedRetry && typeof parsedRetry === "object" && parsedRetry.filme) {
            console.log("=== [DEBUG] JSON EXTRAIDO COM SUCESSO (RETRY) ===");
            console.log(JSON.stringify(parsedRetry, null, 2));
            parsedRetry.filme = sanitizarTituloFilme(parsedRetry.filme || parsedRetry.filme_sugerido || "");
            if (!parsedRetry.citacoes || !Array.isArray(parsedRetry.citacoes) || parsedRetry.citacoes.length < 3) {
              const quotes = extrairQuotesDaLetra(letra, 3);
              parsedRetry.citacoes = quotes.length >= 3 ? quotes : [];
            }
            return parsedRetry;
          }
        } catch (err) {
          console.error("[OPENROUTER] Erro no retry:", err);
          continue;
        }
      }
    }
    console.error("[OPENROUTER] Nenhum JSON encontrado na resposta.");
    return { _errorCode: "AI_UNAVAILABLE" };
  } catch (err) {
    console.error("[OPENROUTER] Erro na requisicao:", err);
    return { _errorCode: "AI_UNAVAILABLE" };
  }
}
__name(obterRecomendacaoIA, "obterRecomendacaoIA");
__name2(obterRecomendacaoIA, "obterRecomendacaoIA");
async function obterDetalhesTMDB(nomeFilme, apiKey, ano, lang = "en") {
  if (!apiKey) return null;
  try {
    const tmdbLang = lang === "pt" ? "pt-BR" : "en-US";
    const paramsBusca = new URLSearchParams({ api_key: apiKey, query: nomeFilme, language: tmdbLang });
    if (ano) paramsBusca.set("primary_release_year", ano);
    const respBusca = await fetch(`${TMDB_BUSCA_URL}?${paramsBusca}`, { headers: { "User-Agent": MOOVIBE_USER_AGENT2 } });
    if (!respBusca.ok) {
      const errorText = await respBusca.text().catch(() => "Unknown error");
      console.error(`[TMDB] Busca falhou com status ${respBusca.status}:`, errorText.substring(0, 300));
      return null;
    }
    const dadosBusca = await respBusca.json();
    const filmes = dadosBusca?.results;
    if (!filmes || filmes.length === 0) return null;
    const filmeBasico = filmes[0];
    const filmeId = filmeBasico.id;
    const paramsDetalhes = new URLSearchParams({ api_key: apiKey, language: tmdbLang });
    const respDetalhes = await fetch(`${TMDB_BASE_URL}/${filmeId}?${paramsDetalhes}`, { headers: { "User-Agent": MOOVIBE_USER_AGENT2 } });
    const detalhes = respDetalhes.ok ? await respDetalhes.json() : {};
    let diretor = "Nao encontrado";
    const respCreditos = await fetch(`${TMDB_BASE_URL}/${filmeId}/credits?api_key=${apiKey}&language=${tmdbLang}`, { headers: { "User-Agent": MOOVIBE_USER_AGENT2 } });
    if (respCreditos.ok) {
      const creditos = await respCreditos.json();
      for (const pessoa of creditos?.crew || []) {
        if (pessoa.job === "Director") {
          diretor = pessoa.name;
          break;
        }
      }
    }
    const respImagens = await fetch(`${TMDB_BASE_URL}/${filmeId}/images?api_key=${apiKey}&include_image_language=en,null`, { headers: { "User-Agent": MOOVIBE_USER_AGENT2 } });
    const cenas = [];
    let posterUrl = null;
    if (respImagens.ok) {
      const imagens = await respImagens.json();
      for (const backdrop of (imagens?.backdrops || []).slice(0, 15)) {
        if (backdrop.file_path) cenas.push(`https://image.tmdb.org/t/p/w780${backdrop.file_path}`);
      }
      const posters = imagens?.posters || [];
      for (const poster of posters) {
        if (!poster.file_path) continue;
        const idioma = (poster.iso_639_1 || "").toLowerCase();
        if (idioma === "en" || idioma === "") {
          posterUrl = `https://image.tmdb.org/t/p/w500${poster.file_path}`;
          break;
        }
      }
    }
    if (!posterUrl && filmeBasico.poster_path) posterUrl = `https://image.tmdb.org/t/p/w500${filmeBasico.poster_path}`;
    const tagline = detalhes && typeof detalhes === "object" && detalhes.tagline ? detalhes.tagline.trim() : "";
    return {
      id_tmdb: filmeId,
      titulo_pt: filmeBasico.title,
      titulo_original: filmeBasico.original_title,
      ano: (filmeBasico.release_date || "----").substring(0, 4),
      sinopse: filmeBasico.overview || "Sem sinopse disponivel.",
      poster: posterUrl,
      diretor,
      imdb_id: detalhes?.imdb_id || null,
      cenas,
      tagline
    };
  } catch (err) {
    console.error("[TMDB] Erro:", err);
    return null;
  }
}
__name(obterDetalhesTMDB, "obterDetalhesTMDB");
__name2(obterDetalhesTMDB, "obterDetalhesTMDB");
async function buscarDadosFilmeFallback(nomeFilme, ano, env, lang = "en") {
  const wikiApi = lang === "pt" ? WIKIPEDIA_PT_API : WIKIPEDIA_EN_API;
  const wikiLabel = lang === "pt" ? "Wikipedia PT" : "Wikipedia EN";
  console.log(`[FILME FALLBACK] CAMADA 1: ${wikiLabel}...`);
  try {
    const termos = [];
    if (ano) {
      termos.push(`${nomeFilme} (${ano}) filme`);
      termos.push(`${nomeFilme} ${ano} filme`);
    }
    termos.push(`${nomeFilme} filme`);
    termos.push(nomeFilme);
    for (const termo of termos) {
      const url = `${wikiApi}${encodeURIComponent(termo)}`;
      const resp = await fetch(url, { headers: { "User-Agent": MOOVIBE_USER_AGENT2 } });
      if (!resp.ok) {
        const errorText = await resp.text().catch(() => "Unknown error");
        console.error(`[WIKIPEDIA] Falhou com status ${resp.status}:`, errorText.substring(0, 300));
        continue;
      }
      const dados = await resp.json();
      if (dados.type === "disambiguation") continue;
      if (dados.extract) {
        const sinopse = extrairDuasPrimeirasFrases(dados.extract);
        const diretor = extrairDiretorWikipedia(dados.extract);
        let posterUrl = null;
        if (dados.originalimage && dados.originalimage.source) posterUrl = dados.originalimage.source;
        console.log("[FILME FALLBACK] Wikipedia: Dados encontrados!");
        return { sinopse: sinopse.substring(0, 2e3), diretor, poster: posterUrl };
      }
    }
  } catch (err) {
    console.error("[FILME FALLBACK] Wikipedia erro:", err);
  }
  console.log("[FILME FALLBACK] CAMADA 2: Brave Search...");
  try {
    let query = lang === "pt" ? `${nomeFilme} filme enredo sinopse` : `${nomeFilme} movie plot synopsis`;
    if (ano) query = `${nomeFilme} ${ano} ${lang === "pt" ? "filme enredo" : "movie plot synopsis"}`;
    const resultado = await buscarBrave(query);
    if (resultado) {
      console.log("[FILME FALLBACK] Brave Search: Dados encontrados!");
      return { sinopse: resultado.substring(0, 2e3), diretor: "Dispon\xEDvel na Web", poster: null };
    }
  } catch (err) {
    console.error("[FILME FALLBACK] Brave Search erro:", err);
  }
  console.log("[FILME FALLBACK] CAMADA 3: OpenRouter (fallback final)...");
  if (env.OPENROUTER_API_KEY) {
    try {
      const idiomaPrompt = lang === "pt" ? "em portugu\xEAs" : "in English";
      const prompt = `Generate a brief movie synopsis based on the search context. Return strictly JSON with: 'sinopse' (${idiomaPrompt}), 'diretor', 'poster' (URL or null).`;
      const payload = {
        model: OPENROUTER_MODEL,
        temperature: 0.3,
        max_tokens: 500,
        messages: [{ role: "user", content: prompt }]
      };
      console.log("\n[DEBUG] Enviando Payload para OpenRouter (FILME FALLBACK):", JSON.stringify(payload, null, 2));
      const resp = await fetch(OPENROUTER_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "https://moovibe.pages.dev",
          "X-Title": "Moovibe"
        },
        body: JSON.stringify(payload)
      });
      if (!resp.ok) {
        const errorText = await resp.text().catch(() => "Unknown error");
        console.error(`[OPENROUTER FILME FALLBACK] Falhou com status ${resp.status}:`, errorText.substring(0, 300));
        return null;
      }
      const dados = await resp.json();
      const aiContent = dados?.choices?.[0]?.message?.content;
      if (!aiContent) {
        console.error("[OPENROUTER FILME FALLBACK] OpenRouter n\xE3o retornou escolhas v\xE1lidas.");
        return null;
      }
      const texto = aiContent.trim();
      console.log(`[FILME FALLBACK] OpenRouter resposta bruta: ${texto.substring(0, 300)}...`);
      const parsed = extrairJSON(texto);
      if (parsed && typeof parsed === "object") {
        let poster = parsed.poster;
        if (poster && !String(poster).startsWith("http")) poster = null;
        return {
          sinopse: parsed.sinopse || "Sinopse indispon\xEDvel.",
          diretor: parsed.diretor || "N\xE3o encontrado",
          poster
        };
      }
      return { sinopse: texto.substring(0, 2e3), diretor: "Encontrado via IA", poster: null };
    } catch (err) {
      console.error("[FILME FALLBACK] OpenRouter erro:", err);
    }
  }
  console.log("[FILME FALLBACK] Todas as camadas falharam.");
  return null;
}
__name(buscarDadosFilmeFallback, "buscarDadosFilmeFallback");
__name2(buscarDadosFilmeFallback, "buscarDadosFilmeFallback");
function limparHTML(texto) {
  const entidades = { amp: "&", lt: "<", gt: ">", quot: '"', "#x27": "'", "#x2F": "/" };
  return texto.replace(/<[^>]*>/g, "").replace(/&([a-zA-Z#0-9]+);/g, (match2, entidade) => entidades[entidade] || "").replace(/&#(\d+);/g, "").replace(/\s+/g, " ").trim();
}
__name(limparHTML, "limparHTML");
__name2(limparHTML, "limparHTML");
async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname.includes("/recommend")) {
    const kv = env.MOOVIBE_DB;
    if (!kv) return jsonResponse2([]);
    const slugParam = url.searchParams.get("slug");
    if (slugParam) {
      try {
        const shareData = await kv.get("share:" + slugParam, "json");
        if (shareData) return jsonResponse2(shareData);
        return jsonResponse2({ error: { message: "Link n\xE3o encontrado ou expirado." } }, 404);
      } catch (err) {
        console.error("[KV] Falha ao buscar slug:", err);
        return jsonResponse2({ error: { message: "Erro ao buscar link compartilhado." } }, 500);
      }
    }
    try {
      const listResult = await kv.list({ prefix: "history:", limit: 20 });
      const keys = listResult.keys || [];
      if (keys.length === 0) return jsonResponse2([]);
      const recommendations = await Promise.all(
        keys.map(async (key) => {
          try {
            const raw = await kv.get(key.name, "json");
            return raw || null;
          } catch (err) {
            console.error("[KV] Falha ao ler chave:", err);
            return null;
          }
        })
      );
      return jsonResponse2(recommendations.filter((item) => item !== null));
    } catch (err) {
      console.error("[KV] Falha ao listar hist\xF3rico:", err);
      return jsonResponse2([]);
    }
  }
  if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
  try {
    const body = await request.json();
    const { nome_musica, artista, lrclib_id } = body;
    const lang = body.lang === "pt" ? "pt" : "en";
    if (!nome_musica) return jsonResponse2({ error: { message: "Nome da m\xFAsica \xE9 obrigat\xF3rio." } }, 400);
    console.log("\n=== INICIANDO PIPELINE ===");
    let letra = "";
    let contextoExtra = null;
    const cacheMusica = await obterCacheMusica(nome_musica, artista, env);
    if (cacheMusica) {
      letra = cacheMusica.letra || "";
      contextoExtra = cacheMusica.contexto || null;
      console.log("[CACHE] Usando letra e contexto do cache.");
    } else {
      letra = await buscarLetraMusica(nome_musica, artista, env, lrclib_id || null);
      contextoExtra = await buscarContextoMusica(nome_musica, artista, env, letra, lang);
      if (!validarContexto(contextoExtra, letra)) contextoExtra = null;
      await gravarCacheMusica(nome_musica, artista, letra, contextoExtra, env);
    }
    if (!letra && !contextoExtra) {
      console.error("FALHA CR\xCDTICA: Nenhuma letra nem contexto encontrado em nenhuma camada");
      return jsonResponse2({ error: { message: "N\xE3o foi poss\xEDvel encontrar a vibe dessa m\xFAsica. Tente novamente ou escolha outra faixa.", code: "SONG_NOT_FOUND" } }, 404);
    }
    const historico = await listHistory(env);
    const filmesExcluidosGlobais = [];
    const filmesExcluidosMusica = [];
    if (Array.isArray(historico)) {
      for (const item of historico) {
        const movieTitle = item?.movie?.title;
        if (!movieTitle || typeof movieTitle !== "string") continue;
        if (!filmesExcluidosGlobais.includes(movieTitle) && filmesExcluidosGlobais.length < 20) filmesExcluidosGlobais.push(movieTitle);
        const mesmaMusica = item?.song?.toLowerCase() === nome_musica.toLowerCase() && (!artista || item?.artist?.toLowerCase() === artista.toLowerCase());
        if (mesmaMusica && !filmesExcluidosMusica.includes(movieTitle) && filmesExcluidosMusica.length < 5) filmesExcluidosMusica.push(movieTitle);
      }
    }
    if (filmesExcluidosGlobais.length > 0) console.log(`[ANTI-REPETICAO] Globais excluidos: ${filmesExcluidosGlobais.join(", ")}`);
    if (filmesExcluidosMusica.length > 0) console.log(`[ANTI-REPETICAO] Especificos da musica excluidos: ${filmesExcluidosMusica.join(", ")}`);
    const recomendacaoIA = await obterRecomendacaoIA(
      nome_musica,
      artista,
      letra,
      contextoExtra,
      env.OPENROUTER_API_KEY,
      filmesExcluidosGlobais,
      filmesExcluidosMusica,
      lang
    );
    if (!recomendacaoIA) {
      console.error("FALHA CR\xCDTICA: IA n\xE3o retornou recomenda\xE7\xE3o v\xE1lida");
      return jsonResponse2({ error: { message: "N\xE3o foi poss\xEDvel encontrar a vibe dessa m\xFAsica. Tente novamente ou escolha outra faixa.", code: "AI_UNAVAILABLE" } }, 503);
    }
    if (recomendacaoIA._errorCode === "RATE_LIMITED") {
      console.error("FALHA CR\xCDTICA: Rate limit no OpenRouter");
      return jsonResponse2({ error: { message: "N\xE3o foi poss\xEDvel encontrar a vibe dessa m\xFAsica. Tente novamente ou escolha outra faixa.", code: "RATE_LIMITED" } }, 429);
    }
    if (recomendacaoIA._errorCode === "AI_UNAVAILABLE") {
      console.error("FALHA CR\xCDTICA: IA indispon\xEDvel");
      return jsonResponse2({ error: { message: "N\xE3o foi poss\xEDvel encontrar a vibe dessa m\xFAsica. Tente novamente ou escolha outra faixa.", code: "AI_UNAVAILABLE" } }, 503);
    }
    const nomeFilme = sanitizarTituloFilme(recomendacaoIA.filme || recomendacaoIA.filme_sugerido || "");
    const anoFilme = recomendacaoIA.ano || recomendacaoIA.ano_filme || "";
    const justificativa = recomendacaoIA.justificativa || recomendacaoIA.justificativa_vibe || "";
    const vibeTitle = recomendacaoIA.vibe_title || "VIBE CINEMATICA";
    const tags = recomendacaoIA.tags || ["UNICO", "ESSENCIAL"];
    if (!nomeFilme) {
      console.error("FALHA CR\xCDTICA: IA n\xE3o retornou nome de filme v\xE1lido");
      return jsonResponse2({ error: { message: "N\xE3o foi poss\xEDvel encontrar a vibe dessa m\xFAsica. Tente novamente ou escolha outra faixa." } }, 500);
    }
    let dadosFilme = null;
    if (env.TMDB_API_KEY) dadosFilme = await obterDetalhesTMDB(nomeFilme, env.TMDB_API_KEY, anoFilme, lang);
    if (!dadosFilme || !dadosFilme.sinopse || dadosFilme.sinopse === "Sem sinopse disponivel.") {
      console.log("[FALLBACK ATIVADO: TMDb falhou, usando fallback]");
      const fallback = await buscarDadosFilmeFallback(nomeFilme, anoFilme, env, lang);
      if (fallback) {
        dadosFilme = {
          id_tmdb: null,
          titulo_pt: nomeFilme,
          titulo_original: nomeFilme,
          ano: anoFilme || "Nao informado",
          sinopse: fallback.sinopse || "Sinopse indisponivel.",
          poster: fallback.poster || null,
          diretor: fallback.diretor || "Nao encontrado",
          imdb_id: null,
          cenas: []
        };
      } else {
        dadosFilme = {
          id_tmdb: null,
          titulo_pt: nomeFilme,
          titulo_original: nomeFilme,
          ano: anoFilme || "Nao informado",
          sinopse: "Sinopse indisponivel.",
          poster: null,
          diretor: "Nao encontrado",
          imdb_id: null,
          cenas: []
        };
      }
    }
    let quotes = recomendacaoIA.citacoes || [];
    const QUOTES_PADRAO = ["Cinema is magic.", "Every film is a journey.", "Lights, camera, action!"];
    const isQuotesPadrao = !Array.isArray(quotes) || quotes.length < 3 || JSON.stringify(quotes.slice(0, 3)) === JSON.stringify(QUOTES_PADRAO);
    if (isQuotesPadrao || quotes.length < 3) {
      const quotesDaLetra = extrairQuotesDaLetra(letra, 3);
      if (quotesDaLetra.length >= 3) quotes = quotesDaLetra;
      else if (!Array.isArray(quotes) || quotes.length < 3) quotes = [...QUOTES_PADRAO];
    }
    if (isQuotesPadrao && dadosFilme && dadosFilme.tagline) {
      quotes = [dadosFilme.tagline, quotes[1], quotes[2]];
    }
    quotes = quotes.slice(0, 3);
    if (dadosFilme && (!dadosFilme.cenas || dadosFilme.cenas.length === 0)) {
      const poster = dadosFilme.poster;
      if (poster) dadosFilme.cenas = [poster, poster, poster];
    }
    const capaDados = await buscarCapaMusica(nome_musica, artista);
    const coverUrl = capaDados?.coverUrl || "";
    const previewUrl = capaDados?.previewUrl || null;
    const imdbUrl = dadosFilme?.imdb_id ? `https://www.imdb.com/title/${dadosFilme.imdb_id}/` : `https://www.imdb.com/find?q=${encodeURIComponent(nomeFilme)}`;
    const letterboxdUrl = dadosFilme?.id_tmdb ? `https://letterboxd.com/tmdb/${dadosFilme.id_tmdb}` : `https://letterboxd.com/search/${encodeURIComponent(nomeFilme)}/`;
    const slug = slugify(nomeFilme + "-" + nome_musica);
    const resposta = {
      song: nome_musica,
      artist: artista || "",
      share_slug: slug,
      movie: {
        title: dadosFilme?.titulo_pt || nomeFilme,
        original_title: dadosFilme?.titulo_original || nomeFilme,
        release_year: dadosFilme?.ano || anoFilme || "Nao informado",
        director: dadosFilme?.diretor || "Nao encontrado",
        synopsis: dadosFilme?.sinopse || "Sinopse nao disponivel.",
        poster_url: dadosFilme?.poster || "",
        cover_url: coverUrl,
        audio_preview_url: previewUrl,
        stills: dadosFilme?.cenas || [],
        quotes,
        ai_explanation: `<p>${justificativa}</p>`,
        vibe_title: vibeTitle,
        tags,
        imdb_url: imdbUrl,
        letterboxd_url: letterboxdUrl,
        tiktok_url: `https://www.tiktok.com/search?q=${encodeURIComponent(nomeFilme + " edit")}`
      }
    };
    await storeHistory({ song: nome_musica, artist: artista, movie: resposta.movie }, env);
    await storeShare(slug, resposta, env);
    console.log("\n=== PIPELINE CONCLU\xCDDA COM SUCESSO ===");
    console.log(`[SHARE] Slug gerado: ${slug}`);
    return jsonResponse2(resposta, 200);
  } catch (error) {
    console.error("Pages Function error:", error);
    return jsonResponse2({ error: { message: "N\xE3o foi poss\xEDvel encontrar a vibe dessa m\xFAsica. Tente novamente ou escolha outra faixa.", code: "UNKNOWN" } }, 500);
  }
}
__name(onRequest, "onRequest");
__name2(onRequest, "onRequest");
async function storeHistory(payload, env) {
  try {
    const kv = env.MOOVIBE_DB;
    if (!kv) return;
    const key = `history:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
    await kv.put(key, JSON.stringify(payload), { expirationTtl: 60 * 60 * 24 * 30 });
  } catch (err) {
    console.error("[HISTORY] Falha ao salvar:", err);
  }
}
__name(storeHistory, "storeHistory");
__name2(storeHistory, "storeHistory");
async function storeShare(slug, payload, env) {
  try {
    const kv = env.MOOVIBE_DB;
    if (!kv) return;
    await kv.put("share:" + slug, JSON.stringify(payload), { expirationTtl: 60 * 60 * 24 * 30 });
    console.log(`[SHARE] Salvo no KV: share:${slug}`);
  } catch (err) {
    console.error("[SHARE] Falha ao salvar:", err);
  }
}
__name(storeShare, "storeShare");
__name2(storeShare, "storeShare");
async function listHistory(env) {
  try {
    const kv = env.MOOVIBE_DB;
    if (!kv) return [];
    const list = await kv.list({ prefix: "history:", limit: 100, reverse: true });
    const items = [];
    for (const entry of list.keys || []) {
      const raw = await kv.get(entry.name, "json");
      if (raw) items.push(raw);
    }
    return items.slice(0, 25);
  } catch (err) {
    console.error("[HISTORY] Falha ao listar:", err);
    return [];
  }
}
__name(listHistory, "listHistory");
__name2(listHistory, "listHistory");
var routes = [
  {
    routePath: "/share/:slug",
    mountPath: "/share",
    method: "GET",
    middlewares: [],
    modules: [onRequestGet]
  },
  {
    routePath: "/lrclib-search",
    mountPath: "/",
    method: "GET",
    middlewares: [],
    modules: [onRequestGet2]
  },
  {
    routePath: "/recommend",
    mountPath: "/",
    method: "",
    middlewares: [],
    modules: [onRequest]
  }
];
function lexer(str) {
  var tokens = [];
  var i = 0;
  while (i < str.length) {
    var char = str[i];
    if (char === "*" || char === "+" || char === "?") {
      tokens.push({ type: "MODIFIER", index: i, value: str[i++] });
      continue;
    }
    if (char === "\\") {
      tokens.push({ type: "ESCAPED_CHAR", index: i++, value: str[i++] });
      continue;
    }
    if (char === "{") {
      tokens.push({ type: "OPEN", index: i, value: str[i++] });
      continue;
    }
    if (char === "}") {
      tokens.push({ type: "CLOSE", index: i, value: str[i++] });
      continue;
    }
    if (char === ":") {
      var name = "";
      var j = i + 1;
      while (j < str.length) {
        var code = str.charCodeAt(j);
        if (
          // `0-9`
          code >= 48 && code <= 57 || // `A-Z`
          code >= 65 && code <= 90 || // `a-z`
          code >= 97 && code <= 122 || // `_`
          code === 95
        ) {
          name += str[j++];
          continue;
        }
        break;
      }
      if (!name)
        throw new TypeError("Missing parameter name at ".concat(i));
      tokens.push({ type: "NAME", index: i, value: name });
      i = j;
      continue;
    }
    if (char === "(") {
      var count = 1;
      var pattern = "";
      var j = i + 1;
      if (str[j] === "?") {
        throw new TypeError('Pattern cannot start with "?" at '.concat(j));
      }
      while (j < str.length) {
        if (str[j] === "\\") {
          pattern += str[j++] + str[j++];
          continue;
        }
        if (str[j] === ")") {
          count--;
          if (count === 0) {
            j++;
            break;
          }
        } else if (str[j] === "(") {
          count++;
          if (str[j + 1] !== "?") {
            throw new TypeError("Capturing groups are not allowed at ".concat(j));
          }
        }
        pattern += str[j++];
      }
      if (count)
        throw new TypeError("Unbalanced pattern at ".concat(i));
      if (!pattern)
        throw new TypeError("Missing pattern at ".concat(i));
      tokens.push({ type: "PATTERN", index: i, value: pattern });
      i = j;
      continue;
    }
    tokens.push({ type: "CHAR", index: i, value: str[i++] });
  }
  tokens.push({ type: "END", index: i, value: "" });
  return tokens;
}
__name(lexer, "lexer");
__name2(lexer, "lexer");
function parse(str, options) {
  if (options === void 0) {
    options = {};
  }
  var tokens = lexer(str);
  var _a = options.prefixes, prefixes = _a === void 0 ? "./" : _a, _b = options.delimiter, delimiter = _b === void 0 ? "/#?" : _b;
  var result = [];
  var key = 0;
  var i = 0;
  var path = "";
  var tryConsume = /* @__PURE__ */ __name2(function(type) {
    if (i < tokens.length && tokens[i].type === type)
      return tokens[i++].value;
  }, "tryConsume");
  var mustConsume = /* @__PURE__ */ __name2(function(type) {
    var value2 = tryConsume(type);
    if (value2 !== void 0)
      return value2;
    var _a2 = tokens[i], nextType = _a2.type, index = _a2.index;
    throw new TypeError("Unexpected ".concat(nextType, " at ").concat(index, ", expected ").concat(type));
  }, "mustConsume");
  var consumeText = /* @__PURE__ */ __name2(function() {
    var result2 = "";
    var value2;
    while (value2 = tryConsume("CHAR") || tryConsume("ESCAPED_CHAR")) {
      result2 += value2;
    }
    return result2;
  }, "consumeText");
  var isSafe = /* @__PURE__ */ __name2(function(value2) {
    for (var _i = 0, delimiter_1 = delimiter; _i < delimiter_1.length; _i++) {
      var char2 = delimiter_1[_i];
      if (value2.indexOf(char2) > -1)
        return true;
    }
    return false;
  }, "isSafe");
  var safePattern = /* @__PURE__ */ __name2(function(prefix2) {
    var prev = result[result.length - 1];
    var prevText = prefix2 || (prev && typeof prev === "string" ? prev : "");
    if (prev && !prevText) {
      throw new TypeError('Must have text between two parameters, missing text after "'.concat(prev.name, '"'));
    }
    if (!prevText || isSafe(prevText))
      return "[^".concat(escapeString(delimiter), "]+?");
    return "(?:(?!".concat(escapeString(prevText), ")[^").concat(escapeString(delimiter), "])+?");
  }, "safePattern");
  while (i < tokens.length) {
    var char = tryConsume("CHAR");
    var name = tryConsume("NAME");
    var pattern = tryConsume("PATTERN");
    if (name || pattern) {
      var prefix = char || "";
      if (prefixes.indexOf(prefix) === -1) {
        path += prefix;
        prefix = "";
      }
      if (path) {
        result.push(path);
        path = "";
      }
      result.push({
        name: name || key++,
        prefix,
        suffix: "",
        pattern: pattern || safePattern(prefix),
        modifier: tryConsume("MODIFIER") || ""
      });
      continue;
    }
    var value = char || tryConsume("ESCAPED_CHAR");
    if (value) {
      path += value;
      continue;
    }
    if (path) {
      result.push(path);
      path = "";
    }
    var open = tryConsume("OPEN");
    if (open) {
      var prefix = consumeText();
      var name_1 = tryConsume("NAME") || "";
      var pattern_1 = tryConsume("PATTERN") || "";
      var suffix = consumeText();
      mustConsume("CLOSE");
      result.push({
        name: name_1 || (pattern_1 ? key++ : ""),
        pattern: name_1 && !pattern_1 ? safePattern(prefix) : pattern_1,
        prefix,
        suffix,
        modifier: tryConsume("MODIFIER") || ""
      });
      continue;
    }
    mustConsume("END");
  }
  return result;
}
__name(parse, "parse");
__name2(parse, "parse");
function match(str, options) {
  var keys = [];
  var re = pathToRegexp(str, keys, options);
  return regexpToFunction(re, keys, options);
}
__name(match, "match");
__name2(match, "match");
function regexpToFunction(re, keys, options) {
  if (options === void 0) {
    options = {};
  }
  var _a = options.decode, decode = _a === void 0 ? function(x) {
    return x;
  } : _a;
  return function(pathname) {
    var m = re.exec(pathname);
    if (!m)
      return false;
    var path = m[0], index = m.index;
    var params = /* @__PURE__ */ Object.create(null);
    var _loop_1 = /* @__PURE__ */ __name2(function(i2) {
      if (m[i2] === void 0)
        return "continue";
      var key = keys[i2 - 1];
      if (key.modifier === "*" || key.modifier === "+") {
        params[key.name] = m[i2].split(key.prefix + key.suffix).map(function(value) {
          return decode(value, key);
        });
      } else {
        params[key.name] = decode(m[i2], key);
      }
    }, "_loop_1");
    for (var i = 1; i < m.length; i++) {
      _loop_1(i);
    }
    return { path, index, params };
  };
}
__name(regexpToFunction, "regexpToFunction");
__name2(regexpToFunction, "regexpToFunction");
function escapeString(str) {
  return str.replace(/([.+*?=^!:${}()[\]|/\\])/g, "\\$1");
}
__name(escapeString, "escapeString");
__name2(escapeString, "escapeString");
function flags(options) {
  return options && options.sensitive ? "" : "i";
}
__name(flags, "flags");
__name2(flags, "flags");
function regexpToRegexp(path, keys) {
  if (!keys)
    return path;
  var groupsRegex = /\((?:\?<(.*?)>)?(?!\?)/g;
  var index = 0;
  var execResult = groupsRegex.exec(path.source);
  while (execResult) {
    keys.push({
      // Use parenthesized substring match if available, index otherwise
      name: execResult[1] || index++,
      prefix: "",
      suffix: "",
      modifier: "",
      pattern: ""
    });
    execResult = groupsRegex.exec(path.source);
  }
  return path;
}
__name(regexpToRegexp, "regexpToRegexp");
__name2(regexpToRegexp, "regexpToRegexp");
function arrayToRegexp(paths, keys, options) {
  var parts = paths.map(function(path) {
    return pathToRegexp(path, keys, options).source;
  });
  return new RegExp("(?:".concat(parts.join("|"), ")"), flags(options));
}
__name(arrayToRegexp, "arrayToRegexp");
__name2(arrayToRegexp, "arrayToRegexp");
function stringToRegexp(path, keys, options) {
  return tokensToRegexp(parse(path, options), keys, options);
}
__name(stringToRegexp, "stringToRegexp");
__name2(stringToRegexp, "stringToRegexp");
function tokensToRegexp(tokens, keys, options) {
  if (options === void 0) {
    options = {};
  }
  var _a = options.strict, strict = _a === void 0 ? false : _a, _b = options.start, start = _b === void 0 ? true : _b, _c = options.end, end = _c === void 0 ? true : _c, _d = options.encode, encode = _d === void 0 ? function(x) {
    return x;
  } : _d, _e = options.delimiter, delimiter = _e === void 0 ? "/#?" : _e, _f = options.endsWith, endsWith = _f === void 0 ? "" : _f;
  var endsWithRe = "[".concat(escapeString(endsWith), "]|$");
  var delimiterRe = "[".concat(escapeString(delimiter), "]");
  var route = start ? "^" : "";
  for (var _i = 0, tokens_1 = tokens; _i < tokens_1.length; _i++) {
    var token = tokens_1[_i];
    if (typeof token === "string") {
      route += escapeString(encode(token));
    } else {
      var prefix = escapeString(encode(token.prefix));
      var suffix = escapeString(encode(token.suffix));
      if (token.pattern) {
        if (keys)
          keys.push(token);
        if (prefix || suffix) {
          if (token.modifier === "+" || token.modifier === "*") {
            var mod = token.modifier === "*" ? "?" : "";
            route += "(?:".concat(prefix, "((?:").concat(token.pattern, ")(?:").concat(suffix).concat(prefix, "(?:").concat(token.pattern, "))*)").concat(suffix, ")").concat(mod);
          } else {
            route += "(?:".concat(prefix, "(").concat(token.pattern, ")").concat(suffix, ")").concat(token.modifier);
          }
        } else {
          if (token.modifier === "+" || token.modifier === "*") {
            throw new TypeError('Can not repeat "'.concat(token.name, '" without a prefix and suffix'));
          }
          route += "(".concat(token.pattern, ")").concat(token.modifier);
        }
      } else {
        route += "(?:".concat(prefix).concat(suffix, ")").concat(token.modifier);
      }
    }
  }
  if (end) {
    if (!strict)
      route += "".concat(delimiterRe, "?");
    route += !options.endsWith ? "$" : "(?=".concat(endsWithRe, ")");
  } else {
    var endToken = tokens[tokens.length - 1];
    var isEndDelimited = typeof endToken === "string" ? delimiterRe.indexOf(endToken[endToken.length - 1]) > -1 : endToken === void 0;
    if (!strict) {
      route += "(?:".concat(delimiterRe, "(?=").concat(endsWithRe, "))?");
    }
    if (!isEndDelimited) {
      route += "(?=".concat(delimiterRe, "|").concat(endsWithRe, ")");
    }
  }
  return new RegExp(route, flags(options));
}
__name(tokensToRegexp, "tokensToRegexp");
__name2(tokensToRegexp, "tokensToRegexp");
function pathToRegexp(path, keys, options) {
  if (path instanceof RegExp)
    return regexpToRegexp(path, keys);
  if (Array.isArray(path))
    return arrayToRegexp(path, keys, options);
  return stringToRegexp(path, keys, options);
}
__name(pathToRegexp, "pathToRegexp");
__name2(pathToRegexp, "pathToRegexp");
var escapeRegex = /[.+?^${}()|[\]\\]/g;
function* executeRequest(request) {
  const requestPath = new URL(request.url).pathname;
  for (const route of [...routes].reverse()) {
    if (route.method && route.method !== request.method) {
      continue;
    }
    const routeMatcher = match(route.routePath.replace(escapeRegex, "\\$&"), {
      end: false
    });
    const mountMatcher = match(route.mountPath.replace(escapeRegex, "\\$&"), {
      end: false
    });
    const matchResult = routeMatcher(requestPath);
    const mountMatchResult = mountMatcher(requestPath);
    if (matchResult && mountMatchResult) {
      for (const handler of route.middlewares.flat()) {
        yield {
          handler,
          params: matchResult.params,
          path: mountMatchResult.path
        };
      }
    }
  }
  for (const route of routes) {
    if (route.method && route.method !== request.method) {
      continue;
    }
    const routeMatcher = match(route.routePath.replace(escapeRegex, "\\$&"), {
      end: true
    });
    const mountMatcher = match(route.mountPath.replace(escapeRegex, "\\$&"), {
      end: false
    });
    const matchResult = routeMatcher(requestPath);
    const mountMatchResult = mountMatcher(requestPath);
    if (matchResult && mountMatchResult && route.modules.length) {
      for (const handler of route.modules.flat()) {
        yield {
          handler,
          params: matchResult.params,
          path: matchResult.path
        };
      }
      break;
    }
  }
}
__name(executeRequest, "executeRequest");
__name2(executeRequest, "executeRequest");
var pages_template_worker_default = {
  async fetch(originalRequest, env, workerContext) {
    let request = originalRequest;
    const handlerIterator = executeRequest(request);
    let data = {};
    let isFailOpen = false;
    const next = /* @__PURE__ */ __name2(async (input, init) => {
      if (input !== void 0) {
        let url = input;
        if (typeof input === "string") {
          url = new URL(input, request.url).toString();
        }
        request = new Request(url, init);
      }
      const result = handlerIterator.next();
      if (result.done === false) {
        const { handler, params, path } = result.value;
        const context = {
          request: new Request(request.clone()),
          functionPath: path,
          next,
          params,
          get data() {
            return data;
          },
          set data(value) {
            if (typeof value !== "object" || value === null) {
              throw new Error("context.data must be an object");
            }
            data = value;
          },
          env,
          waitUntil: workerContext.waitUntil.bind(workerContext),
          passThroughOnException: /* @__PURE__ */ __name2(() => {
            isFailOpen = true;
          }, "passThroughOnException")
        };
        const response = await handler(context);
        if (!(response instanceof Response)) {
          throw new Error("Your Pages function should return a Response");
        }
        return cloneResponse(response);
      } else if ("ASSETS") {
        const response = await env["ASSETS"].fetch(request);
        return cloneResponse(response);
      } else {
        const response = await fetch(request);
        return cloneResponse(response);
      }
    }, "next");
    try {
      return await next();
    } catch (error) {
      if (isFailOpen) {
        const response = await env["ASSETS"].fetch(request);
        return cloneResponse(response);
      }
      throw error;
    }
  }
};
var cloneResponse = /* @__PURE__ */ __name2((response) => (
  // https://fetch.spec.whatwg.org/#null-body-status
  new Response(
    [101, 204, 205, 304].includes(response.status) ? null : response.body,
    response
  )
), "cloneResponse");
var drainBody = /* @__PURE__ */ __name2(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } finally {
    try {
      if (request.body !== null && !request.bodyUsed) {
        const reader = request.body.getReader();
        while (!(await reader.read()).done) {
        }
      }
    } catch (e) {
      console.error("Failed to drain the unused request body.", e);
    }
  }
}, "drainBody");
var middleware_ensure_req_body_drained_default = drainBody;
function reduceError(e) {
  return {
    name: e?.name,
    message: e?.message ?? String(e),
    stack: e?.stack,
    cause: e?.cause === void 0 ? void 0 : reduceError(e.cause)
  };
}
__name(reduceError, "reduceError");
__name2(reduceError, "reduceError");
var jsonError = /* @__PURE__ */ __name2(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } catch (e) {
    const error = reduceError(e);
    const body = JSON.stringify(error);
    const headers = {
      "Content-Type": "application/json",
      "MF-Experimental-Error-Stack": "true"
    };
    const encoded = encodeURIComponent(body);
    if (encoded.length <= 8192) {
      headers["MF-Experimental-Error-Stack-Payload"] = encoded;
    }
    return new Response(body, { status: 500, headers });
  }
}, "jsonError");
var middleware_miniflare3_json_error_default = jsonError;
var __INTERNAL_WRANGLER_MIDDLEWARE__ = [
  middleware_ensure_req_body_drained_default,
  middleware_miniflare3_json_error_default
];
var middleware_insertion_facade_default = pages_template_worker_default;
var __facade_middleware__ = [];
function __facade_register__(...args) {
  __facade_middleware__.push(...args.flat());
}
__name(__facade_register__, "__facade_register__");
__name2(__facade_register__, "__facade_register__");
function __facade_invokeChain__(request, env, ctx, dispatch, middlewareChain) {
  const [head, ...tail] = middlewareChain;
  const middlewareCtx = {
    dispatch,
    next(newRequest, newEnv) {
      return __facade_invokeChain__(newRequest, newEnv, ctx, dispatch, tail);
    }
  };
  return head(request, env, ctx, middlewareCtx);
}
__name(__facade_invokeChain__, "__facade_invokeChain__");
__name2(__facade_invokeChain__, "__facade_invokeChain__");
function __facade_invoke__(request, env, ctx, dispatch, finalMiddleware) {
  return __facade_invokeChain__(request, env, ctx, dispatch, [
    ...__facade_middleware__,
    finalMiddleware
  ]);
}
__name(__facade_invoke__, "__facade_invoke__");
__name2(__facade_invoke__, "__facade_invoke__");
var __Facade_ScheduledController__ = class ___Facade_ScheduledController__ {
  static {
    __name(this, "___Facade_ScheduledController__");
  }
  constructor(scheduledTime, cron, noRetry) {
    this.scheduledTime = scheduledTime;
    this.cron = cron;
    this.#noRetry = noRetry;
  }
  scheduledTime;
  cron;
  static {
    __name2(this, "__Facade_ScheduledController__");
  }
  #noRetry;
  noRetry() {
    if (!(this instanceof ___Facade_ScheduledController__)) {
      throw new TypeError("Illegal invocation");
    }
    this.#noRetry();
  }
};
function wrapExportedHandler(worker) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return worker;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  const fetchDispatcher = /* @__PURE__ */ __name2(function(request, env, ctx) {
    if (worker.fetch === void 0) {
      throw new Error("Handler does not export a fetch() function.");
    }
    return worker.fetch(request, env, ctx);
  }, "fetchDispatcher");
  return {
    ...worker,
    fetch(request, env, ctx) {
      const dispatcher = /* @__PURE__ */ __name2(function(type, init) {
        if (type === "scheduled" && worker.scheduled !== void 0) {
          const controller = new __Facade_ScheduledController__(
            Date.now(),
            init.cron ?? "",
            () => {
            }
          );
          return worker.scheduled(controller, env, ctx);
        }
      }, "dispatcher");
      return __facade_invoke__(request, env, ctx, dispatcher, fetchDispatcher);
    }
  };
}
__name(wrapExportedHandler, "wrapExportedHandler");
__name2(wrapExportedHandler, "wrapExportedHandler");
function wrapWorkerEntrypoint(klass) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return klass;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  return class extends klass {
    #fetchDispatcher = /* @__PURE__ */ __name2((request, env, ctx) => {
      this.env = env;
      this.ctx = ctx;
      if (super.fetch === void 0) {
        throw new Error("Entrypoint class does not define a fetch() function.");
      }
      return super.fetch(request);
    }, "#fetchDispatcher");
    #dispatcher = /* @__PURE__ */ __name2((type, init) => {
      if (type === "scheduled" && super.scheduled !== void 0) {
        const controller = new __Facade_ScheduledController__(
          Date.now(),
          init.cron ?? "",
          () => {
          }
        );
        return super.scheduled(controller);
      }
    }, "#dispatcher");
    fetch(request) {
      return __facade_invoke__(
        request,
        this.env,
        this.ctx,
        this.#dispatcher,
        this.#fetchDispatcher
      );
    }
  };
}
__name(wrapWorkerEntrypoint, "wrapWorkerEntrypoint");
__name2(wrapWorkerEntrypoint, "wrapWorkerEntrypoint");
var WRAPPED_ENTRY;
if (typeof middleware_insertion_facade_default === "object") {
  WRAPPED_ENTRY = wrapExportedHandler(middleware_insertion_facade_default);
} else if (typeof middleware_insertion_facade_default === "function") {
  WRAPPED_ENTRY = wrapWorkerEntrypoint(middleware_insertion_facade_default);
}
var middleware_loader_entry_default = WRAPPED_ENTRY;

// ../../../AppData/Local/npm-cache/_npx/32026684e21afda6/node_modules/wrangler/templates/middleware/middleware-ensure-req-body-drained.ts
var drainBody2 = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } finally {
    try {
      if (request.body !== null && !request.bodyUsed) {
        const reader = request.body.getReader();
        while (!(await reader.read()).done) {
        }
      }
    } catch (e) {
      console.error("Failed to drain the unused request body.", e);
    }
  }
}, "drainBody");
var middleware_ensure_req_body_drained_default2 = drainBody2;

// ../../../AppData/Local/npm-cache/_npx/32026684e21afda6/node_modules/wrangler/templates/middleware/middleware-miniflare3-json-error.ts
function reduceError2(e) {
  return {
    name: e?.name,
    message: e?.message ?? String(e),
    stack: e?.stack,
    cause: e?.cause === void 0 ? void 0 : reduceError2(e.cause)
  };
}
__name(reduceError2, "reduceError");
var jsonError2 = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } catch (e) {
    const error = reduceError2(e);
    const body = JSON.stringify(error);
    const headers = {
      "Content-Type": "application/json",
      "MF-Experimental-Error-Stack": "true"
    };
    const encoded = encodeURIComponent(body);
    if (encoded.length <= 8192) {
      headers["MF-Experimental-Error-Stack-Payload"] = encoded;
    }
    return new Response(body, { status: 500, headers });
  }
}, "jsonError");
var middleware_miniflare3_json_error_default2 = jsonError2;

// .wrangler/tmp/bundle-1UvmGJ/middleware-insertion-facade.js
var __INTERNAL_WRANGLER_MIDDLEWARE__2 = [
  middleware_ensure_req_body_drained_default2,
  middleware_miniflare3_json_error_default2
];
var middleware_insertion_facade_default2 = middleware_loader_entry_default;

// ../../../AppData/Local/npm-cache/_npx/32026684e21afda6/node_modules/wrangler/templates/middleware/common.ts
var __facade_middleware__2 = [];
function __facade_register__2(...args) {
  __facade_middleware__2.push(...args.flat());
}
__name(__facade_register__2, "__facade_register__");
function __facade_invokeChain__2(request, env, ctx, dispatch, middlewareChain) {
  const [head, ...tail] = middlewareChain;
  const middlewareCtx = {
    dispatch,
    next(newRequest, newEnv) {
      return __facade_invokeChain__2(newRequest, newEnv, ctx, dispatch, tail);
    }
  };
  return head(request, env, ctx, middlewareCtx);
}
__name(__facade_invokeChain__2, "__facade_invokeChain__");
function __facade_invoke__2(request, env, ctx, dispatch, finalMiddleware) {
  return __facade_invokeChain__2(request, env, ctx, dispatch, [
    ...__facade_middleware__2,
    finalMiddleware
  ]);
}
__name(__facade_invoke__2, "__facade_invoke__");

// .wrangler/tmp/bundle-1UvmGJ/middleware-loader.entry.ts
var __Facade_ScheduledController__2 = class ___Facade_ScheduledController__2 {
  constructor(scheduledTime, cron, noRetry) {
    this.scheduledTime = scheduledTime;
    this.cron = cron;
    this.#noRetry = noRetry;
  }
  scheduledTime;
  cron;
  static {
    __name(this, "__Facade_ScheduledController__");
  }
  #noRetry;
  noRetry() {
    if (!(this instanceof ___Facade_ScheduledController__2)) {
      throw new TypeError("Illegal invocation");
    }
    this.#noRetry();
  }
};
function wrapExportedHandler2(worker) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__2 === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__2.length === 0) {
    return worker;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__2) {
    __facade_register__2(middleware);
  }
  const fetchDispatcher = /* @__PURE__ */ __name(function(request, env, ctx) {
    if (worker.fetch === void 0) {
      throw new Error("Handler does not export a fetch() function.");
    }
    return worker.fetch(request, env, ctx);
  }, "fetchDispatcher");
  return {
    ...worker,
    fetch(request, env, ctx) {
      const dispatcher = /* @__PURE__ */ __name(function(type, init) {
        if (type === "scheduled" && worker.scheduled !== void 0) {
          const controller = new __Facade_ScheduledController__2(
            Date.now(),
            init.cron ?? "",
            () => {
            }
          );
          return worker.scheduled(controller, env, ctx);
        }
      }, "dispatcher");
      return __facade_invoke__2(request, env, ctx, dispatcher, fetchDispatcher);
    }
  };
}
__name(wrapExportedHandler2, "wrapExportedHandler");
function wrapWorkerEntrypoint2(klass) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__2 === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__2.length === 0) {
    return klass;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__2) {
    __facade_register__2(middleware);
  }
  return class extends klass {
    #fetchDispatcher = /* @__PURE__ */ __name((request, env, ctx) => {
      this.env = env;
      this.ctx = ctx;
      if (super.fetch === void 0) {
        throw new Error("Entrypoint class does not define a fetch() function.");
      }
      return super.fetch(request);
    }, "#fetchDispatcher");
    #dispatcher = /* @__PURE__ */ __name((type, init) => {
      if (type === "scheduled" && super.scheduled !== void 0) {
        const controller = new __Facade_ScheduledController__2(
          Date.now(),
          init.cron ?? "",
          () => {
          }
        );
        return super.scheduled(controller);
      }
    }, "#dispatcher");
    fetch(request) {
      return __facade_invoke__2(
        request,
        this.env,
        this.ctx,
        this.#dispatcher,
        this.#fetchDispatcher
      );
    }
  };
}
__name(wrapWorkerEntrypoint2, "wrapWorkerEntrypoint");
var WRAPPED_ENTRY2;
if (typeof middleware_insertion_facade_default2 === "object") {
  WRAPPED_ENTRY2 = wrapExportedHandler2(middleware_insertion_facade_default2);
} else if (typeof middleware_insertion_facade_default2 === "function") {
  WRAPPED_ENTRY2 = wrapWorkerEntrypoint2(middleware_insertion_facade_default2);
}
var middleware_loader_entry_default2 = WRAPPED_ENTRY2;
export {
  __INTERNAL_WRANGLER_MIDDLEWARE__2 as __INTERNAL_WRANGLER_MIDDLEWARE__,
  middleware_loader_entry_default2 as default
};
//# sourceMappingURL=functionsWorker-0.11251635149196604.js.map
