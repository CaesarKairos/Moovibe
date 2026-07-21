/**
 * Moovibe - Cloudflare Pages Function
 * 
 * Responde em POST /recommend com orquestração completa:
 *   Letra: LRCLIB → Genius → SearXNG (com rotação)
 *   Contexto: Genius → SearXNG → Wikipedia → OpenRouter (mini-IA)
 *   Filme: TMDb → Wikipedia (poster, diretor limpo, 2 frases) → SearXNG
 */

const LRCLIB_URL = 'https://lrclib.net/api/search';
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const TMDB_BUSCA_URL = 'https://api.themoviedb.org/3/search/movie';
const WIKIPEDIA_PT_API = 'https://pt.wikipedia.org/api/rest_v1/page/summary/';
const WIKIPEDIA_EN_API = 'https://en.wikipedia.org/api/rest_v1/page/summary/';

// Instancias SearXNG para rotacao
const INSTANCIAS_SEARXNG = [
  'https://search.disroot.org/search',
  'https://searx.be/search',
  'https://searx.space/search',
];

// ============================================================
//  HANDLER PRINCIPAL
// ============================================================
export async function onRequest(context) {
  const { request, env } = context;

  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  try {
    const body = await request.json();
    const { nome_musica, artista } = body;

    if (!nome_musica) {
      return jsonResponse({ error: 'nome_musica is required' }, 400);
    }

    // ---- 1. LETRA (LRCLIB → Genius → SearXNG) ----
    const letra = await buscarLetraMusica(nome_musica, artista, env);

    // ---- 2. CONTEXTO (Genius → SearXNG → Wikipedia → OpenRouter mini-IA) ----
    const contextoExtra = await buscarContextoMusica(nome_musica, artista, env);

    // ---- 3. RECOMENDAÇÃO IA ----
    const recomendacaoIA = await obterRecomendacaoIA(
      nome_musica, artista, letra, contextoExtra, env.OPENROUTER_API_KEY
    );

    if (!recomendacaoIA) {
      return jsonResponse({ error: 'Falha ao obter recomendacao da IA' }, 500);
    }

    // Sanitizacao do titulo do filme (remove ano colado)
    const nomeFilme = sanitizarTituloFilme(
      recomendacaoIA.filme || recomendacaoIA.filme_sugerido || ''
    );
    const anoFilme = recomendacaoIA.ano || recomendacaoIA.ano_filme || '';
    const justificativa = recomendacaoIA.justificativa || recomendacaoIA.justificativa_vibe || '';
    const vibeTitle = recomendacaoIA.vibe_title || 'VIBE CINEMATICA';
    const tags = recomendacaoIA.tags || ['UNICO', 'ESSENCIAL'];

    if (!nomeFilme) {
      return jsonResponse({ error: 'IA nao retornou um nome de filme valido' }, 500);
    }

    // ---- 4. DADOS DO FILME (TMDb → Wikipedia → SearXNG) ----
    let dadosFilme = null;
    if (env.TMDB_API_KEY) {
      dadosFilme = await obterDetalhesTMDB(nomeFilme, env.TMDB_API_KEY);
    }

    if (!dadosFilme || !dadosFilme.sinopse || dadosFilme.sinopse === 'Sem sinopse disponivel.') {
      const fallback = await buscarDadosFilmeFallback(nomeFilme, anoFilme);
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

    // ---- 5. BUSCAR CITACOES ----
    const quotes = await buscarCitacoesFilme(nomeFilme);

    // ---- 6. RESPOSTA ----
    const resposta = {
      song: nome_musica,
      artist: artista || '',
      movie: {
        title: dadosFilme?.titulo_pt || nomeFilme,
        original_title: dadosFilme?.titulo_original || nomeFilme,
        release_year: dadosFilme?.ano || anoFilme || 'Nao informado',
        director: dadosFilme?.diretor || 'Nao encontrado',
        synopsis: dadosFilme?.sinopse || 'Sinopse nao disponivel.',
        poster_url: dadosFilme?.poster || '',
        stills: dadosFilme?.cenas || [],
        quotes: quotes,
        ai_explanation: `<p>${justificativa}</p>`,
        vibe_title: vibeTitle,
        tags: tags,
        imdb_url: dadosFilme?.imdb_id
          ? `https://www.imdb.com/title/${dadosFilme.imdb_id}/`
          : `https://www.imdb.com/find?q=${encodeURIComponent(nomeFilme)}`,
        letterboxd_url: dadosFilme?.id_tmdb
          ? `https://letterboxd.com/tmdb/${dadosFilme.id_tmdb}`
          : `https://letterboxd.com/search/${encodeURIComponent(nomeFilme)}/`,
        tiktok_url: `https://www.tiktok.com/search?q=${encodeURIComponent(nomeFilme + ' edit')}`,
      },
    };

    return jsonResponse(resposta, 200);
  } catch (error) {
    console.error('Pages Function error:', error);
    return jsonResponse({ error: 'Erro interno do servidor' }, 500);
  }
}

// ============================================================
//  HELPERS
// ============================================================
function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
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

function extrairDuasPrimeirasFrases(texto) {
  if (!texto) return '';
  const textoLimpo = texto.replace(/\s+/g, ' ').trim();
  const frases = textoLimpo.split(/(?<=[.!?])\s+/).filter(Boolean);
  if (frases.length >= 2) {
    return `${frases[0]} ${frases[1]}`;
  }
  if (frases.length === 1) {
    return frases[0];
  }
  return textoLimpo.substring(0, 500);
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

// ============================================================
//  BUSCA GENERICA: SearXNG (COM ROTACAO E VALIDACAO)
// ============================================================
async function buscarSearXNG(query, maxResults = 3) {
  for (const instancia of INSTANCIAS_SEARXNG) {
    try {
      const params = new URLSearchParams({
        q: query,
        format: 'json',
        language: 'en',
        categories: 'general',
      });
      const url = `${instancia}?${params}`;
      const resp = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Moovibe/1.0)' },
      });

      const contentType = (resp.headers.get('Content-Type') || '').toLowerCase();
      if (!resp.ok) {
        console.log(`[SEARXNG] Instancia ${instancia} falhou (status ${resp.status}, type ${contentType}).`);
        continue;
      }

      if (!contentType.includes('application/json')) {
        const texto = await resp.text();
        console.log(`[SEARXNG] Instancia ${instancia} retornou ${contentType || 'sem content-type'}: ${texto.substring(0, 200)}`);
        continue;
      }

      const dados = await resp.json();
      const resultados = dados?.results || [];
      if (resultados.length === 0) continue;

      const snippets = [];
      for (const r of resultados.slice(0, maxResults)) {
        const snippet = r.content || r.title || r.snippet || '';
        if (snippet) snippets.push(snippet);
      }
      if (snippets.length > 0) {
        console.log(`[SEARXNG] Instancia ${instancia} OK!`);
        return snippets.join('\n\n').substring(0, 3000);
      }
    } catch (err) {
      console.log(`[SEARXNG] Instancia ${instancia} erro: ${err.message}.`);
      continue;
    }
  }
  return null;
}

// ============================================================
//  BUSCA DE CITACOES DO FILME (SearXNG)
// ============================================================
async function buscarCitacoesFilme(nomeFilme) {
  try {
    const query = `"${nomeFilme}" movie quotes`;
    const resultado = await buscarSearXNG(query, 5);
    if (resultado) {
      const frases = [];
      for (const linha of resultado.split('\n')) {
        // Procura por trechos entre aspas simples ou duplas
        const citacoes = linha.match(/"([^"]{10,80})"/g);
        if (citacoes) {
          for (const c of citacoes) {
            const limpa = c.replace(/"/g, '').trim();
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
  return ['Cinema is magic.', 'Every film is a journey.', 'Lights, camera, action!'];
}

// ============================================================
//  1. LETRA — LRCLIB → Genius → SearXNG
// ============================================================
async function buscarLetraMusica(nomeMusica, artista, env) {
  const nomeLimpo = limparTermoMusica(nomeMusica);
  const artistaLimpo = limparTermoMusica(artista) || artista;

  // CAMADA 1: LRCLIB
  console.log('[LETRA] CAMADA 1: LRCLIB...');
  try {
    const params = new URLSearchParams({ track_name: nomeLimpo, artist_name: artistaLimpo });
    const resp = await fetch(`${LRCLIB_URL}?${params}`);
    if (resp.ok) {
      const dados = await resp.json();
      if (Array.isArray(dados) && dados.length > 0 && dados[0].plainLyrics) {
        console.log('[LETRA] LRCLIB: Letra encontrada!');
        return dados[0].plainLyrics;
      }
    }
  } catch (err) {
    console.error('[LETRA] LRCLIB erro:', err);
  }

  // CAMADA 2: Genius (letra)
  console.log('[LETRA] CAMADA 2: Genius...');
  const geniusKey = env?.GENIUS_API_KEY;
  if (geniusKey) {
    try {
      const query = encodeURIComponent(`${nomeLimpo} ${artistaLimpo}`);
      const resp = await fetch(`https://api.genius.com/search?q=${query}`, {
        headers: { Authorization: `Bearer ${geniusKey}` },
      });
      if (resp.ok) {
        const dados = await resp.json();
        const hit = dados?.response?.hits?.[0]?.result;
        if (hit?.url) {
          const pageResp = await fetch(hit.url, {
            headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Moovibe/1.0)' },
          });
          if (pageResp.ok) {
            const html = await pageResp.text();
            const lyricsMatch = html.match(/<div[^>]*class="lyrics"[^>]*>([\s\S]*?)<\/div>/i);
            if (lyricsMatch) {
              console.log('[LETRA] Genius: Letra encontrada!');
              return limparHTML(lyricsMatch[1]).substring(0, 5000);
            }
          }
        }
      }
    } catch (err) {
      console.error('[LETRA] Genius erro:', err);
    }
  }

  // CAMADA 3: SearXNG (com rotacao)
  console.log('[LETRA] CAMADA 3: SearXNG...');
  const letraSearXNG = await buscarSearXNG(`${nomeLimpo} ${artistaLimpo} lyrics`);
  if (letraSearXNG) {
    console.log('[LETRA] SearXNG: Letra encontrada!');
    return letraSearXNG.substring(0, 5000);
  }

  console.log('[LETRA] Todas as camadas falharam.');
  return null;
}

// ============================================================
//  2. CONTEXTO — Genius → SearXNG → Wikipedia → OpenRouter mini-IA
// ============================================================
async function buscarContextoMusica(nomeMusica, artista, env) {
  const nomeLimpo = limparTermoMusica(nomeMusica);
  const artistaLimpo = limparTermoMusica(artista) || artista;
  const termoBusca = `${nomeLimpo} ${artistaLimpo}`;

  // CAMADA 1: Genius (descricao)
  console.log('[CONTEXTO] CAMADA 1: Genius...');
  if (env.GENIUS_API_KEY) {
    try {
      const query = encodeURIComponent(`${nomeLimpo} ${artistaLimpo}`);
      const resp = await fetch(`https://api.genius.com/search?q=${query}`, {
        headers: { Authorization: `Bearer ${env.GENIUS_API_KEY}` },
      });
      if (resp.ok) {
        const dados = await resp.json();
        const hit = dados?.response?.hits?.[0]?.result;
        if (hit?.url) {
          const pageResp = await fetch(hit.url, {
            headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Moovibe/1.0)' },
          });
          if (pageResp.ok) {
            const html = await pageResp.text();
            const metaMatch = html.match(/<meta\s+[^>]*name="description"[^>]*content="([^"]+)"/i);
            if (metaMatch && metaMatch[1]) {
              console.log('[CONTEXTO] Genius: Descricao encontrada!');
              return metaMatch[1].substring(0, 2000);
            }
          }
        }
      }
    } catch (err) {
      console.error('[CONTEXTO] Genius erro:', err);
    }
  }

  // CAMADA 2: SearXNG
  console.log('[CONTEXTO] CAMADA 2: SearXNG...');
  const ctxSearXNG = await buscarSearXNG(`${nomeLimpo} ${artistaLimpo} song meaning explanation`);
  if (ctxSearXNG) {
    console.log('[CONTEXTO] SearXNG: Contexto encontrado!');
    return ctxSearXNG.substring(0, 2000);
  }

  // CAMADA 3: Wikipedia PT
  console.log('[CONTEXTO] CAMADA 3: Wikipedia PT...');
  try {
    const url = `${WIKIPEDIA_PT_API}${encodeURIComponent(termoBusca)}`;
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'Moovibe/1.0 (movie recommendation app)' },
    });
    if (resp.status === 200) {
      const dados = await resp.json();
      if (dados.type !== 'disambiguation' && dados.extract) {
        console.log('[CONTEXTO] Wikipedia: Contexto encontrado!');
        return dados.extract.substring(0, 2000);
      }
    }
  } catch (err) {
    console.error('[CONTEXTO] Wikipedia erro:', err);
  }

  // CAMADA 4: OpenRouter mini-IA (com fallback string seguro)
  console.log('[CONTEXTO] CAMADA 4: OpenRouter (mini-IA)...');
  if (env.OPENROUTER_API_KEY) {
    try {
      const prompt = `Explique brevemente em um paragrafo curto em portugues o significado da musica '${nomeLimpo}' de '${artistaLimpo}'.`;
      const resp = await fetch(OPENROUTER_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${env.OPENROUTER_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'openrouter/free',
          temperature: 0.3,
          max_tokens: 300,
          messages: [{ role: 'user', content: prompt }],
        }),
      });
      if (resp.ok) {
        const dados = await resp.json();
        const texto = dados?.choices?.[0]?.message?.content?.trim();
        if (texto) {
          console.log('[CONTEXTO] OpenRouter: Contexto gerado via IA!');
          return texto.substring(0, 2000);
        }
      }
    } catch (err) {
      console.error('[CONTEXTO] OpenRouter erro:', err);
    }
  }

  console.log('[CONTEXTO] Todas as camadas falharam.');
  return null;
}

// ============================================================
//  3. RECOMENDAÇÃO IA — OpenRouter
// ============================================================
async function obterRecomendacaoIA(nomeMusica, artista, letra, contextoExtra, apiKey) {
  if (!apiKey) return null;

  const promptSistema = `Voce e um curador de cinema genial. O usuario vai te passar uma musica e voce deve sugerir EXATAMENTE UM filme que compartilhe exatamente da mesma atmosfera emocional, paleta de cores subtendida, ritmo psicologico ou alma lirica dessa musica. Nao se limite a conexoes obvias. Pense na vibe.

CRITICO: Voce DEVE sugerir um filme REAL existente no banco de dados do TMDb. PROIBIDO inventar titulos de filmes. Use APENAS o titulo original ou oficial em ingles/portugues. NAO use caracteres asiaticos (como chines, japones, coreano) a menos que seja um filme autenticamente asiatico com titulo original nesses caracteres. Se nao tiver certeza, escolha um filme classico e bem conhecido.

REGRA ABSOLUTA: No campo 'filme', retorne APENAS o nome comercial puro do filme (em ingles ou portugues). E terminantemente PROIBIDO embutir o ano ao lado do nome do filme nesse campo. Por exemplo, retorne 'The Great Gatsby' e NUNCA 'The Great Gatsby 2013'. O ano de lancamento deve habitar estritamente e apenas o campo 'ano' do JSON.

Sua resposta DEVE ser estritamente um formato JSON valido (sem qualquer tipo de formatacao markdown, apenas as chaves brutas). O JSON deve conter as seguintes chaves exatas:
{
  "filme": "Nome exato do filme (de preferencia o titulo original em ingles ou o mais conhecido, SEM o ano)",
  "ano": "Ano de lancamento do filme sugerido (Apenas os 4 digitos numericos, ex: 2002)",
  "justificativa": "Uma explicacao poetica, profunda e envolvente (em portugues, ate 4 frases) conectando sentimentos da musica/letra com o filme.",
  "vibe_title": "Um titulo CURTO e impactante em MAIUSCULAS (2-3 palavras) que capture a vibe, ex: 'OPERATIC CHAOS' ou 'MELANCHOLIC DREAM'",
  "tags": ["Array de 4 tags em MAIUSCULAS descrevendo a vibe, ex: GRANDIOSE, TRAGICOMIC, CATHARTIC, MOSAIC"]
}`;

  let conteudoUsuario = `Musica: '${nomeMusica}' do artista '${artista}'.\n`;
  if (letra) {
    conteudoUsuario += `Use a letra da musica para capturar a essencia poetica profunda:\n${letra}\n\n`;
  } else {
    conteudoUsuario += '(Nao encontramos a letra no banco de dados, baseie-se no tema geral da musica).\n\n';
  }
  if (contextoExtra) {
    conteudoUsuario += `Contexto historico, significado e fatos adicionais sobre a musica para te ajudar na escolha:\n${contextoExtra}\n`;
  }

  try {
    const resp = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'openrouter/free',
        temperature: 0.3,
        messages: [
          { role: 'system', content: promptSistema },
          { role: 'user', content: conteudoUsuario },
        ],
      }),
    });

    if (!resp.ok) {
      console.error('[OPENROUTER] HTTP', resp.status);
      return null;
    }

    const dados = await resp.json();
    let textoIA = dados?.choices?.[0]?.message?.content?.trim();
    if (!textoIA) return null;

    textoIA = textoIA.replace(/```json/g, '').replace(/```/g, '').trim();

    try {
      return JSON.parse(textoIA);
    } catch (_) {
      const matchJSON = textoIA.match(/(\{[\s\S]*\})/);
      if (matchJSON) {
        try {
          return JSON.parse(matchJSON[0]);
        } catch (e) {
          console.error('[OPENROUTER] Regex JSON parse falhou:', e);
          console.error('[OPENROUTER] Texto bruto:', textoIA);
          return null;
        }
      }
      console.error('[OPENROUTER] Nenhum JSON encontrado.');
      return null;
    }
  } catch (err) {
    console.error('[OPENROUTER] Erro na requisicao:', err);
    return null;
  }
}

// ============================================================
//  4. DADOS DO FILME — TMDb (sem language filter)
// ============================================================
async function obterDetalhesTMDB(nomeFilme, apiKey) {
  if (!apiKey) return null;

  try {
    const paramsBusca = new URLSearchParams({ api_key: apiKey, query: nomeFilme });
    const respBusca = await fetch(`${TMDB_BUSCA_URL}?${paramsBusca}`);
    if (!respBusca.ok) return null;

    const dadosBusca = await respBusca.json();
    const filmes = dadosBusca?.results;
    if (!filmes || filmes.length === 0) return null;

    const filmeBasico = filmes[0];
    const filmeId = filmeBasico.id;

    const paramsDetalhes = new URLSearchParams({ api_key: apiKey });
    const respDetalhes = await fetch(`https://api.themoviedb.org/3/movie/${filmeId}?${paramsDetalhes}`);
    const detalhes = respDetalhes.ok ? await respDetalhes.json() : {};

    let diretor = 'Nao encontrado';
    const respCreditos = await fetch(`https://api.themoviedb.org/3/movie/${filmeId}/credits?api_key=${apiKey}`);
    if (respCreditos.ok) {
      const creditos = await respCreditos.json();
      for (const pessoa of (creditos?.crew || [])) {
        if (pessoa.job === 'Director') {
          diretor = pessoa.name;
          break;
        }
      }
    }

    const respImagens = await fetch(`https://api.themoviedb.org/3/movie/${filmeId}/images?api_key=${apiKey}&include_image_language=en,null`);
    const cenas = [];
    if (respImagens.ok) {
      const imagens = await respImagens.json();
      for (const backdrop of (imagens?.backdrops || []).slice(0, 15)) {
        if (backdrop.file_path) {
          cenas.push(`https://image.tmdb.org/t/p/w780${backdrop.file_path}`);
        }
      }
    }

    let posterUrl = null;
    if (respImagens.ok) {
      const imagens = await respImagens.json();
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
    if (!posterUrl && filmeBasico.poster_path) {
      posterUrl = `https://image.tmdb.org/t/p/w500${filmeBasico.poster_path}`;
    }

    return {
      id_tmdb: filmeId,
      titulo_pt: filmeBasico.title,
      titulo_original: filmeBasico.original_title,
      ano: (filmeBasico.release_date || '----').substring(0, 4),
      sinopse: filmeBasico.overview || 'Sem sinopse disponivel.',
      poster: posterUrl,
      diretor: diretor,
      imdb_id: detalhes?.imdb_id || null,
      cenas: cenas,
    };
  } catch (err) {
    console.error('[TMDB] Erro:', err);
    return null;
  }
}

// ============================================================
//  5. FALLBACK FILME — Wikipedia → SearXNG
// ============================================================
async function buscarDadosFilmeFallback(nomeFilme, ano) {
  // CAMADA 1: Wikipedia PT (com 'filme' no termo)
  console.log('[FILME FALLBACK] CAMADA 1: Wikipedia PT...');
  try {
    const termos = [];
    if (ano) {
      termos.push(`${nomeFilme} (${ano}) filme`);
      termos.push(`${nomeFilme} ${ano} filme`);
    }
    termos.push(`${nomeFilme} filme`);
    termos.push(nomeFilme);

    for (const termo of termos) {
      const url = `${WIKIPEDIA_PT_API}${encodeURIComponent(termo)}`;
      const resp = await fetch(url, {
        headers: { 'User-Agent': 'Moovibe/1.0 (movie recommendation app)' },
      });
      if (resp.status === 200) {
        const dados = await resp.json();
        if (dados.type === 'disambiguation') continue;
        if (dados.extract) {
          const sinopse = extrairDuasPrimeirasFrases(dados.extract);
          const diretor = extrairDiretorWikipedia(dados.extract);

          let posterUrl = null;
          if (dados.originalimage && dados.originalimage.source) {
            posterUrl = dados.originalimage.source;
          }

          console.log('[FILME FALLBACK] Wikipedia: Dados encontrados!');
          return { sinopse: sinopse.substring(0, 2000), diretor, poster: posterUrl };
        }
      }
    }
  } catch (err) {
    console.error('[FILME FALLBACK] Wikipedia erro:', err);
  }

  // CAMADA 2: SearXNG (com rotacao)
  console.log('[FILME FALLBACK] CAMADA 2: SearXNG...');
  try {
    let query = `${nomeFilme} movie plot synopsis`;
    if (ano) query = `${nomeFilme} ${ano} movie plot synopsis`;
    const resultado = await buscarSearXNG(query);
    if (resultado) {
      console.log('[FILME FALLBACK] SearXNG: Dados encontrados!');
      return { sinopse: resultado.substring(0, 2000), diretor: 'Disponível na Web', poster: null };
    }
  } catch (err) {
    console.error('[FILME FALLBACK] SearXNG erro:', err);
  }

  console.log('[FILME FALLBACK] Todas as camadas falharam.');
  return null;
}

// ============================================================
//  UTILITARIO: limpar HTML
// ============================================================
function limparHTML(texto) {
  var entidades = {
    'amp': '&',
    'lt': '<',
    'gt': '>',
    'quot': '"',
    '#x27': "'",
    '#x2F': '/'
  };
  return texto
    .replace(/<[^>]*>/g, '')
    .replace(/&([a-zA-Z#0-9]+);/g, function(match, entidade) {
      return entidades[entidade] || '';
    })
    .replace(/&#(\d+);/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}