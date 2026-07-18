/**
 * Moovibe - Cloudflare Worker
 *
 * Tradução exata de app.py (Python) para JavaScript (ES Modules).
 * Roda como Cloudflare Worker com export default { async fetch(request, env) }.
 *
 * Deploy:
 *   npm install -g wrangler
 *   wrangler secret put OPENROUTER_API_KEY
 *   wrangler secret put TMDB_API_KEY
 *   wrangler secret put GENIUS_API_KEY
 *   wrangler deploy
 *
 * Teste local:
 *   wrangler dev
 */

// ==========================================
// CONSTANTES
// ==========================================
const URL_LRCLIB          = 'https://lrclib.net/api/search';
const URL_OPENROUTER      = 'https://openrouter.ai/api/v1/chat/completions';
const URL_TMDB_BUSCA      = 'https://api.themoviedb.org/3/search/movie';
const URL_TMDB_BASE       = 'https://api.themoviedb.org/3/movie';
const URL_GENIUS_BUSCA    = 'https://api.genius.com/search';
const URL_GENIUS_SONGS    = 'https://api.genius.com/songs';
const URL_DDG_HTML        = 'https://html.duckduckgo.com/html';

// ==========================================
// 1. BUSCA DE LETRAS (LRCLIB API - Grátis)
// ==========================================
async function buscar_letra_musica(nome_musica, artista) {
    const params = new URLSearchParams({
        track_name: nome_musica,
        artist_name: artista
    });

    try {
        const resp = await fetch(`${URL_LRCLIB}?${params}`, { timeout: 10000 });
        if (resp.ok) {
            const data = await resp.json();
            if (Array.isArray(data) && data.length > 0 && data[0].plainLyrics) {
                return data[0].plainLyrics;
            }
        }
    } catch (_) {
        // Silencia erro
    }
    return null;
}

// ==========================================
// 1.5 BUSCA DE CONTEXTO (GENIUS API HTTP)
// ==========================================
async function buscar_contexto_genius(nome_musica, artista, env) {
    if (!env.GENIUS_API_KEY) return null;

    try {
        // Passo 1: buscar a musica na API do Genius
        const searchResp = await fetch(
            `${URL_GENIUS_BUSCA}?q=${encodeURIComponent(nome_musica + ' ' + artista)}`,
            {
                headers: {
                    'Authorization': `Bearer ${env.GENIUS_API_KEY}`,
                    'Accept': 'application/json'
                }
            }
        );
        if (!searchResp.ok) return null;

        const searchData = await searchResp.json();
        const hits = searchData?.response?.hits;
        if (!hits || hits.length === 0) return null;

        const song = hits[0]?.result;
        if (!song) return null;

        // Passo 2: pegar detalhes da musica (description)
        const songResp = await fetch(`${URL_GENIUS_SONGS}/${song.id}`, {
            headers: {
                'Authorization': `Bearer ${env.GENIUS_API_KEY}`,
                'Accept': 'application/json'
            }
        });
        if (!songResp.ok) return null;

        const songData = await songResp.json();
        const songDetails = songData?.response?.song;

        if (songDetails?.description?.plain) {
            // Remove tags HTML
            const descricao = songDetails.description.plain.replace(/<[^>]+>/g, '');
            return descricao.substring(0, 2000);
        }

        // Fallback: description_preview
        if (song.description_preview) {
            return song.description_preview.replace(/<[^>]+>/g, '').substring(0, 2000);
        }

    } catch (_) {
        // Silencia erro
    }
    return null;
}

// ==========================================
// HELPER: Busca DuckDuckGo (HTML scraping)
// ==========================================
async function buscar_duckduckgo(termo_busca) {
    try {
        const resp = await fetch(`${URL_DDG_HTML}?q=${encodeURIComponent(termo_busca)}`, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (compatible; Moovibe/1.0)'
            }
        });
        if (!resp.ok) return null;

        const html = await resp.text();
        const resultados = [];

        // Regex para extrair titulo e snippet dos resultados do DuckDuckGo
        const regex = /<a[^>]*rel="nofollow"[^>]*class="[^"]*result__a[^"]*"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
        let match;
        while ((match = regex.exec(html)) !== null && resultados.length < 3) {
            const titulo   = match[1].replace(/<[^>]+>/g, '').trim();
            const descricao = match[2].replace(/<[^>]+>/g, '').trim();
            if (titulo || descricao) {
                resultados.push(`Resultado ${resultados.length + 1}: ${titulo}\n${descricao}`);
            }
        }

        // Fallback: qualquer snippet disponivel
        if (resultados.length === 0) {
            const fallbackRegex = /class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
            while ((match = fallbackRegex.exec(html)) !== null && resultados.length < 3) {
                const texto = match[1].replace(/<[^>]+>/g, '').trim();
                if (texto) resultados.push(`Resultado ${resultados.length + 1}: ${texto}`);
            }
        }

        if (resultados.length > 0) {
            return resultados.join('\n\n');
        }
    } catch (_) {
        // Silencia erro
    }
    return null;
}

// ==========================================
// 1.6 BUSCA DE LETRA (DUCKDUCKGO - FALLBACK)
// ==========================================
async function buscar_letra_duckduckgo(nome_musica, artista) {
    return await buscar_duckduckgo(`${nome_musica} ${artista} lyrics`);
}

// ==========================================
// 1.7 BUSCA DE CONTEXTO (DUCKDUCKGO - FALLBACK)
// ==========================================
async function buscar_contexto_duckduckgo(nome_musica, artista) {
    return await buscar_duckduckgo(`${nome_musica} ${artista} song meaning`);
}

// ==========================================
// 2. INTELIGENCIA ARTIFICIAL (OpenRouter)
// ==========================================
async function obter_recomendacao_ia(nome_musica, artista, letra, contexto_extra, env) {
    const prompt_sistema = (
        "Voce e um curador de cinema genial. O usuario vai te passar uma musica e voce deve sugerir " +
        "EXATAMENTE UM filme que compartilhe exatamente da mesma atmosfera emocional, paleta de cores " +
        "subtendida, ritmo psicologico ou alma lirica dessa musica. " +
        "Nao se limite a conexoes obvias. Pense na vibe.\n\n" +

        "CRITICO: Voce DEVE sugerir um filme REAL existente no banco de dados do TMDb. " +
        "PROIBIDO inventar titulos de filmes. Use APENAS o titulo original ou oficial em ingles/portugues. " +
        "NAO use caracteres asiaticos (como chines, japones, coreano) a menos que seja um filme " +
        "autenticamente asiatico com titulo original nesses caracteres. " +
        "Se nao tiver certeza, escolha um filme classico e bem conhecido.\n\n" +

        "Sua resposta DEVE ser estritamente um formato JSON valido (sem qualquer tipo de formatacao markdown, " +
        "apenas as chaves brutas). O JSON deve conter as seguintes chaves exatas:\n" +
        "{\n" +
        '  "filme_sugerido": "Nome exato do filme (de preferencia o titulo original em ingles ou o mais conhecido)",\n' +
        '  "ano_filme": "Ano de lancamento do filme sugerido (Apenas os 4 digitos numericos, ex: 2002)",\n' +
        '  "justificativa_vibe": "Uma explicacao poetica, profunda e envolvente (em portugues, ate 4 frases) conectando sentimentos da musica/letra com o filme."\n' +
        "}"
    );

    // Monta o conteudo do usuario: musica + letra + contexto extra (injeção crítica)
    let conteudo_usuario = `Musica: '${nome_musica}' do artista '${artista}'.\n`;
    if (letra) {
        conteudo_usuario += `Use a letra da musica para capturar a essencia poetica profunda:\n${letra}\n\n`;
    } else {
        conteudo_usuario += "(Nao encontramos a letra no banco de dados, baseie-se no tema geral da musica).\n\n";
    }
    if (contexto_extra) {
        conteudo_usuario += `Contexto historico, significado e fatos adicionais sobre a musica para te ajudar na escolha:\n${contexto_extra}\n`;
    }

    const dados_requisicao = {
        model: "openrouter/free",
        temperature: 0.3,
        messages: [
            { role: "system", content: prompt_sistema },
            { role: "user", content: conteudo_usuario }
        ]
    };

    try {
        const resp = await fetch(URL_OPENROUTER, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${env.OPENROUTER_API_KEY}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(dados_requisicao),
            timeout: 25000
        });

        if (!resp.ok) return null;

        const data = await resp.json();
        let texto_ia = data.choices?.[0]?.message?.content?.trim();
        if (!texto_ia) return null;

        // Remove eventuais poluicoes de markdown
        texto_ia = texto_ia.replace(/```json/g, '').replace(/```/g, '').trim();

        // Tenta parse direto
        try {
            return JSON.parse(texto_ia);
        } catch (_) {
            // Fallback: regex para extrair JSON (equivalente ao re.DOTALL do Python)
            const match_json = texto_ia.match(/\{[\s\S]*\}/);
            if (match_json) {
                try {
                    return JSON.parse(match_json[0]);
                } catch (_) {
                    return null;
                }
            }
            return null;
        }
    } catch (_) {
        return null;
    }
}

// ==========================================
// 3.5 FALLBACK DE FILME (DUCKDUCKGO)
// ==========================================
async function buscar_dados_filme_duckduckgo(nome_filme, ano) {
    const termo_busca = ano ? `${nome_filme} ${ano} filme sinopse` : `${nome_filme} filme sinopse`;
    const resultados = await buscar_duckduckgo(termo_busca);
    if (!resultados) return null;

    // Tenta extrair mencao a diretor
    let diretor = "Disponivel na Web";
    const dirRegex = /(?:dire[cç][aã]o\s+(?:de\s+)?|diretor[:\s]+|dirigido\s+por\s+)([A-ZÀ-Ú][A-Za-zÀ-Ú\s]+)/i;
    const dirMatch = resultados.match(dirRegex);
    if (dirMatch) {
        diretor = dirMatch[1].trim();
    }

    return {
        sinopse: resultados.substring(0, 2000),
        diretor: diretor
    };
}

// ==========================================
// 3. DADOS COMPLEMENTARES DO FILME (TMDb)
// ==========================================
async function obter_detalhes_filme_tmdb(nome_filme, ano_filme, env) {
    if (!env.TMDB_API_KEY) return null;

    const params_busca = new URLSearchParams({
        api_key: env.TMDB_API_KEY,
        query: nome_filme,
        language: 'pt-BR'
    });

    // Se o ano foi fornecido, adiciona como filtro
    if (ano_filme && /^\d{4}$/.test(ano_filme)) {
        params_busca.set('year', ano_filme);
    }

    try {
        const resp_busca = await fetch(`${URL_TMDB_BUSCA}?${params_busca}`, { timeout: 10000 });
        if (!resp_busca.ok) return null;

        const busca_data = await resp_busca.json();
        if (!busca_data.results || busca_data.results.length === 0) return null;

        const filme_basico = busca_data.results[0];
        const filme_id = filme_basico.id;

        // Detalhes do filme (pt-BR)
        const params_detalhes = new URLSearchParams({
            api_key: env.TMDB_API_KEY,
            language: 'pt-BR'
        });
        const resp_detalhes = await fetch(`${URL_TMDB_BASE}/${filme_id}?${params_detalhes}`, { timeout: 10000 });
        const detalhes_data = await resp_detalhes.json();

        // Creditos
        const params_creditos = new URLSearchParams({ api_key: env.TMDB_API_KEY });
        const resp_creditos = await fetch(`${URL_TMDB_BASE}/${filme_id}/credits?${params_creditos}`, { timeout: 10000 });
        const creditos_data = await resp_creditos.json();

        let diretor = "Nao encontrado";
        if (creditos_data.crew) {
            for (const pessoa of creditos_data.crew) {
                if (pessoa.job === "Director") {
                    diretor = pessoa.name;
                    break;
                }
            }
        }

        // Imagens (ate 15 backdrops)
        const resp_imagens = await fetch(`${URL_TMDB_BASE}/${filme_id}/images?api_key=${env.TMDB_API_KEY}`, { timeout: 10000 });
        const imagens_data = await resp_imagens.json();

        const cenas = [];
        if (imagens_data.backdrops) {
            for (const backdrop of imagens_data.backdrops.slice(0, 15)) {
                cenas.push(`https://image.tmdb.org/t/p/w780${backdrop.file_path}`);
            }
        }

        // Sinopse: fallback pt-BR -> en-US se estiver vazia
        let sinopse = filme_basico.overview || "";
        if (!sinopse || sinopse.trim() === "") {
            const params_en = new URLSearchParams({
                api_key: env.TMDB_API_KEY,
                language: 'en-US'
            });
            const resp_en = await fetch(`${URL_TMDB_BASE}/${filme_id}?${params_en}`, { timeout: 10000 });
            const data_en = await resp_en.json();
            sinopse = data_en.overview || "Sem sinopse disponivel.";
        }

        return {
            id_tmdb: filme_id,
            titulo_pt: filme_basico.title,
            titulo_original: filme_basico.original_title,
            ano: filme_basico.release_date ? filme_basico.release_date.substring(0, 4) : "----",
            sinopse: sinopse || "Sem sinopse disponivel.",
            poster: filme_basico.poster_path
                        ? `https://image.tmdb.org/t/p/w500${filme_basico.poster_path}`
                        : null,
            diretor: diretor,
            imdb_id: detalhes_data.imdb_id || null,
            cenas: cenas
        };

    } catch (_) {
        return null;
    }
}

// ==========================================
// 4. WORKER HANDLER PRINCIPAL
// ==========================================
export default {
    async fetch(request, env) {
        // CORS headers obrigatorios
        const cors_headers = {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization',
            'Content-Type': 'application/json'
        };

        // Preflight CORS
        if (request.method === 'OPTIONS') {
            return new Response(null, {
                status: 204,
                headers: cors_headers
            });
        }

        const url = new URL(request.url);
        const path = url.pathname;

        // Health check
        if (request.method === 'GET' && path === '/api/health') {
            return new Response(JSON.stringify({ status: 'ok', message: 'Moovibe API is running' }, null, 2), {
                status: 200,
                headers: cors_headers
            });
        }

        // Endpoint principal
        if (request.method === 'POST' && path === '/api/recommend') {
            try {
                const body = await request.json();
                const nome_musica = (body.nome_musica || '').trim();
                const artista = (body.artista || '').trim();

                if (!nome_musica) {
                    return new Response(JSON.stringify({ error: 'nome_musica é obrigatorio' }), {
                        status: 400,
                        headers: cors_headers
                    });
                }

                // ==========================================
                // FLUXO DE ORQUESTRACAO (main do app.py)
                // ==========================================

                // 1. Buscar letra no LRCLIB
                let letra = await buscar_letra_musica(nome_musica, artista);

                // Fallback DuckDuckGo se LRCLIB falhar
                if (!letra) {
                    letra = await buscar_letra_duckduckgo(nome_musica, artista);
                }

                // 2. Buscar contexto extra (Genius primeiro, depois DuckDuckGo)
                let contexto_extra = null;
                contexto_extra = await buscar_contexto_genius(nome_musica, artista, env);

                if (!contexto_extra) {
                    contexto_extra = await buscar_contexto_duckduckgo(nome_musica, artista);
                }

                // 3. Chamar IA (OpenRouter)
                const recomendacao_ia = await obter_recomendacao_ia(
                    nome_musica, artista, letra, contexto_extra, env
                );

                if (!recomendacao_ia) {
                    return new Response(JSON.stringify({ error: 'Falha ao obter recomendacao da IA. Tente novamente.' }), {
                        status: 500,
                        headers: cors_headers
                    });
                }

                const nome_filme_ia  = recomendacao_ia.filme_sugerido;
                const ano_filme_ia   = recomendacao_ia.ano_filme || '';
                const justificativa  = recomendacao_ia.justificativa_vibe;

                // 4. Buscar dados no TMDb (com ano como filtro se disponivel)
                let dados_filme = await obter_detalhes_filme_tmdb(nome_filme_ia, ano_filme_ia, env);

                // Fallback se TMDb falhou ou sinopse vazia
                if (!dados_filme || !dados_filme.sinopse || dados_filme.sinopse === "Sem sinopse disponivel.") {
                    const fallback_ddg = await buscar_dados_filme_duckduckgo(nome_filme_ia, ano_filme_ia);
                    if (fallback_ddg) {
                        dados_filme = {
                            id_tmdb: null,
                            titulo_pt: nome_filme_ia,
                            titulo_original: nome_filme_ia,
                            ano: ano_filme_ia || "Nao informado",
                            sinopse: fallback_ddg.sinopse,
                            poster: null,
                            diretor: fallback_ddg.diretor,
                            imdb_id: null,
                            cenas: []
                        };
                    }
                }

                // 5. Montar resultado final (igual ao app.py)
                const resultado = {
                    song: nome_musica,
                    artist: artista,
                    movie: {
                        title: dados_filme?.titulo_pt || nome_filme_ia,
                        original_title: dados_filme?.titulo_original || nome_filme_ia,
                        release_year: dados_filme?.ano || (ano_filme_ia || "Nao informado"),
                        director: dados_filme?.diretor || "Nao encontrado",
                        synopsis: dados_filme?.sinopse || "Sinopse nao disponivel.",
                        poster_url: dados_filme?.poster || null,
                        stills: dados_filme?.cenas ? dados_filme.cenas.slice(0, 3) : [],
                        ai_explanation: `<p>${justificativa}</p>`,
                        vibe_title: "VIBE ENCONTRADA",
                        tags: ["CINEMATICO", "EMOCIONAL", "PROFUNDO", "UNICO"],
                        imdb_url: dados_filme?.imdb_id
                            ? `https://www.imdb.com/title/${dados_filme.imdb_id}/`
                            : `https://www.imdb.com/find?q=${encodeURIComponent(nome_filme_ia)}`,
                        letterboxd_url: dados_filme?.id_tmdb
                            ? `https://letterboxd.com/tmdb/${dados_filme.id_tmdb}`
                            : `https://letterboxd.com/search/${encodeURIComponent(nome_filme_ia)}/`,
                        tiktok_url: `https://www.tiktok.com/search?q=${encodeURIComponent(nome_filme_ia + ' edit')}`
                    }
                };

                return new Response(JSON.stringify(resultado, null, 2), {
                    status: 200,
                    headers: cors_headers
                });

            } catch (e) {
                return new Response(JSON.stringify({ error: 'Erro interno: ' + e.message }), {
                    status: 500,
                    headers: cors_headers
                });
            }
        }

        // Rota nao encontrada
        return new Response(JSON.stringify({ error: 'Rota nao encontrada' }), {
            status: 404,
            headers: cors_headers
        });
    }
};