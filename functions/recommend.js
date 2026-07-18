/**
 * Moovibe - Cloudflare Pages Function
 * 
 * Responde em POST /recommend com a orquestração completa:
 *   1. LRCLIB (letras) + Genius (contexto)
 *   2. DuckDuckGo Instant Answer API fallback (letra + contexto + filme)
 *   3. Wikipedia API fallback (dados do filme)
 *   4. OpenRouter (IA → recomendação de filme)
 *   5. TMDb (pôster, diretor, stills, etc.)
 *   6. Resposta JSON formatada para o frontend
 */

// ============================================================
//  CONSTANTES
// ============================================================
const LRCLIB_URL = 'https://lrclib.net/api/search';
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const TMDB_BUSCA_URL = 'https://api.themoviedb.org/3/search/movie';
const DDG_INSTANT_API_URL = 'https://api.duckduckgo.com/';
const WIKIPEDIA_PT_API = 'https://pt.wikipedia.org/api/rest_v1/page/summary/';
const WIKIPEDIA_EN_API = 'https://en.wikipedia.org/api/rest_v1/page/summary/';

// ============================================================
//  HANDLER PRINCIPAL (Pages Functions)
// ============================================================
export async function onRequest(context) {
  const { request, env } = context;

  // Apenas POST
  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  try {
    const body = await request.json();
    const { nome_musica, artista } = body;

    if (!nome_musica) {
      return jsonResponse({ error: 'nome_musica is required' }, 400);
    }

    // ---- 1. BUSCAR LETRA (LRCLIB → DuckDuckGo API fallback) ----
    let letra = await buscarLetraLRCLIB(nome_musica, artista);
    if (!letra) {
      letra = await buscarDuckDuckGoAPI(`${nome_musica} ${artista} lyrics`);
    }

    // ---- 2. BUSCAR CONTEXTO (Genius → DuckDuckGo API fallback) ----
    let contextoExtra = null;
    if (env.GENIUS_API_KEY) {
      contextoExtra = await buscarContextoGenius(nome_musica, artista, env.GENIUS_API_KEY);
    }
    if (!contextoExtra) {
      contextoExtra = await buscarDuckDuckGoAPI(`${nome_musica} ${artista} song meaning`);
    }

    // ---- 3. RECOMENDAÇÃO IA (OpenRouter) ----
    const recomendacaoIA = await obterRecomendacaoIA(
      nome_musica, artista, letra, contextoExtra, env.OPENROUTER_API_KEY
    );

    if (!recomendacaoIA) {
      return jsonResponse({ error: 'Falha ao obter recomendacao da IA' }, 500);
    }

    const nomeFilme = recomendacaoIA.filme_sugerido;
    const anoFilme = recomendacaoIA.ano_filme || '';
    const justificativa = recomendacaoIA.justificativa_vibe;
    const vibeTitle = recomendacaoIA.vibe_title || 'VIBE CINEMATICA';
    const tags = recomendacaoIA.tags || ['UNICO', 'ESSENCIAL'];

    // ---- 4. DADOS DO FILME (TMDb → Wikipedia fallback) ----
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
//  HELPERS: Resposta JSON
// ============================================================
function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
    },
  });
}

// ============================================================
//  UTILITÁRIO: Limpar termos de busca
// ============================================================
function limparTermoMusica(termo) {
  if (!termo) return termo;
  let termoLimpo = termo;
  // Remove parenteses com palavras-chave comuns
  termoLimpo = termoLimpo.replace(/\([^)]*(?:official|music\s*video|remaster|remastered|audio|lyric|video|visualizer|live|feat\.?|ft\.?|prod\.?|explicit|clean|edit|version|4k|hd|360)[^)]*\)/gi, '');
  // Remove colchetes com palavras-chave
  termoLimpo = termoLimpo.replace(/\[[^\]]*(?:official|music\s*video|remaster|remastered|audio|lyric|video|visualizer|live|feat\.?|ft\.?|prod\.?|explicit|clean|edit|version|4k|hd|360)[^\]]*\]/gi, '');
  // Remove "Feat.", "Ft.", etc. no meio do texto
  termoLimpo = termoLimpo.replace(/\s+(?:feat\.?|ft\.?)\..*$/i, '');
  return termoLimpo.trim();
}

// ============================================================
//  1. BUSCAR LETRA — LRCLIB
// ============================================================
async function buscarLetraLRCLIB(nomeMusica, artista) {
  const params = new URLSearchParams({ track_name: nomeMusica, artist_name: artista || '' });
  const url = `${LRCLIB_URL}?${params}`;

  try {
    const resp = await fetch(url, { method: 'GET' });
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
//  2. BUSCAR CONTEXTO — Genius (API oficial)
// ============================================================
async function buscarContextoGenius(nomeMusica, artista, apiKey) {
  if (!apiKey) return null;

  try {
    // Limpa os termos para melhorar a busca
    const nomeMusicaLimpo = limparTermoMusica(nomeMusica);
    const artistaLimpo = limparTermoMusica(artista) || artista;

    const query = encodeURIComponent(`${nomeMusicaLimpo} ${artistaLimpo}`);
    const url = `https://api.genius.com/search?q=${query}`;
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });

    if (!resp.ok) return null;

    const dados = await resp.json();
    const hit = dados?.response?.hits?.[0]?.result;
    if (!hit) return null;

    // Pega a URL da música no Genius e tenta obter a descrição
    const songUrl = hit.url;
    if (!songUrl) return hit.title || null;

    // Busca a página da música para extrair a descrição
    const pageResp = await fetch(songUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Moovibe/1.0)' },
    });

    if (!pageResp.ok) return hit.title || null;

    const html = await pageResp.text();
    // Tenta extrair a meta description (contém o contexto/significado)
    const metaMatch = html.match(/<meta\s+[^>]*name="description"[^>]*content="([^"]+)"/i);
    if (metaMatch && metaMatch[1]) {
      return metaMatch[1].substring(0, 2000);
    }

    // Fallback: retorna só o título da música
    return hit.title || null;
  } catch (err) {
    console.error('[GENIUS] Erro:', err);
    return null;
  }
}

// ============================================================
//  3. BUSCA GENÉRICA — DuckDuckGo Instant Answer API (fallback)
// ============================================================
async function buscarDuckDuckGoAPI(query) {
  try {
    const params = new URLSearchParams({
      q: query,
      format: 'json',
      no_html: '1',
      skip_disambig: '1',
    });
    const url = `${DDG_INSTANT_API_URL}?${params}`;

    console.log(`[DUCKDUCKGO API] Buscando: '${query}'`);
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Moovibe/1.0)' },
    });

    if (!resp.ok) return null;

    const dados = await resp.json();

    // Tenta AbstractText (resumo principal)
    if (dados.AbstractText) {
      console.log('[DUCKDUCKGO API] ✓ Resumo encontrado via API Instant Answer.');
      return dados.AbstractText.substring(0, 2000);
    }

    // Fallback: Definition
    if (dados.Definition) {
      console.log('[DUCKDUCKGO API] ✓ Definicao encontrada via API Instant Answer.');
      return dados.Definition.substring(0, 2000);
    }

    // Fallback: primeiro RelatedTopic
    if (dados.RelatedTopics && Array.isArray(dados.RelatedTopics) && dados.RelatedTopics.length > 0) {
      const primeiro = dados.RelatedTopics[0];
      if (typeof primeiro === 'object' && primeiro !== null) {
        const texto = primeiro.Text || primeiro.Result || '';
        if (texto) {
          console.log('[DUCKDUCKGO API] ✓ Topico relacionado encontrado via API Instant Answer.');
          return texto.substring(0, 2000);
        }
      }
    }

    // Fallback: Results
    if (dados.Results && Array.isArray(dados.Results) && dados.Results.length > 0) {
      const primeiro = dados.Results[0];
      if (typeof primeiro === 'object' && primeiro !== null) {
        const texto = primeiro.Text || '';
        if (texto) {
          console.log('[DUCKDUCKGO API] ✓ Resultado de busca encontrado via API Instant Answer.');
          return texto.substring(0, 2000);
        }
      }
    }

    console.log('[DUCKDUCKGO API] ⚠ Nenhum resultado encontrado na API Instant Answer.');
    return null;
  } catch (err) {
    console.error('[DUCKDUCKGO API] Erro:', err);
    return null;
  }
}

// ============================================================
//  3.5 DADOS DO FILME — Wikipedia API (fallback)
// ============================================================
async function buscarDadosFilmeWikipedia(nomeFilme, ano) {
  try {
    // Monta lista de termos a tentar (primeiro PT, depois EN)
    const termosPT = [];
    if (ano) {
      termosPT.push(`${nomeFilme} (${ano})`);
      termosPT.push(`${nomeFilme} ${ano}`);
    }
    termosPT.push(nomeFilme);

    // Tenta Wikipedia PT
    for (const termo of termosPT) {
      const termoEncoded = encodeURIComponent(termo);
      const url = `${WIKIPEDIA_PT_API}${termoEncoded}`;

      console.log(`[WIKIPEDIA] Buscando: '${termo}'`);
      const resp = await fetch(url, {
        headers: { 'User-Agent': 'Moovibe/1.0 (movie recommendation app)' },
      });

      if (resp.status === 200) {
        const dados = await resp.json();

        if (dados.type === 'disambiguation') {
          console.log(`[WIKIPEDIA] ⚠ Pagina de desambiguacao para '${termo}'.`);
          continue;
        }

        if (dados.extract) {
          console.log(`[WIKIPEDIA] ✓ Dados recuperados para '${termo}'.`);

          // Tenta extrair o diretor
          let diretorWiki = 'Disponivel na Web';
          const matchDir = dados.extract.match(
            /(?:dire[cç][aã]o\s+(?:de\s+)?|diretor[:\s]+|dirigido\s+por\s+)([A-ZÀ-Ú][A-Za-zÀ-Ú\s]+)/i
          );
          if (matchDir) {
            diretorWiki = matchDir[1].trim();
          }

          return {
            sinopse: dados.extract.substring(0, 2000),
            diretor: diretorWiki,
          };
        }
      } else if (resp.status === 404) {
        console.log(`[WIKIPEDIA] ⚠ Pagina nao encontrada para '${termo}'.`);
        continue;
      }
    }

    // Fallback: Wikipedia EN
    const termosEN = [];
    if (ano) {
      termosEN.push(`${nomeFilme} (${ano})`);
    }
    termosEN.push(nomeFilme);

    for (const termo of termosEN) {
      const termoEncoded = encodeURIComponent(termo);
      const url = `${WIKIPEDIA_EN_API}${termoEncoded}`;

      console.log(`[WIKIPEDIA EN] Buscando: '${termo}'`);
      const resp = await fetch(url, {
        headers: { 'User-Agent': 'Moovibe/1.0 (movie recommendation app)' },
      });

      if (resp.status === 200) {
        const dados = await resp.json();

        if (dados.type === 'disambiguation') {
          continue;
        }

        if (dados.extract) {
          console.log(`[WIKIPEDIA EN] ✓ Dados recuperados para '${termo}'.`);

          let diretorWiki = 'Disponivel na Web';
          const matchDir = dados.extract.match(
            /(?:directed\s+by\s+|director[:\s]+)([A-Z][A-Za-z\s]+)/i
          );
          if (matchDir) {
            diretorWiki = matchDir[1].trim();
          }

          return {
            sinopse: dados.extract.substring(0, 2000),
            diretor: diretorWiki,
          };
        }
      } else if (resp.status === 404) {
        continue;
      }
    }

    console.log('[WIKIPEDIA] ⚠ Nenhum resultado encontrado na Wikipedia para este filme.');
    return null;
  } catch (err) {
    console.error('[WIKIPEDIA] Erro:', err);
    return null;
  }
}

// ============================================================
//  4. INTELIGÊNCIA ARTIFICIAL — OpenRouter
// ============================================================
async function obterRecomendacaoIA(nomeMusica, artista, letra, contextoExtra, apiKey) {
  if (!apiKey) return null;

  const promptSistema = `Voce e um curador de cinema genial. O usuario vai te passar uma musica e voce deve sugerir EXATAMENTE UM filme que compartilhe exatamente da mesma atmosfera emocional, paleta de cores subtendida, ritmo psicologico ou alma lirica dessa musica. Nao se limite a conexoes obvias. Pense na vibe.

CRITICO: Voce DEVE sugerir um filme REAL existente no banco de dados do TMDb. PROIBIDO inventar titulos de filmes. Use APENAS o titulo original ou oficial em ingles/portugues. NAO use caracteres asiaticos (como chines, japones, coreano) a menos que seja um filme autenticamente asiatico com titulo original nesses caracteres. Se nao tiver certeza, escolha um filme classico e bem conhecido.

REGRA ABSOLUTA: No campo 'filme_sugerido', retorne APENAS o nome do filme, SEM o ano de lancamento junto. Por exemplo, retorne 'Fight Club' e JAMAIS 'Fight Club 1999'. O ano deve ser retornado EXCLUSIVAMENTE no campo separado 'ano_filme'.

Sua resposta DEVE ser estritamente um formato JSON valido (sem qualquer tipo de formatacao markdown, apenas as chaves brutas). O JSON deve conter as seguintes chaves exatas:
{
  "filme_sugerido": "Nome exato do filme (de preferencia o titulo original em ingles ou o mais conhecido, SEM o ano)",
  "ano_filme": "Ano de lancamento do filme sugerido (Apenas os 4 digitos numericos, ex: 2002)",
  "justificativa_vibe": "Uma explicacao poetica, profunda e envolvente (em portugues, ate 4 frases) conectando sentimentos da musica/letra com o filme.",
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

  const payload = {
    model: 'openrouter/free',
    temperature: 0.3,
    messages: [
      { role: 'system', content: promptSistema },
      { role: 'user', content: conteudoUsuario },
    ],
  };

  try {
    const resp = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!resp.ok) {
      console.error('[OPENROUTER] HTTP', resp.status);
      return null;
    }

    const dados = await resp.json();
    let textoIA = dados?.choices?.[0]?.message?.content?.trim();
    if (!textoIA) return null;

    // Remove eventual formatação markdown
    textoIA = textoIA.replace(/```json/g, '').replace(/```/g, '').trim();

    // Tenta parse direto
    try {
      return JSON.parse(textoIA);
    } catch (_) {
      // Fallback: regex para extrair JSON
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
      console.error('[OPENROUTER] Nenhum JSON encontrado no texto.');
      return null;
    }
  } catch (err) {
    console.error('[OPENROUTER] Erro na requisicao:', err);
    return null;
  }
}

// ============================================================
//  5. DADOS DO FILME — TMDb
// ============================================================
async function obterDetalhesTMDB(nomeFilme, ano, apiKey) {
  if (!apiKey) return null;

  try {
    // --- Busca ---
    const paramsBusca = new URLSearchParams({ api_key: apiKey, query: nomeFilme, language: 'pt-BR' });
    const respBusca = await fetch(`${TMDB_BUSCA_URL}?${paramsBusca}`);
    if (!respBusca.ok) return null;

    const dadosBusca = await respBusca.json();
    const filmes = dadosBusca?.results;
    if (!filmes || filmes.length === 0) return null;

    const filmeBasico = filmes[0];
    const filmeId = filmeBasico.id;

    // --- Detalhes ---
    const paramsDetalhes = new URLSearchParams({ api_key: apiKey, language: 'pt-BR' });
    const respDetalhes = await fetch(
      `https://api.themoviedb.org/3/movie/${filmeId}?${paramsDetalhes}`
    );
    const detalhes = respDetalhes.ok ? await respDetalhes.json() : {};

    // --- Créditos (diretor) ---
    let diretor = 'Nao encontrado';
    const respCreditos = await fetch(
      `https://api.themoviedb.org/3/movie/${filmeId}/credits?api_key=${apiKey}`
    );
    if (respCreditos.ok) {
      const creditos = await respCreditos.json();
      for (const pessoa of (creditos?.crew || [])) {
        if (pessoa.job === 'Director') {
          diretor = pessoa.name;
          break;
        }
      }
    }

    // --- Imagens (backdrops) ---
    const respImagens = await fetch(
      `https://api.themoviedb.org/3/movie/${filmeId}/images?api_key=${apiKey}`
    );
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
      poster: filmeBasico.poster_path
        ? `https://image.tmdb.org/t/p/w500${filmeBasico.poster_path}`
        : null,
      diretor: diretor,
      imdb_id: detalhes?.imdb_id || null,
      cenas: cenas,
    };
  } catch (err) {
    console.error('[TMDB] Erro:', err);
    return null;
  }
}