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

// Modelo OpenRouter free (atualizado periodicamente)
// Verifique filtro :free em https://openrouter.ai/models
// IMPORTANTE: "openrouter/free" é o auto-router oficial do OpenRouter e sempre seleciona
// automaticamente um modelo gratuito disponível no momento da chamada, evitando quebras
// quando IDs :free são descontinuados. Isso garante custo zero sempre (nunca cai para um
// modelo pago). Se no futuro quiser fixar um modelo específico por controle de qualidade,
// confira antes a lista atual em openrouter.ai/models com o filtro Price = Free, pois IDs
// hardcoded podem ser descontinuados sem aviso.
const OPENROUTER_MODEL = 'openrouter/free';

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
  const matchPT = extract.match(/(?:dirigido\s+por|dire[cç][aã]o\s+(?:de\s+)?|diretor[:\s]+)\s+([A-ZÀ-Ú][A-Za-zÀ-Ú0-9'\-\s]+?)(?=(?:,|\.|\s+e\s+|\s+\(|\s*$))/i);
  if (matchPT) {
    let nome = matchPT[1].trim();
    nome = nome.replace(/\s+e\s+.*$/, '').trim();
    if (nome.length > 2) return nome;
  }
  const matchEN = extract.match(/(?:directed\s+by|director[:\s]+)\s+([A-Z][A-Za-z0-9'\-\s]+?)(?=(?:,|\.|\s+and\s+|\s+\(|\s*$))/i);
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
        headers: { Authorization: `Bearer ${geniusKey}`, 'User-Agent': MOOVIBE_USER_AGENT },
      });
      if (!resp.ok) {
        const errorText = await resp.text().catch(() => 'Unknown error');
        console.error(`[GENIUS] Falhou com status ${resp.status}:`, errorText.substring(0, 300));
        return null;
      }
      const dados = await resp.json();
      const hit = dados?.response?.hits?.[0]?.result;
      if (hit?.url) {
        const pageResp = await fetch(hit.url, { headers: { 'User-Agent': MOOVIBE_USER_AGENT } });
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
  return "";
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
        headers: { Authorization: `Bearer ${env.GENIUS_API_KEY}`, 'User-Agent': MOOVIBE_USER_AGENT },
      });
      if (!resp.ok) {
        const errorText = await resp.text().catch(() => 'Unknown error');
        console.error(`[GENIUS] Falhou com status ${resp.status}:`, errorText.substring(0, 300));
        return null;
      }
      const dados = await resp.json();
      const hit = dados?.response?.hits?.[0]?.result;
      if (hit?.url) {
        const pageResp = await fetch(hit.url, { headers: { 'User-Agent': MOOVIBE_USER_AGENT } });
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
    const resp = await fetch(url, { headers: { 'User-Agent': MOOVIBE_USER_AGENT } });
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
        model: OPENROUTER_MODEL,
        temperature: 0.3,
        max_tokens: 300,
        messages: [{ role: 'user', content: prompt }],
      };
      console.log('\n[DEBUG] Enviando Payload para OpenRouter (CONTEXTO):', JSON.stringify(payload, null, 2));
      console.log(`[CONTEXTO] Tentando modelo: ${OPENROUTER_MODEL}...`);
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

async function obterRecomendacaoIA(nomeMusica, artista, letra, contextoExtra, apiKey, filmesExcluidosGlobais = [], filmesExcluidosMusica = [], lang = 'en') {
  if (!apiKey) return null;

  let regraGlobal = '';
  if (Array.isArray(filmesExcluidosGlobais) && filmesExcluidosGlobais.length > 0) {
    regraGlobal = `REGRA DE DIVERSIFICAÇÃO GLOBAL: NÃO recomende nenhum destes filmes sob nenhuma hipótese: ${filmesExcluidosGlobais.join(', ')}.\n\n`;
  }
  let regraEspecifica = '';
  if (Array.isArray(filmesExcluidosMusica) && filmesExcluidosMusica.length > 0) {
    regraEspecifica = `REGRA ESPECÍFICA DA MÚSICA: Para esta música específica, os seguintes filmes já foram recomendados recentemente e estão PROIBIDOS de serem repetidos: ${filmesExcluidosMusica.join(', ')}. Escolha algo novo.\n\n`;
  }

  const idiomaJustificativa = lang === 'pt' ? 'em português, até 4 frases' : 'in English, up to 4 sentences';
  const promptSistema = `Voce e um curador de cinema genial. O usuario vai te passar uma musica e voce deve sugerir EXATAMENTE UM filme que compartilhe exatamente da mesma atmosfera emocional, paleta de cores subtendida, ritmo psicologico ou alma lirica dessa musica. Nao se limite a conexoes obvias. Pense na vibe.\n\n${regraGlobal}${regraEspecifica}CRITICO: Voce DEVE sugerir um filme REAL existente no banco de dados do TMDb. PROIBIDO inventar titulos de filmes. Use APENAS o titulo original ou oficial em ingles/portugues. NAO use caracteres asiaticos (como chines, japones, coreano) a menos que seja um filme autenticamente asiatico com titulo original nesses caracteres. Se nao tiver certeza, escolha um filme classico e bem conhecido.\n\nREGRA ABSOLUTA: No campo 'filme', retorne APENAS o nome comercial puro do filme (em ingles ou portugues). E terminantemente PROIBIDO embutir o ano ao lado do nome do filme nesse campo. Por exemplo, retorne 'The Great Gatsby' e NUNCA 'The Great Gatsby 2013'. O ano de lancamento deve habitar estritamente e apenas o campo 'ano' do JSON.\n\nTAREFA EXTRA: Usando a letra da musica fornecida, extraia 3 trechos curtos (cada um entre 15 e 80 caracteres) que melhor capturem a vibe e a conexao emocional com o filme sugerido. Retorne esses trechos no campo 'citacoes' como um array de 3 strings.\n\nSua resposta DEVE ser estritamente um formato JSON valido (sem qualquer tipo de formatacao markdown, apenas as chaves brutas). O JSON deve conter as seguintes chaves exatas:\n{\n  "filme": "Nome exato do filme (de preferencia o titulo original em ingles ou o mais conhecido, SEM o ano)",\n  "ano": "Ano de lancamento do filme sugerido (Apenas os 4 digitos numericos, ex: 2002)",\n  "justificativa": "Uma explicacao poetica, profunda e envolvente (${idiomaJustificativa}) conectando sentimentos da musica/letra com o filme.",\n  "citacoes": ["Trecho 1 da letra que conecta com o filme", "Trecho 2 da letra que conecta com o filme", "Trecho 3 da letra que conecta com o filme"],\n  "vibe_title": "Um titulo CURTO e impactante em MAIUSCULAS (2-3 palavras) que capture a vibe, ex: 'OPERATIC CHAOS' ou 'MELANCHOLIC DREAM'",\n  "tags": ["Array de 4 tags em MAIUSCULAS descrevendo a vibe, ex: GRANDIOSE, TRAGICOMIC, CATHARTIC, MOSAIC"]\n}`;

  let conteudoUsuario = `Musica: '${nomeMusica}' do artista '${artista}'.\n`;
  if (letra) {
    conteudoUsuario += `Use a letra da musica para capturar a essencia poetica profunda:\n${letra}\n\n`;
  } else {
    conteudoUsuario += "(Nao encontramos a letra no banco de dados, baseie-se no tema geral da musica).\nComo nao temos a letra, gere 3 citacoes genericas sobre cinema ou inspiracao que combinem com o filme.\n\n";
  }
  if (contextoExtra) {
    conteudoUsuario += `Contexto historico, significado e fatos adicionais sobre a musica para te ajudar na escolha:\n${contextoExtra}\n`;
  }

  try {
    const body = {
      model: OPENROUTER_MODEL,
      temperature: 0.3,
      messages: [
        { role: 'system', content: promptSistema },
        { role: 'user', content: conteudoUsuario },
      ],
    };
    console.log('\n[DEBUG] Enviando Payload para OpenRouter (RECOMENDACAO):', JSON.stringify(body, null, 2));
    console.log(`[OPENROUTER] Tentando modelo: ${OPENROUTER_MODEL}`);
    const resp = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://moovibe.pages.dev',
        'X-Title': 'Moovibe',
      },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      const errorText = await resp.text().catch(() => 'Unknown error');
      console.error(`[OPENROUTER RECOMENDACAO] Falhou com status ${resp.status}:`, errorText.substring(0, 300));
      return null;
    }
    const dados = await resp.json();
    const aiContent = dados?.choices?.[0]?.message?.content;
    if (!aiContent) {
      console.error('[OPENROUTER RECOMENDACAO] OpenRouter não retornou escolhas válidas. Payload:', JSON.stringify(dados).substring(0, 500));
      return null;
    }
    let textoIA = aiContent.trim();
    console.log(`[OPENROUTER] Resposta Bruta:\n${textoIA}\n`);
    if (!textoIA) return null;
    textoIA = textoIA.replace(/```json/g, '').replace(/```/g, '').trim();
    if (/User Safety/i.test(textoIA) || /\bsafe\b/i.test(textoIA)) {
      console.error('[OPENROUTER] Resposta de seguranca detectada.');
      return null;
    }
    const parsed = extrairJSON(textoIA);
    if (parsed && typeof parsed === 'object') {
      parsed.filme = sanitizarTituloFilme(parsed.filme || parsed.filme_sugerido || '');
      if (!parsed.citacoes || !Array.isArray(parsed.citacoes) || parsed.citacoes.length < 3) {
        const quotes = extrairQuotesDaLetra(letra, 3);
        parsed.citacoes = quotes.length >= 3 ? quotes : [];
      }
      return parsed;
    }
    console.error('[OPENROUTER] Nenhum JSON encontrado.');
    return null;
  } catch (err) {
    console.error('[OPENROUTER] Erro na requisicao:', err);
    return null;
  }
}

async function obterDetalhesTMDB(nomeFilme, apiKey, ano, lang = 'en') {
  if (!apiKey) return null;
  try {
    const tmdbLang = lang === 'pt' ? 'pt-BR' : 'en-US';
    const paramsBusca = new URLSearchParams({ api_key: apiKey, query: nomeFilme, language: tmdbLang });
    if (ano) paramsBusca.set('primary_release_year', ano);
    const respBusca = await fetch(`${TMDB_BUSCA_URL}?${paramsBusca}`, { headers: { 'User-Agent': MOOVIBE_USER_AGENT } });
    if (!respBusca.ok) {
      const errorText = await respBusca.text().catch(() => 'Unknown error');
      console.error(`[TMDB] Busca falhou com status ${respBusca.status}:`, errorText.substring(0, 300));
      return null;
    }
    const dadosBusca = await respBusca.json();
    const filmes = dadosBusca?.results;
    if (!filmes || filmes.length === 0) return null;

    const filmeBasico = filmes[0];
    const filmeId = filmeBasico.id;
    const paramsDetalhes = new URLSearchParams({ api_key: apiKey, language: tmdbLang });
    const respDetalhes = await fetch(`${TMDB_BASE_URL}/${filmeId}?${paramsDetalhes}`, { headers: { 'User-Agent': MOOVIBE_USER_AGENT } });
    const detalhes = respDetalhes.ok ? await respDetalhes.json() : {};
    let diretor = 'Nao encontrado';
    const respCreditos = await fetch(`${TMDB_BASE_URL}/${filmeId}/credits?api_key=${apiKey}&language=${tmdbLang}`, { headers: { 'User-Agent': MOOVIBE_USER_AGENT } });
    if (respCreditos.ok) {
      const creditos = await respCreditos.json();
      for (const pessoa of (creditos?.crew || [])) {
        if (pessoa.job === 'Director') { diretor = pessoa.name; break; }
      }
    }
    const respImagens = await fetch(`${TMDB_BASE_URL}/${filmeId}/images?api_key=${apiKey}&include_image_language=en,null`, { headers: { 'User-Agent': MOOVIBE_USER_AGENT } });
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
        const idioma = (poster.iso_639_1 || '').toLowerCase();
        if (idioma === 'en' || idioma === '') {
          posterUrl = `https://image.tmdb.org/t/p/w500${poster.file_path}`;
          break;
        }
      }
    }
    if (!posterUrl && filmeBasico.poster_path) posterUrl = `https://image.tmdb.org/t/p/w500${filmeBasico.poster_path}`;
    const tagline = (detalhes && typeof detalhes === 'object' && detalhes.tagline) ? detalhes.tagline.trim() : '';
    return {
      id_tmdb: filmeId,
      titulo_pt: filmeBasico.title,
      titulo_original: filmeBasico.original_title,
      ano: (filmeBasico.release_date || '----').substring(0, 4),
      sinopse: filmeBasico.overview || 'Sem sinopse disponivel.',
      poster: posterUrl,
      diretor,
      imdb_id: detalhes?.imdb_id || null,
      cenas,
      tagline,
    };
  } catch (err) {
    console.error('[TMDB] Erro:', err);
    return null;
  }
}

async function buscarDadosFilmeFallback(nomeFilme, ano, env, lang = 'en') {
  const wikiApi = lang === 'pt' ? WIKIPEDIA_PT_API : WIKIPEDIA_EN_API;
  const wikiLabel = lang === 'pt' ? 'Wikipedia PT' : 'Wikipedia EN';
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
      const resp = await fetch(url, { headers: { 'User-Agent': MOOVIBE_USER_AGENT } });
      if (!resp.ok) {
        const errorText = await resp.text().catch(() => 'Unknown error');
        console.error(`[WIKIPEDIA] Falhou com status ${resp.status}:`, errorText.substring(0, 300));
        continue;
      }
      const dados = await resp.json();
      if (dados.type === 'disambiguation') continue;
      if (dados.extract) {
        const sinopse = extrairDuasPrimeirasFrases(dados.extract);
        const diretor = extrairDiretorWikipedia(dados.extract);
        let posterUrl = null;
        if (dados.originalimage && dados.originalimage.source) posterUrl = dados.originalimage.source;
        console.log('[FILME FALLBACK] Wikipedia: Dados encontrados!');
        return { sinopse: sinopse.substring(0, 2000), diretor, poster: posterUrl };
      }
    }
  } catch (err) {
    console.error('[FILME FALLBACK] Wikipedia erro:', err);
  }
  console.log('[FILME FALLBACK] CAMADA 2: Brave Search...');
  try {
    let query = lang === 'pt' ? `${nomeFilme} filme enredo sinopse` : `${nomeFilme} movie plot synopsis`;
    if (ano) query = `${nomeFilme} ${ano} ${lang === 'pt' ? 'filme enredo' : 'movie plot synopsis'}`;
    const resultado = await buscarBrave(query);
    if (resultado) {
      console.log('[FILME FALLBACK] Brave Search: Dados encontrados!');
      return { sinopse: resultado.substring(0, 2000), diretor: 'Disponível na Web', poster: null };
    }
  } catch (err) {
    console.error('[FILME FALLBACK] Brave Search erro:', err);
  }
  console.log('[FILME FALLBACK] CAMADA 3: OpenRouter (fallback final)...');
  if (env.OPENROUTER_API_KEY) {
    try {
      const idiomaPrompt = lang === 'pt' ? 'em português' : 'in English';
      const prompt = `Generate a brief movie synopsis based on the search context. Return strictly JSON with: 'sinopse' (${idiomaPrompt}), 'diretor', 'poster' (URL or null).`;
      const payload = {
        model: OPENROUTER_MODEL,
        temperature: 0.3,
        max_tokens: 500,
        messages: [{ role: 'user', content: prompt }],
      };
      console.log('\n[DEBUG] Enviando Payload para OpenRouter (FILME FALLBACK):', JSON.stringify(payload, null, 2));
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
        console.error(`[OPENROUTER FILME FALLBACK] Falhou com status ${resp.status}:`, errorText.substring(0, 300));
        return null;
      }
      const dados = await resp.json();
      const aiContent = dados?.choices?.[0]?.message?.content;
      if (!aiContent) {
        console.error('[OPENROUTER FILME FALLBACK] OpenRouter não retornou escolhas válidas.');
        return null;
      }
      const texto = aiContent.trim();
      console.log(`[FILME FALLBACK] OpenRouter resposta bruta: ${texto.substring(0, 300)}...`);
      const parsed = extrairJSON(texto);
      if (parsed && typeof parsed === 'object') {
        let poster = parsed.poster;
        if (poster && !String(poster).startsWith('http')) poster = null;
        return {
          sinopse: parsed.sinopse || 'Sinopse indisponível.',
          diretor: parsed.diretor || 'Não encontrado',
          poster,
        };
      }
      return { sinopse: texto.substring(0, 2000), diretor: 'Encontrado via IA', poster: null };
    } catch (err) {
      console.error('[FILME FALLBACK] OpenRouter erro:', err);
    }
  }
  console.log('[FILME FALLBACK] Todas as camadas falharam.');
  return null;
}

function limparHTML(texto) {
  const entidades = { amp: '&', lt: '<', gt: '>', quot: '"', '#x27': "'", '#x2F': '/' };
  return texto
    .replace(/<[^>]*>/g, '')
    .replace(/&([a-zA-Z#0-9]+);/g, (match, entidade) => entidades[entidade] || '')
    .replace(/&#(\d+);/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  if (request.method === 'GET' && url.pathname.includes('/recommend-history')) {
    const items = await listHistory(env);
    return jsonResponse({ items });
  }
  if (request.method === 'GET' && url.pathname.includes('/recommend')) {
    const kv = env.MOOVIBE_DB;
    if (!kv) return jsonResponse([]);
    const slugParam = url.searchParams.get('slug');
    if (slugParam) {
      try {
        const shareData = await kv.get('share:' + slugParam, 'json');
        if (shareData) return jsonResponse(shareData);
        return jsonResponse({ error: { message: 'Link não encontrado ou expirado.' } }, 404);
      } catch (err) {
        console.error('[KV] Falha ao buscar slug:', err);
        return jsonResponse({ error: { message: 'Erro ao buscar link compartilhado.' } }, 500);
      }
    }
    try {
      const listResult = await kv.list({ prefix: 'history:', limit: 20 });
      const keys = listResult.keys || [];
      if (keys.length === 0) return jsonResponse([]);
      const recommendations = await Promise.all(
        keys.map(async (key) => {
          try {
            const raw = await kv.get(key.name, 'json');
            return raw || null;
          } catch (err) {
            console.error('[KV] Falha ao ler chave:', err);
            return null;
          }
        })
      );
      return jsonResponse(recommendations.filter((item) => item !== null));
    } catch (err) {
      console.error('[KV] Falha ao listar histórico:', err);
      return jsonResponse([]);
    }
  }
  if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });

  try {
    const body = await request.json();
    const { nome_musica, artista } = body;
    const lang = body.lang === 'pt' ? 'pt' : 'en';
    if (!nome_musica) return jsonResponse({ error: { message: 'Nome da música é obrigatório.' } }, 400);

    console.log('\n=== INICIANDO PIPELINE ===');
    const letra = await buscarLetraMusica(nome_musica, artista, env);
    let contextoExtra = await buscarContextoMusica(nome_musica, artista, env, letra, lang);
    if (!validarContexto(contextoExtra, letra)) contextoExtra = null;

    const historico = await listHistory(env);
    const filmesExcluidosGlobais = [];
    const filmesExcluidosMusica = [];
    if (Array.isArray(historico)) {
      for (const item of historico) {
        const movieTitle = item?.movie?.title;
        if (!movieTitle || typeof movieTitle !== 'string') continue;
        if (!filmesExcluidosGlobais.includes(movieTitle) && filmesExcluidosGlobais.length < 20) filmesExcluidosGlobais.push(movieTitle);
        const mesmaMusica =
          item?.song?.toLowerCase() === nome_musica.toLowerCase() &&
          (!artista || item?.artist?.toLowerCase() === artista.toLowerCase());
        if (mesmaMusica && !filmesExcluidosMusica.includes(movieTitle) && filmesExcluidosMusica.length < 5) filmesExcluidosMusica.push(movieTitle);
      }
    }
    if (filmesExcluidosGlobais.length > 0) console.log(`[ANTI-REPETICAO] Globais excluidos: ${filmesExcluidosGlobais.join(', ')}`);
    if (filmesExcluidosMusica.length > 0) console.log(`[ANTI-REPETICAO] Especificos da musica excluidos: ${filmesExcluidosMusica.join(', ')}`);

    const recomendacaoIA = await obterRecomendacaoIA(
      nome_musica, artista, letra, contextoExtra, env.OPENROUTER_API_KEY,
      filmesExcluidosGlobais, filmesExcluidosMusica, lang
    );
    if (!recomendacaoIA) {
      console.error('FALHA CRÍTICA: IA não retornou recomendação válida');
      return jsonResponse({ error: { message: 'Não foi possível encontrar a vibe dessa música. Tente novamente ou escolha outra faixa.' } }, 500);
    }
    const nomeFilme = sanitizarTituloFilme(recomendacaoIA.filme || recomendacaoIA.filme_sugerido || '');
    const anoFilme = recomendacaoIA.ano || recomendacaoIA.ano_filme || '';
    const justificativa = recomendacaoIA.justificativa || recomendacaoIA.justificativa_vibe || '';
    const vibeTitle = recomendacaoIA.vibe_title || 'VIBE CINEMATICA';
    const tags = recomendacaoIA.tags || ['UNICO', 'ESSENCIAL'];
    if (!nomeFilme) {
      console.error('FALHA CRÍTICA: IA não retornou nome de filme válido');
      return jsonResponse({ error: { message: 'Não foi possível encontrar a vibe dessa música. Tente novamente ou escolha outra faixa.' } }, 500);
    }

    let dadosFilme = null;
    if (env.TMDB_API_KEY) dadosFilme = await obterDetalhesTMDB(nomeFilme, env.TMDB_API_KEY, anoFilme, lang);
    if (!dadosFilme || !dadosFilme.sinopse || dadosFilme.sinopse === 'Sem sinopse disponivel.') {
      console.log('[FALLBACK ATIVADO: TMDb falhou, usando fallback]');
      const fallback = await buscarDadosFilmeFallback(nomeFilme, anoFilme, env, lang);
      if (fallback) {
        dadosFilme = {
          id_tmdb: null,
          titulo_pt: nomeFilme,
          titulo_original: nomeFilme,
          ano: anoFilme || 'Nao informado',
          sinopse: fallback.sinopse || 'Sinopse indisponivel.',
          poster: fallback.poster || null,
          diretor: fallback.diretor || 'Nao encontrado',
          imdb_id: null,
          cenas: [],
        };
      } else {
        dadosFilme = {
          id_tmdb: null,
          titulo_pt: nomeFilme,
          titulo_original: nomeFilme,
          ano: anoFilme || 'Nao informado',
          sinopse: 'Sinopse indisponivel.',
          poster: null,
          diretor: 'Nao encontrado',
          imdb_id: null,
          cenas: [],
        };
      }
    }

    let quotes = recomendacaoIA.citacoes || [];
    const QUOTES_PADRAO = ['Cinema is magic.', 'Every film is a journey.', 'Lights, camera, action!'];
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

    const coverUrl = await buscarCapaMusica(nome_musica, artista);
    const imdbUrl = dadosFilme?.imdb_id ? `https://www.imdb.com/title/${dadosFilme.imdb_id}/` : `https://www.imdb.com/find?q=${encodeURIComponent(nomeFilme)}`;
    const letterboxdUrl = dadosFilme?.id_tmdb ? `https://letterboxd.com/tmdb/${dadosFilme.id_tmdb}` : `https://letterboxd.com/search/${encodeURIComponent(nomeFilme)}/`;
    const slug = slugify(nomeFilme + '-' + nome_musica);
    const resposta = {
      song: nome_musica,
      artist: artista || '',
      share_slug: slug,
      movie: {
        title: dadosFilme?.titulo_pt || nomeFilme,
        original_title: dadosFilme?.titulo_original || nomeFilme,
        release_year: dadosFilme?.ano || anoFilme || 'Nao informado',
        director: dadosFilme?.diretor || 'Nao encontrado',
        synopsis: dadosFilme?.sinopse || 'Sinopse nao disponivel.',
        poster_url: dadosFilme?.poster || '',
        cover_url: coverUrl || '',
        stills: dadosFilme?.cenas || [],
        quotes,
        ai_explanation: `<p>${justificativa}</p>`,
        vibe_title: vibeTitle,
        tags,
        imdb_url: imdbUrl,
        letterboxd_url: letterboxdUrl,
        tiktok_url: `https://www.tiktok.com/search?q=${encodeURIComponent(nomeFilme + ' edit')}`,
      },
    };
    await storeHistory({ song: nome_musica, artist: artista, movie: resposta.movie }, env);
    await storeShare(slug, resposta, env);
    console.log('\n=== PIPELINE CONCLUÍDA COM SUCESSO ===');
    console.log(`[SHARE] Slug gerado: ${slug}`);
    return jsonResponse(resposta, 200);
  } catch (error) {
    console.error('Pages Function error:', error);
    return jsonResponse({ error: { message: 'Não foi possível encontrar a vibe dessa música. Tente novamente ou escolha outra faixa.' } }, 500);
  }
}

async function storeHistory(payload, env) {
  try {
    const kv = env.MOOVIBE_DB;
    if (!kv) return;
    const key = `history:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
    await kv.put(key, JSON.stringify(payload), { expirationTtl: 60 * 60 * 24 * 30 });
  } catch (err) {
    console.error('[HISTORY] Falha ao salvar:', err);
  }
}

async function storeShare(slug, payload, env) {
  try {
    const kv = env.MOOVIBE_DB;
    if (!kv) return;
    await kv.put('share:' + slug, JSON.stringify(payload), { expirationTtl: 60 * 60 * 24 * 30 });
    console.log(`[SHARE] Salvo no KV: share:${slug}`);
  } catch (err) {
    console.error('[SHARE] Falha ao salvar:', err);
  }
}

async function listHistory(env) {
  try {
    const kv = env.MOOVIBE_DB;
    if (!kv) return [];
    const list = await kv.list({ prefix: 'history:', limit: 100, reverse: true });
    const items = [];
    for (const entry of list.keys || []) {
      const raw = await kv.get(entry.name, 'json');
      if (raw) items.push(raw);
    }
    return items.slice(0, 25);
  } catch (err) {
    console.error('[HISTORY] Falha ao listar:', err);
    return [];
  }
}