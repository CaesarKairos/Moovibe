/**
 * Moovibe - Cloudflare Worker (ES Modules)
 * 
 * Tradução completa do backend Python (app.py) para o ambiente
 * Cloudflare Workers. Escuta POST em /api/recommend e orquestra:
 * 
 *   1. LRCLIB (letras) + Genius (contexto)
 *   2. DuckDuckGo fallback (letra + contexto + filme)
 *   3. OpenRouter (IA → recomendação de filme)
 *   4. TMDb (pôster, diretor, stills, etc.)
 *   5. Resposta JSON formatada para o frontend
 */

// ============================================================
//  CONSTANTES
// ============================================================
const LRCLIB_URL = 'https://lrclib.net/api/search';
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const TMDB_BUSCA_URL = 'https://api.themoviedb.org/3/search/movie';
const DUCKDUCKGO_HTML_URL = 'https://html.duckduckgo.com/html/';

// ============================================================
//  HANDLER PRINCIPAL
// ============================================================
export default {
  async fetch(request, env) {
    // --- CORS preflight ---
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        },
      });
    }

    const url = new URL(request.url);

    // Apenas POST /api/recommend
    if (request.method !== 'POST' || url.pathname !== '/api/recommend') {
      return new Response('Not Found', { status: 404 });
    }

    try {
      const body = await request.json();
      const { nome_musica, artista } = body;

      if (!nome_musica) {
        return jsonResponse({ error: 'nome_musica is required' }, 400);
      }

      // ---- 1. BUSCAR LETRA (LRCLIB → DuckDuckGo fallback) ----
      let letra = await buscarLetraLRCLIB(nome_musica, artista);
      if (!letra) {
        letra = await buscarDuckDuckGo(`${nome_musica} ${artista} lyrics`);
      }

      // ---- 2. BUSCAR CONTEXTO (Genius → DuckDuckGo fallback) ----
      let contextoExtra = null;
      if (env.GENIUS_API_KEY) {
        contextoExtra = await buscarContextoGenius(nome_musica, artista, env.GENIUS_API_KEY);
      }
      if (!contextoExtra) {
        contextoExtra = await buscarDuckDuckGo(`${nome_musica} ${artista} song meaning`);
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

      // ---- 4. DADOS DO FILME (TMDb → DuckDuckGo fallback) ----
      let dadosFilme = null;
      if (env.TMDB_API_KEY) {
        dadosFilme = await obterDetalhesTMDB(nomeFilme, anoFilme, env.TMDB_API_KEY);
      }
      if (!dadosFilme || !dadosFilme.sinopse) {
        const fallback = await buscarDadosFilmeDuckDuckGo(nomeFilme, anoFilme);
        if (fallback) {
          dadosFilme = fallback;
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
      console.error('Worker error:', error);
      return jsonResponse({ error: 'Erro interno do servidor' }, 500);
    }
  },
};

// ============================================================
//  HELPERS: Resposta JSON com CORS
// ============================================================
function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
  });
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
    const query = encodeURIComponent(`${nomeMusica} ${artista}`);
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
//  3. BUSCA GENÉRICA — DuckDuckGo HTML
// ============================================================
async function buscarDuckDuckGo(query) {
  try {
    const params = new URLSearchParams({ q: query });
    const resp = await fetch(`${DUCKDUCKGO_HTML_URL}?${params}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Moovibe/1.0)' },
    });

    if (!resp.ok) return null;

    const html = await resp.text();
    const resultados = extrairResultadosDDG(html, 3);

    if (resultados.length === 0) return null;

    return resultados
      .map((r, i) => `Resultado ${i + 1}: ${r.titulo}\n${r.descricao}`)
      .join('\n\n');
  } catch (err) {
    console.error('[DUCKDUCKGO] Erro:', err);
    return null;
  }
}

// ============================================================
//  3.5 DADOS DO FILME — DuckDuckGo (fallback)
// ============================================================
async function buscarDadosFilmeDuckDuckGo(nomeFilme, ano) {
  const query = ano ? `${nomeFilme} ${ano} filme sinopse` : `${nomeFilme} filme sinopse`;

  try {
    const params = new URLSearchParams({ q: query });
    const resp = await fetch(`${DUCKDUCKGO_HTML_URL}?${params}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Moovibe/1.0)' },
    });

    if (!resp.ok) return null;

    const html = await resp.text();
    const resultados = extrairResultadosDDG(html, 3);

    if (resultados.length === 0) return null;

    const sinopseWeb = resultados.map((r, i) => `Resultado ${i + 1}: ${r.titulo}\n${r.descricao}`).join('\n\n');

    // Tenta extrair menção a diretor nos resultados
    let diretorWeb = 'Disponivel na Web';
    for (const r of resultados) {
      const matchDir = r.textoCombinado.match(
        /(?:dire[cç][aã]o\s+(?:de\s+)?|diretor[:\s]+|dirigido\s+por\s+)([A-ZÀ-Ú][A-Za-zÀ-Ú\s]+)/i
      );
      if (matchDir) {
        diretorWeb = matchDir[1].trim();
        break;
      }
    }

    return {
      titulo_pt: nomeFilme,
      titulo_original: nomeFilme,
      ano: ano || 'Nao informado',
      sinopse: sinopseWeb.substring(0, 2000),
      poster: null,
      diretor: diretorWeb,
      imdb_id: null,
      id_tmdb: null,
      cenas: [],
    };
  } catch (err) {
    console.error('[DUCKDUCKGO FILME] Erro:', err);
    return null;
  }
}

// ============================================================
//  EXTRAIR RESULTADOS DO HTML DO DuckDuckGo
// ============================================================
function extrairResultadosDDG(html, max = 3) {
  const resultados = [];

  // Regex para capturar blocos de resultado: <a class="result__a"...>TITULO</a> ... snippet
  const blocos = html.split(/<article\s+class="result\s+result--default"/i);

  for (let i = 1; i < blocos.length && resultados.length < max; i++) {
    const bloco = blocos[i];

    // Título: <a class="result__a" ...>TEXTO</a>
    const tituloMatch = bloco.match(/<a[^>]*class="result__a"[^>]*>([\s\S]*?)<\/a>/i);
    const titulo = tituloMatch ? limparHTML(tituloMatch[1]) : '';

    // Descrição/snippet: <a class="result__snippet" ...>TEXTO</a>
    const snippetMatch = bloco.match(/<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/i);
    const descricao = snippetMatch ? limparHTML(snippetMatch[1]) : '';

    if (titulo || descricao) {
      resultados.push({
        titulo,
        descricao,
        textoCombinado: `${titulo} ${descricao}`,
      });
    }
  }

  return resultados;
}

function limparHTML(texto) {
  // Mapeamento de entidades HTML para caracteres literais
  var entidades = {
    'amp': '&',
    'lt': '<',
    'gt': '>',
    'quot': '"',
    '#x27': "'",
    '#x2F': '/'
  };
  return texto
    .replace(/<[^>]*>/g, '')            // remove tags HTML
    .replace(/&([a-zA-Z#0-9]+);/g, function(match, entidade) {
      return entidades[entidade] || '';
    })
    .replace(/&#(\d+);/g, '')           // remove entidades numéricas
    .replace(/\s+/g, ' ')
    .trim();
}

// ============================================================
//  4. INTELIGÊNCIA ARTIFICIAL — OpenRouter
// ============================================================
async function obterRecomendacaoIA(nomeMusica, artista, letra, contextoExtra, apiKey) {
  if (!apiKey) return null;

  const promptSistema = `Voce e um curador de cinema genial. O usuario vai te passar uma musica e voce deve sugerir EXATAMENTE UM filme que compartilhe exatamente da mesma atmosfera emocional, paleta de cores subtendida, ritmo psicologico ou alma lirica dessa musica. Nao se limite a conexoes obvias. Pense na vibe.

CRITICO: Voce DEVE sugerir um filme REAL existente no banco de dados do TMDb. PROIBIDO inventar titulos de filmes. Use APENAS o titulo original ou oficial em ingles/portugues. NAO use caracteres asiaticos (como chines, japones, coreano) a menos que seja um filme autenticamente asiatico com titulo original nesses caracteres. Se nao tiver certeza, escolha um filme classico e bem conhecido.

Sua resposta DEVE ser estritamente um formato JSON valido (sem qualquer tipo de formatacao markdown, apenas as chaves brutas). O JSON deve conter as seguintes chaves exatas:
{
  "filme_sugerido": "Nome exato do filme (de preferencia o titulo original em ingles ou o mais conhecido)",
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