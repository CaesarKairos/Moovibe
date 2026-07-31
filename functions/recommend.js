/**
 * Moovibe - Cloudflare Pages Function
 * Lógica espelhada de app.py (Python → JavaScript)
 */

const LRCLIB_URL = 'https://lrclib.net/api';
const LRCLIB_GET_URL = `${LRCLIB_URL}/get`;
const LRCLIB_SEARCH_URL = `${LRCLIB_URL}/search`;
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const TMDB_BUSCA_URL = 'https://api.themoviedb.org/3/search/movie';
const TMDB_BASE_URL = 'https://api.themoviedb.org/3/movie';
const WIKIPEDIA_PT_API = 'https://pt.wikipedia.org/api/rest_v1/page/summary/';
const WIKIPEDIA_EN_API = 'https://en.wikipedia.org/api/rest_v1/page/summary/';
const LRCLIB_THROTTLE_MS = 250;
const MOOVIBE_VERSION = '1.0';
const MOOVIBE_USER_AGENT = `Moovibe/${MOOVIBE_VERSION} (mailto:cesarbatistasantos08@gmail.com)`;

const BROWSER_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

let lrclibLastRequest = 0;
function lrclibThrottle() {
  const now = Date.now();
  const wait = Math.max(0, LRCLIB_THROTTLE_MS - (now - lrclibLastRequest));
  lrclibLastRequest = now + wait;
  return wait > 0 ? new Promise(resolve => setTimeout(resolve, wait)) : Promise.resolve();
}

function lrclibHeaders() {
  return {
    'User-Agent': MOOVIBE_USER_AGENT,
    'X-User-Agent': MOOVIBE_USER_AGENT,
  };
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function slugify(texto) {
  if (!texto) return '';
  let slug = texto.toLowerCase();
  slug = slug.replace(/ & /g, ' e ');
  slug = slug.replace(/ \/ /g, ' ');
  slug = slug.replace(/[áàâãäå]/g, 'a');
  slug = slug.replace(/[éèêë]/g, 'e');
  slug = slug.replace(/[íìîï]/g, 'i');
  slug = slug.replace(/[óòôõö]/g, 'o');
  slug = slug.replace(/[úùûü]/g, 'u');
  slug = slug.replace(/[ç]/g, 'c');
  slug = slug.replace(/[ñ]/g, 'n');
  slug = slug.replace(/[^a-z0-9\s-]/g, '');
  slug = slug.replace(/[\s]+/g, '-');
  slug = slug.replace(/-+/g, '-');
  slug = slug.replace(/^-+|-+$/g, '');
  return slug;
}

function limparTermoMusica(termo) {
  if (!termo) return termo;
  let t = termo;
  t = t.replace(/\(\d{4}\)/g, '');
  t = t.replace(/\[\d{4}\]/g, '');
  t = t.replace(/\([^)]*(?:official|music\s*video|remaster|remastered|audio|lyric|video|visualizer|live|feat\.?|ft\.?|prod\.?|explicit|clean|edit|version|4k|hd|360|clip|single|lyrics|audio|official\s*audio)[^)]*\)/gi, '');
  t = t.replace(/\[[^\]]*(?:official|music\s*video|remaster|remastered|audio|lyric|video|visualizer|live|feat\.?|ft\.?|prod\.?|explicit|clean|edit|version|4k|hd|360|clip|single|lyrics|audio|official\s*audio)[^\]]*\]/gi, '');
  t = t.replace(/\s+(?:feat\.?|ft\.?)\..*$/i, '');
  t = t.replace(/\s+[\(\[].*?(?:feat\.?|ft\.?).*?[\)\]]/gi, '');
  return t.trim();
}

function sanitizarTituloFilme(titulo) {
  if (!titulo || typeof titulo !== 'string') return '';
  let t = titulo.trim();
  t = t.replace(/\s+(?:19|20)\d{2}\s*$/, '');
  t = t.replace(/\s*[\(\[]\s*(?:19|20)\d{2}\s*[\)\]]\s*$/, '');
  t = t.replace(/\s*[-–—]\s*(?:19|20)\d{2}\s*$/, '');
  return t.trim();
}

function extrairJSON(texto) {
  if (!texto || typeof texto !== 'string') return null;
  
  const Limpo = texto.replace(/```json/g, '').replace(/```/g, '').trim();
  
  const match = Limpo.match(/\{[\s\S]*\}/);
  if (match) {
    try {
      return JSON.parse(match[0]);
    } catch (e) {
      console.error('[OPENROUTER] Regex JSON parse falhou:', e);
    }
  }
  
  return null;
}

function extrairQuotesDaLetra(letra, maxQuotes = 3) {
  if (!letra || typeof letra !== 'string') return [];
  
  const linhas = letra.split('\n');
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

function extrairDuasPrimeirasFrases(texto) {
  if (!texto) return '';
  const textoLimpo = texto.replace(/\s+/g, ' ').trim();
  const frases = textoLimpo.split(/(?<=[.!?])\s+/).filter(Boolean);
  if (frases.length >= 2) return `${frases[0]} ${frases[1]}`;
  if (frases.length === 1) return frases[0];
  return textoLimpo.substring(0, 500);
}

function validarContexto(texto, letra) {
  if (!texto || typeof texto !== 'string') return false;
  if (!letra || typeof letra !== 'string') return true;
  const trechoLetra = letra.replace(/\s+/g, ' ').trim().substring(0, 180);
  const trechoContexto = texto.replace(/\s+/g, ' ').trim().substring(0, 180);
  if (trechoContexto === trechoLetra) return false;
  if (/\b(lyrics|letra)\b/i.test(texto)) return false;
  if (/\[.*?\]|\(.*?\)/.test(texto)) return false;
  return true;
}

function extrairDiretorWikipedia(extract) {
  if (!extract) return 'Disponível na Wikipédia';

  const matchPT = extract.match(
    /(?:dirigido\s+por|dire[cç][aã]o\s+(?:de\s+)?|diretor[:\s]+)\s+([A-ZÀ-Ú][A-Za-zÀ-Ú0-9'\-\s]+?)(?=(?:,|\.|\s+e\s+|\s+\(|\s*$))/i
  );
  if (matchPT) {
    let nome = matchPT[1].trim();
    nome = nome.replace(/\s+e\s+.*$/, '').trim();
    if (nome.length > 2) return nome;
  }

  const matchEN = extract.match(
    /(?:directed\s+by|director[:\s]+)\s+([A-Z][A-Za-z0-9'\-\s]+?)(?=(?:,|\.|\s+and\s+|\s+\(|\s*$))/i
  );
  if (matchEN) {
    let nome = matchEN[1].trim();
    nome = nome.replace(/\s+and\s+.*$/, '').trim();
    if (nome.length > 2) return nome;
  }

  return 'Disponível na Wikipédia';
}

async function buscarBrave(query) {
  try {
    const url = `https://search.brave.com/search?q=${encodeURIComponent(query)}`;
    const resp = await fetch(url, {
      headers: {
        'User-Agent': BROWSER_USER_AGENT,
      },
    });
    if (!resp.ok) {
      const errorText = await resp.text().catch(() => 'Unknown error');
      console.error(`[BRAVE] Falhou com status ${resp.status}:`, errorText.substring(0, 300));
      return null;
    }

    const html = await resp.text();
    let texto = html.replace(/<script[^>]*>.*?<\/script>/gi, '');
    texto = texto.replace(/<style[^>]*>.*?<\/style>/gi, '');
    texto = texto.replace(/<[^>]+>/g, '');
    texto = texto.replace(/\s+/g, ' ').trim();
    texto = texto.substring(0, 5000);
    if (texto) {
      console.log(`[BRAVE] OK! ${texto.length} chars obtidos.`);
      return texto;
    }
    return null;
  } catch (err) {
    console.error('[BRAVE] Erro:', err);
    return null;
  }
}

async function buscarCitacoesFilme(nomeFilme) {
  try {
    const query = `"${nomeFilme}" movie quotes memorable lines`;
    const resultado = await buscarBrave(query);
    if (resultado) {
      const frases = [];
      for (const linha of resultado.split('\n')) {
        const citacoes = linha.match(/["""\u201C\u201D]([^""\u201C\u201D]{10,80})["""\u201C\u201D]/g);
        if (citacoes) {
          for (const c of citacoes) {
            const limpa = c.replace(/["""\u201C\u201D]/g, '').trim();
            if (limpa.length > 15 && !frases.includes(limpa)) {
              frases.push(limpa);
            }
            if (frases.length >= 3) break;
          }
        }
        if (frases.length >= 3) break;
      }
      if (frases.length >= 3) return frases.slice(0, 3);
    }
  } catch (err) {
    console.error('[CITACOES] Erro:', err);
  }
  return [];
}

async function buscarLetraMusica(nomeMusica, artista, env) {
  const nomeLimpo = limparTermoMusica(nomeMusica);
  const artistaLimpo = limparTermoMusica(artista) || artista;

  // CAMADA 1: LRCLIB /api/get (letra completa)
  console.log('[LETRA] CAMADA 1: LRCLIB /api/get...');
  try {
    await lrclibThrottle();
    const params = new URLSearchParams({ track_name: nomeLimpo, artist_name: artistaLimpo });
    const resp = await fetch(`${LRCLIB_GET_URL}?${params}`, { headers: lrclibHeaders() });
    
    if (resp.status === 429) {
      const retryAfter = parseInt(resp.headers.get('Retry-After') || '2', 10);
      console.log(`[LETRA] LRCLIB rate limited. Aguardando ${retryAfter}s...`);
      await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));
      const retryResp = await fetch(`${LRCLIB_GET_URL}?${params}`, { headers: lrclibHeaders() });
      if (retryResp.ok) {
        const data = await retryResp.json();
        if (data?.plainLyrics) {
          console.log('[LETRA] LRCLIB /api/get: Letra encontrada (apos retry)!');
          return data.plainLyrics.substring(0, 5000);
        }
      }
    } else if (resp.ok) {
      const data = await resp.json();
      if (data?.plainLyrics) {
        console.log('[LETRA] LRCLIB /api/get: Letra encontrada!');
        return data.plainLyrics.substring(0, 5000);
      }
    }
  } catch (err) {
    console.error('[LETRA] LRCLIB /api/get erro:', err);
  }

  // CAMADA 1b: LRCLIB /api/search (fallback)
  console.log('[LETRA] CAMADA 1b: LRCLIB /api/search (fallback)...');
  try {
    await lrclibThrottle();
    const paramsSearch = new URLSearchParams({ track_name: nomeLimpo, artist_name: artistaLimpo });
    const respSearch = await fetch(`${LRCLIB_SEARCH_URL}?${paramsSearch}`, { headers: lrclibHeaders() });
    
    if (respSearch.status === 429) {
      const retryAfter = parseInt(respSearch.headers.get('Retry-After') || '2', 10);
      console.log(`[LETRA] LRCLIB search rate limited. Aguardando ${retryAfter}s...`);
      await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));
      const retryResp = await fetch(`${LRCLIB_SEARCH_URL}?${paramsSearch}`, { headers: lrclibHeaders() });
      if (retryResp.ok) {
        const dados = await retryResp.json();
        if (Array.isArray(dados) && dados.length > 0 && dados[0].plainLyrics) {
          console.log('[LETRA] LRCLIB /api/search: Letra encontrada (apos retry)!');
          return dados[0].plainLyrics.substring(0, 5000);
        }
      }
    } else if (respSearch.ok) {
      const dados = await respSearch.json();
      if (Array.isArray(dados) && dados.length > 0 && dados[0].plainLyrics) {
        console.log('[LETRA] LRCLIB /api/search: Letra encontrada!');
        return dados[0].plainLyrics.substring(0, 5000);
      }
    }
  } catch (err) {
    console.error('[LETRA] LRCLIB /api/search erro:', err);
  }

  console.log('[LETRA] CAMADA 2: Genius...');
  const geniusKey = env?.GENIUS_API_KEY;
  if (geniusKey) {
    try {
      const query = encodeURIComponent(`${nomeLimpo} ${artistaLimpo}`);
      const resp = await fetch(`https://api.genius.com/search?q=${query}`, {
        headers: {
          Authorization: `Bearer ${geniusKey}`,
          'User-Agent': MOOVIBE_USER_AGENT,
        },
      });
      if (!resp.ok) {
        const errorText = await resp.text().catch(() => 'Unknown error');
        console.error(`[GENIUS] Falhou com status ${resp.status}:`, errorText.substring(0, 300));
        return null;
      }
      const dados = await resp.json();
      const hit = dados?.response?.hits?.[0]?.result;
      if (hit?.url) {
        const pageResp = await fetch(hit.url, {
          headers: { 'User-Agent': MOOVIBE_USER_AGENT },
        });
        if (!pageResp.ok) {
          const errorText = await pageResp.text().catch(() => 'Unknown error');
          console.error(`[GENIUS] Página falhou com status ${pageResp.status}:`, errorText.substring(0, 300));
          return null;
        }
        const html = await pageResp.text();
        const lyricsMatch = html.match(/<div[^>]*class="lyrics"[^>]*>([\s\S]*?)<\/div>/i);
        if (lyricsMatch) {
          console.log('[LETRA] Genius: Letra encontrada!');
          return limparHTML(lyricsMatch[1]).substring(0, 5000);
        }
      }
    } catch (err) {
      console.error('[LETRA] Genius erro:', err);
    }
  }

  console.log('[LETRA] CAMADA 3: Brave Search...');
  const letraBrave = await buscarBrave(`${nomeLimpo} ${artistaLimpo} lyrics`);
  if (letraBrave) {
    console.log('[LETRA] Brave Search: Letra encontrada!');
    return letraBrave.substring(0, 5000);
  }

  console.log('[LETRA] Todas as camadas falharam.');
  return null;
}

async function buscarContextoMusica(nomeMusica, artista, env, letra, lang = 'en') {
  const nomeLimpo = limparTermoMusica(nomeMusica);
  const artistaLimpo = limparTermoMusica(artista) || artista;
  const termoBusca = `${nomeLimpo} ${artistaLimpo}`;

  console.log('[CONTEXTO] CAMADA 1: Genius...');
  if (env.GENIUS_API_KEY) {
    try {
      const query = encodeURIComponent(`${nomeLimpo} ${artistaLimpo}`);
      const resp = await fetch(`https://api.genius.com/search?q=${query}`, {
        headers: {
          Authorization: `Bearer ${env.GENIUS_API_KEY}`,
          'User-Agent': MOOVIBE_USER_AGENT,
        },
      });
      if (!resp.ok) {
        const errorText = await resp.text().catch(() => 'Unknown error');
        console.error(`[GENIUS] Falhou com status ${resp.status}:`, errorText.substring(0, 300));
        return null;
      }
      const dados = await resp.json();
      const hit = dados?.response?.hits?.[0]?.result;
      if (hit?.url) {
        const pageResp = await fetch(hit.url, {
          headers: { 'User-Agent': MOOVIBE_USER_AGENT },
        });
        if (!pageResp.ok) {
          const errorText = await pageResp.text().catch(() => 'Unknown error');
          console.error(`[GENIUS] Página falhou com status ${pageResp.status}:`, errorText.substring(0, 300));
          return null;
        }
        const html = await pageResp.text();
        const metaMatch = html.match(/<meta\s+[^>]*name="description"[^>]*content="([^"]+)"/i);
        if (metaMatch && metaMatch[1]) {
          console.log('[CONTEXTO] Genius: Descricao encontrada!');
          return metaMatch[1].substring(0, 2000);
        }
      }
    } catch (err) {
      console.error('[CONTEXTO] Genius erro:', err);
    }
  }

  console.log('[CONTEXTO] CAMADA 2: Brave Search...');
  try {
    const ctxBrave = await buscarBrave(`significado da musica ${nomeLimpo} ${artistaLimpo}`);
    if (ctxBrave && validarContexto(ctxBrave, letra)) {
      console.log('[CONTEXTO] Brave Search: Contexto encontrado!');
      return ctxBrave.substring(0, 2000);
    }
  } catch (err) {
    console.error('[CONTEXTO] Brave Search erro:', err);
  }

  console.log('[CONTEXTO] CAMADA 3: Wikipedia...');
  const wikiApiCtx = lang === 'pt' ? WIKIPEDIA_PT_API : WIKIPEDIA_EN_API;
  try {
    const url = `${wikiApiCtx}${encodeURIComponent(termoBusca)}`;
    const resp = await fetch(url, {
      headers: { 'User-Agent': MOOVIBE_USER_AGENT },
    });
    if (!resp.ok) {
      const errorText = await resp.text().catch(() => 'Unknown error');
      console.error(`[WIKIPEDIA] Falhou com status ${resp.status}:`, errorText.substring(0, 300));
      return null;
    }
    const dados = await resp.json();
    if (dados.type !== 'disambiguation' && dados.extract) {
      console.log('[CONTEXTO] Wikipedia: Contexto encontrado!');
      return dados.extract.substring(0, 2000);
    }
  } catch (err) {
    console.error('[CONTEXTO] Wikipedia erro:', err);
  }

  console.log('[CONTEXTO] CAMADA 4: OpenRouter (mini-IA)...');
  if (env.OPENROUTER_API_KEY) {
    try {
      const idiomaPrompt = lang === 'pt' ? 'em português' : 'in English';
      const prompt = `Pesquise na web a história real, inspiração e o significado da música '${nomeLimpo}' de '${artistaLimpo}'. Retorne apenas um parágrafo curto ${idiomaPrompt} explicando o contexto.`;
      const payload = {
        model: 'google/gemini-2.5-flash:free',
        temperature: 0.3,
        max_tokens: 300,
        messages: [{ role: 'user', content: prompt }],
      };

      console.log('\n[DEBUG] Enviando Payload para OpenRouter (CONTEXTO):', JSON.stringify(payload, null, 2));
      console.log('[CONTEXTO] Tentando google/gemini-2.5-flash:free...');
      const resp = await fetch(OPENROUTER_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://moovibe.pages.dev',
          'X-Title': 'Moovibe',
        },
        body: JSON.stringify(payload),
      });

      if (!resp.ok) {
        const errorText = await resp.text().catch(() => 'Unknown error');
        console.error(`[OPENROUTER CONTEXTO] Falhou com status ${resp.status}:`, errorText.substring(0, 300));
        return null;
      }

      const dados = await resp.json();
      const aiContent = dados?.choices?.[0]?.message?.content;
      if (!aiContent) {
        console.error('[OPENROUTER CONTEXTO] OpenRouter não retornou escolhas válidas.');
        return null;
      }
      const texto = aiContent.trim();
      console.log(`[CONTEXTO] Resposta Bruta: ${texto.substring(0, 300)}...`);
      if (texto && validarContexto(texto, letra)) {
        console.log('[CONTEXTO] OpenRouter: Contexto gerado via IA!');
        return texto.substring(0, 2000);
      }
    } catch (err) {
      console.error('[CONTEXTO] OpenRouter erro:', err);
    }
  }

  console.log('[CONTEXTO] Todas as camadas falharam.');
  return null;
}

async function buscarCapaMusica(nomeMusica, artista) {
  try {
    const query = encodeURIComponent(`${nomeMusica} ${artista}`);
    const url = `https://itunes.apple.com/search?term=${query}&entity=song&limit=1`;
    const resp = await fetch(url, {
      headers: { 'User-Agent': MOOVIBE_USER_AGENT },
    });
    if (!resp.ok) {
      const errorText = await resp.text().catch(() => 'Unknown error');
      console.error(`[APPLE MUSIC] Falhou com status ${resp.status}:`, errorText.substring(0, 300));
      return null;
    }
    const dados = await resp.json();
    const track = dados?.results?.[0];
    if (!track?.artworkUrl100) return null;
    return track.artworkUrl100.replace('100x100bb', '1000x1000bb');
  } catch (err) {
    console.error('[APPLE MUSIC] Erro:', err);
    return null;
  }
}
