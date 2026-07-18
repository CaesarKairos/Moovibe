/**
 * Moovibe - Cloudflare Pages Function
 * 
 * Responde em POST /recommend com orquestração completa:
 *   1. LRCLIB (letras)
 *   2. Contexto: Genius → Wikipedia PT → OpenRouter (fallback 3 camadas)
 *   3. OpenRouter (IA → recomendação de filme)
 *   4. TMDb → Wikipedia → "Sinopse indisponível" (dados do filme)
 *   5. Resposta JSON formatada para o frontend
 */

// ============================================================
//  CONSTANTES
// ============================================================
const LRCLIB_URL = 'https://lrclib.net/api/search';
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const TMDB_BUSCA_URL = 'https://api.themoviedb.org/3/search/movie';
const WIKIPEDIA_PT_API = 'https://pt.wikipedia.org/api/rest_v1/page/summary/';
const WIKIPEDIA_EN_API = 'https://en.wikipedia.org/api/rest_v1/page/summary/';

// ============================================================
//  HANDLER PRINCIPAL (Pages Functions)
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

    // ---- 1. BUSCAR LETRA (LRCLIB) ----
    let letra = await buscarLetraLRCLIB(nome_musica, artista);

    // ---- 2. BUSCAR CONTEXTO (3 camadas de fallback) ----
    const contextoExtra = await buscarContextoMusica(nome_musica, artista, env);

    // ---- 3. RECOMENDAÇÃO IA (OpenRouter) ----
    const recomendacaoIA = await obterRecomendacaoIA(
      nome_musica, artista, letra, contextoExtra, env.OPENROUTER_API_KEY
    );

    if (!recomendacaoIA) {
      return jsonResponse({ error: 'Falha ao obter recomendacao da IA' }, 500);
    }

    // Suporta tanto 'filme' (novo) quanto 'filme_sugerido' (legado)
    const nomeFilme = recomendacaoIA.filme || recomendacaoIA.filme_sugerido || '';
    const anoFilme = recomendacaoIA.ano || recomendacaoIA.ano_filme || '';
    const justificativa = recomendacaoIA.justificativa || recomendacaoIA.justificativa_vibe || '';
    const vibeTitle = recomendacaoIA.vibe_title || 'VIBE CINEMATICA';
    const tags = recomendacaoIA.tags || ['UNICO', 'ESSENCIAL'];

    if (!nomeFilme) {
      return jsonResponse({ error: 'IA nao retornou um nome de filme valido' }, 500);
    }

    // ---- 4. DADOS DO FILME (TMDb → Wikipedia → "Sinopse indisponivel") ----
    let dadosFilme = null;
    if (env.TMDB_API_KEY) {
      dadosFilme = await obterDetalhesTMDB(nomeFilme, anoFilme, env.TMDB_API_KEY);
    }

    if (!dadosFilme || !dadosFilme.sinopse || dadosFilme.sinopse === 'Sem sinopse disponivel.') {
      const fallback = await buscarDadosFilmeWikipedia(nomeFilme, anoFilme);
      if (fallback) {
        dadosFilme = {
          id_tmdb: null,
          titulo_pt: nomeFilme,
          titulo_original: nomeFilme,
          ano: anoFilme || 'Nao informado',
          sinopse: fallback.sinopse,
          poster: null,
          diretor: fallback.diretor,
          imdb_id: null,
          cenas: [],
        };
      } else {
        // Fallback final: sinopse padrao
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

    // ---- 5. MONTAR RESPOSTA ----
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

// ============================================================
//  UTILITÁRIO: Limpeza agressiva de termos
// ============================================================
function limparTermoMusica(termo) {
  if (!termo) return termo;
  let t = termo;
  // Remove ano entre parenteses: (2014), (1999)
  t = t.replace(/\(\d{4}\)/g, '');
  // Remove ano entre colchetes: [2014], [1999]
  t = t.replace(/\[\d{4}\]/g, '');
  // Remove parenteses com palavras-chave promocionais
  t = t.replace(/\([^)]*(?:official|music\s*video|remaster|remastered|audio|lyric|video|visualizer|live|feat\.?|ft\.?|prod\.?|explicit|clean|edit|version|4k|hd|360|clip|single|lyrics|audio|official\s*audio)[^)]*\)/gi, '');
  // Remove colchetes com palavras-chave promocionais
  t = t.replace(/\[[^\]]*(?:official|music\s*video|remaster|remastered|audio|lyric|video|visualizer|live|feat\.?|ft\.?|prod\.?|explicit|clean|edit|version|4k|hd|360|clip|single|lyrics|audio|official\s*audio)[^\]]*\]/gi, '');
  // Remove "Feat.", "Ft." no final
  t = t.replace(/\s+(?:feat\.?|ft\.?)\..*$/i, '');
  // Remove "Feat.", "Ft." no meio entre parenteses/colchetes
  t = t.replace(/\s+[\(\[].*?(?:feat\.?|ft\.?).*?[\)\]]/gi, '');
  return t.trim();
}

// ============================================================
//  1. BUSCAR LETRA — LRCLIB
// ============================================================
async function buscarLetraLRCLIB(nomeMusica, artista) {
  const params = new URLSearchParams({ track_name: nomeMusica, artist_name: artista || '' });
  try {
    const resp = await fetch(`${LRCLIB_URL}?${params}`, { method: 'GET' });
    if (!resp.ok) return null;
    const dados = await resp.json();
    if (Array.isArray(dados) && dados.length > 0 && dados[0].plainLyrics) {
      return dados[0].plainLyrics;
    }
  } catch (err) {
    console.error('[LRCLIB] Erro:', err);
  }
  return null;
}

// ============================================================
//  2.1 CONTEXTO — CAMADA 1: Genius
// ============================================================
async function buscarContextoGenius(nomeMusica, artista, apiKey) {
  if (!apiKey) return null;

  try {
    const nomeLimpo = limparTermoMusica(nomeMusica);
    const artistaLimpo = limparTermoMusica(artista) || artista;
    const query = encodeURIComponent(`${nomeLimpo} ${artistaLimpo}`);

    const resp = await fetch(`https://api.genius.com/search?q=${query}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!resp.ok) return null;

    const dados = await resp.json();
    const hit = dados?.response?.hits?.[0]?.result;
    if (!hit) return null;

    const songUrl = hit.url;
    if (!songUrl) return hit.title || null;

    const pageResp = await fetch(songUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Moovibe/1.0)' },
    });
    if (!pageResp.ok) return hit.title || null;

    const html = await pageResp.text();
    const metaMatch = html.match(/<meta\s+[^>]*name="description"[^>]*content="([^"]+)"/i);
    if (metaMatch && metaMatch[1]) {
      return metaMatch[1].substring(0, 2000);
    }

    return hit.title || null;
  } catch (err) {
    console.error('[GENIUS] Erro:', err);
    return null;
  }
}

// ============================================================
//  2.2 CONTEXTO — CAMADA 2: Wikipedia PT
// ============================================================
async function buscarContextoWikipedia(nomeMusica, artista) {
  try {
    const termo = `${nomeMusica} ${artista}`;
    const url = `${WIKIPEDIA_PT_API}${encodeURIComponent(termo)}`;

    console.log(`[WIKIPEDIA] Buscando contexto: '${termo}'`);
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'Moovibe/1.0 (movie recommendation app)' },
    });

    if (resp.status === 200) {
      const dados = await resp.json();
      if (dados.type === 'disambiguation') {
        console.log('[WIKIPEDIA] Pagina de desambiguacao.');
        return null;
      }
      if (dados.extract) {
        console.log('[WIKIPEDIA] Contexto encontrado!');
        return dados.extract.substring(0, 2000);
      }
    } else if (resp.status === 404) {
      console.log('[WIKIPEDIA] Pagina nao encontrada.');
    }
  } catch (err) {
    console.error('[WIKIPEDIA] Erro:', err);
  }
  return null;
}

// ============================================================
//  2.3 CONTEXTO — CAMADA 3: OpenRouter (fallback drástico)
// ============================================================
async function buscarContextoIAFallback(nomeMusica, artista, apiKey) {
  if (!apiKey) return null;

  console.log('[OPENROUTER FALLBACK] Gerando contexto via IA...');

  const promptCurto = `Explique brevemente em um paragrafo de ate 3 linhas em portugues o significado e contexto cultural da musica '${nomeMusica}' de '${artista}'.`;

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
        max_tokens: 300,
        messages: [{ role: 'user', content: promptCurto }],
      }),
    });

    if (!resp.ok) return null;

    const dados = await resp.json();
    const texto = dados?.choices?.[0]?.message?.content?.trim();
    if (texto) {
      console.log('[OPENROUTER FALLBACK] Contexto gerado com sucesso!');
      return texto.substring(0, 2000);
    }
  } catch (err) {
    console.error('[OPENROUTER FALLBACK] Erro:', err);
  }
  return null;
}

// ============================================================
//  2.4 ORQUESTRADOR DE CONTEXTO (3 CAMADAS)
// ============================================================
async function buscarContextoMusica(nomeMusica, artista, env) {
  // CAMADA 1: Genius
  console.log('[CONTEXTO] CAMADA 1: Genius...');
  if (env.GENIUS_API_KEY) {
    const ctx = await buscarContextoGenius(nomeMusica, artista, env.GENIUS_API_KEY);
    if (ctx) return ctx;
  }

  // CAMADA 2: Wikipedia PT
  console.log('[CONTEXTO] CAMADA 2: Wikipedia PT...');
  const ctx2 = await buscarContextoWikipedia(nomeMusica, artista);
  if (ctx2) return ctx2;

  // CAMADA 3: OpenRouter fallback
  console.log('[CONTEXTO] CAMADA 3: OpenRouter (fallback drastico)...');
  if (env.OPENROUTER_API_KEY) {
    const ctx3 = await buscarContextoIAFallback(nomeMusica, artista, env.OPENROUTER_API_KEY);
    if (ctx3) return ctx3;
  }

  console.log('[CONTEXTO] Todas as 3 camadas falharam.');
  return null;
}

// ============================================================
//  3. INTELIGÊNCIA ARTIFICIAL — OpenRouter
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
//  4. DADOS DO FILME — TMDb
// ============================================================
async function obterDetalhesTMDB(nomeFilme, ano, apiKey) {
  if (!apiKey) return null;

  try {
    const paramsBusca = new URLSearchParams({ api_key: apiKey, query: nomeFilme, language: 'pt-BR' });
    const respBusca = await fetch(`${TMDB_BUSCA_URL}?${paramsBusca}`);
    if (!respBusca.ok) return null;

    const dadosBusca = await respBusca.json();
    const filmes = dadosBusca?.results;
    if (!filmes || filmes.length === 0) return null;

    const filmeBasico = filmes[0];
    const filmeId = filmeBasico.id;

    const paramsDetalhes = new URLSearchParams({ api_key: apiKey, language: 'pt-BR' });
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

    const respImagens = await fetch(`https://api.themoviedb.org/3/movie/${filmeId}/images?api_key=${apiKey}`);
    const cenas = [];
    if (respImagens.ok) {
      const imagens = await respImagens.json();
      for (const backdrop of (imagens?.backdrops || []).slice(0, 15)) {
        cenas.push(`https://image.tmdb.org/t/p/w780${backdrop.file_path}`);
      }
    }

    return {
      id_tmdb: filmeId,
      titulo_pt: filmeBasico.title,
      titulo_original: filmeBasico.original_title,
      ano: (filmeBasico.release_date || '----').substring(0, 4),
      sinopse: filmeBasico.overview || 'Sem sinopse disponivel.',
      poster: filmeBasico.poster_path ? `https://image.tmdb.org/t/p/w500${filmeBasico.poster_path}` : null,
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
//  5. FALLBACK DE FILME — Wikipedia API
// ============================================================
async function buscarDadosFilmeWikipedia(nomeFilme, ano) {
  try {
    const termosPT = [];
    if (ano) {
      termosPT.push(`${nomeFilme} (${ano})`);
      termosPT.push(`${nomeFilme} ${ano}`);
    }
    termosPT.push(nomeFilme);

    // Tenta Wikipedia PT
    for (const termo of termosPT) {
      const url = `${WIKIPEDIA_PT_API}${encodeURIComponent(termo)}`;
      console.log(`[WIKIPEDIA] Buscando filme: '${termo}'`);
      const resp = await fetch(url, {
        headers: { 'User-Agent': 'Moovibe/1.0 (movie recommendation app)' },
      });

      if (resp.status === 200) {
        const dados = await resp.json();
        if (dados.type === 'disambiguation') {
          console.log(`[WIKIPEDIA] Desambiguacao para '${termo}'.`);
          continue;
        }
        if (dados.extract) {
          console.log(`[WIKIPEDIA] Dados do filme encontrados para '${termo}'.`);
          let diretor = 'Disponivel na Wikipedia';
          const matchDir = dados.extract.match(
            /(?:dire[cç][aã]o\s+(?:de\s+)?|diretor[:\s]+|dirigido\s+por\s+)([A-ZÀ-Ú][A-Za-zÀ-Ú\s]+)/i
          );
          if (matchDir) diretor = matchDir[1].trim();
          return { sinopse: dados.extract.substring(0, 2000), diretor };
        }
      } else if (resp.status === 404) {
        console.log(`[WIKIPEDIA] Pagina nao encontrada para '${termo}'.`);
      }
    }

    // Tenta Wikipedia EN
    const termosEN = [];
    if (ano) termosEN.push(`${nomeFilme} (${ano})`);
    termosEN.push(nomeFilme);

    for (const termo of termosEN) {
      const url = `${WIKIPEDIA_EN_API}${encodeURIComponent(termo)}`;
      console.log(`[WIKIPEDIA EN] Buscando filme: '${termo}'`);
      const resp = await fetch(url, {
        headers: { 'User-Agent': 'Moovibe/1.0 (movie recommendation app)' },
      });

      if (resp.status === 200) {
        const dados = await resp.json();
        if (dados.type === 'disambiguation') continue;
        if (dados.extract) {
          console.log(`[WIKIPEDIA EN] Dados do filme encontrados para '${termo}'.`);
          let diretor = 'Disponivel na Wikipedia';
          const matchDir = dados.extract.match(
            /(?:directed\s+by\s+|director[:\s]+)([A-Z][A-Za-z\s]+)/i
          );
          if (matchDir) diretor = matchDir[1].trim();
          return { sinopse: dados.extract.substring(0, 2000), diretor };
        }
      } else if (resp.status === 404) {
        continue;
      }
    }

    console.log('[WIKIPEDIA] Nenhum resultado encontrado para o filme.');
  } catch (err) {
    console.error('[WIKIPEDIA] Erro:', err);
  }
  return null;
}