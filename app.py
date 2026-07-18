import os
import json
import re
import requests
import urllib.parse
from dotenv import load_dotenv

# --- NOVAS BIBLIOTECAS ---
# lyricsgenius: busca letras e significado/descrição de músicas via Genius API
# duckduckgo_search: fallback de busca na web quando as APIs de música falham
import lyricsgenius

# Importa e suprime warning do duckduckgo_search (rename para ddgs)
import warnings
with warnings.catch_warnings():
    warnings.simplefilter("ignore", RuntimeWarning)
    from duckduckgo_search import DDGS

# Carrega as variaveis de ambiente do seu arquivo .env
load_dotenv()

OPENROUTER_API_KEY = os.getenv("OPENROUTER_API_KEY")
TMDB_API_KEY = os.getenv("TMDB_API_KEY")
GENIUS_API_KEY = os.getenv("GENIUS_API_KEY")  # Chave para a API do Genius (lyricsgenius)

# Evita que editores linkifiquem as URLs e quebrem o código Python
URL_LRCLIB = "https://" + "lrclib.net/api/search"
URL_OPENROUTER = "https://" + "openrouter.ai/api/v1/chat/completions"
URL_TMDB_BUSCA = "https://" + "api.themoviedb.org/3/search/movie"
URL_TMDB_BASE = "https://" + "api.themoviedb.org/3/movie"

# ==========================================
# 1. BUSCA DE LETRAS (LRCLIB API - Gratis)
# ==========================================
def buscar_letra_musica(nome_musica, artista):
    """Busca a letra da musica de forma gratuita usando a API do LRCLIB."""
    params = {
        "track_name": nome_musica,
        "artist_name": artista
    }
    try:
        resposta = requests.get(URL_LRCLIB, params=params, timeout=10)
        if resposta.status_code == 200 and resposta.json():
            return resposta.json()[0].get("plainLyrics", "")
    except Exception:
        pass
    return None


# ==========================================
# 1.5 BUSCA DE CONTEXTO DA MUSICA (GENIUS)
# ==========================================
def buscar_contexto_genius(nome_musica, artista):
    """
    Busca o significado/contexto da musica usando a API do Genius (lyricsgenius).
    Retorna a descricao da musica ou None se falhar.
    """
    if not GENIUS_API_KEY:
        print("[DEBUG] GENIUS_API_KEY nao configurada. Pulando busca no Genius.")
        return None

    try:
        # Instancia o cliente do Genius
        genius = lyricsgenius.Genius(
            GENIUS_API_KEY,
            timeout=10,
            retries=2
        )
        genius.verbose = False  # Silencia logs automaticos da biblioteca

        # Busca a musica pelo nome e artista
        musica = genius.search_song(nome_musica, artista)

        if musica and hasattr(musica, 'description'):
            # A descricao do Genius geralmente contem o significado/contexto
            descricao = musica.description
            if descricao:
                # Remove tags HTML que podem vir junto
                descricao_limpa = re.sub(r'<[^>]+>', '', descricao)
                print("[GENIUS] Contexto da musica encontrado com sucesso.")
                return descricao_limpa[:2000]  # Limita a 2000 caracteres

    except Exception as e:
        erro_str = str(e)
        if "401" in erro_str or "invalid_token" in erro_str or "Invalid" in erro_str:
            print("[GENIUS] Aviso: Token da API do Genius expirado ou invalido no seu .env. Pulando para o fallback.")
        else:
            print(f"[GENIUS] Erro ao buscar contexto: {e}")

    return None


# ==========================================
# 1.6 BUSCA DE LETRA (DUCKDUCKGO - FALLBACK)
# ==========================================
def buscar_letra_duckduckgo(nome_musica, artista):
    """
    Fallback para letra: busca na web por "{musica} {artista} lyrics" usando DuckDuckGo.
    Retorna o texto dos primeiros resultados como pseudo-letra ou None se falhar.
    """
    try:
        termo_busca = f"{nome_musica} {artista} lyrics"
        print(f"[DUCKDUCKGO] Buscando na web por: '{termo_busca}'...")
        resultados_texto = []

        with warnings.catch_warnings():
            warnings.simplefilter("ignore", RuntimeWarning)
            with DDGS() as ddgs:
                for i, resultado in enumerate(ddgs.text(termo_busca, max_results=3)):
                    titulo = resultado.get("title", "")
                    descricao = resultado.get("body", "")
                    if titulo or descricao:
                        resultados_texto.append(f"Resultado {i+1}: {titulo}\n{descricao}")

        if resultados_texto:
            print("[DUCKDUCKGO] ✓ Sucesso! Letra extraida da web e preparada para a IA.")
            return "\n\n".join(resultados_texto)
        else:
            print("[DUCKDUCKGO] ⚠ Nenhum resultado encontrado na web para esta busca.")

    except Exception as e:
        print(f"[DUCKDUCKGO] Erro na busca de letra: {e}")

    return None


# ==========================================
# 1.7 BUSCA DE CONTEXTO (DUCKDUCKGO - FALLBACK)
# ==========================================
def buscar_contexto_duckduckgo(nome_musica, artista):
    """
    Fallback: busca na web sobre o significado da musica usando DuckDuckGo.
    Retorna um texto com os 2-3 primeiros resultados ou None se falhar.
    """
    try:
        termo_busca = f"{nome_musica} {artista} song meaning"
        print(f"[DUCKDUCKGO] Buscando na web por: '{termo_busca}'...")
        resultados_texto = []

        with warnings.catch_warnings():
            warnings.simplefilter("ignore", RuntimeWarning)
            with DDGS() as ddgs:
                for i, resultado in enumerate(ddgs.text(termo_busca, max_results=3)):
                    titulo = resultado.get("title", "")
                    descricao = resultado.get("body", "")
                    if titulo or descricao:
                        resultados_texto.append(f"Resultado {i+1}: {titulo}\n{descricao}")

        if resultados_texto:
            print("[DUCKDUCKGO] ✓ Sucesso! Contexto extraido da web e preparado para a IA.")
            return "\n\n".join(resultados_texto)
        else:
            print("[DUCKDUCKGO] ⚠ Nenhum resultado encontrado na web para esta busca.")

    except Exception as e:
        print(f"[DUCKDUCKGO] Erro na busca de contexto: {e}")

    return None


# ==========================================
# 2. INTELIGENCIA ARTIFICIAL (OpenRouter)
# ==========================================
def obter_recomendacao_ia(nome_musica, artista, letra, contexto_extra=None):
    """
    Manda a musica, artista, letra e contexto extra para a IA e recebe a indicacao de filme.
    Se contexto_extra for fornecido (Genius ou DuckDuckGo), ele eh concatenado ao prompt.
    """
    headers = {
        "Authorization": f"Bearer {OPENROUTER_API_KEY}",
        "Content-Type": "application/json"
    }

    # Prompt extremamente rigoroso para evitar alucinacao de titulos
    prompt_sistema = (
        "Voce e um curador de cinema genial. O usuario vai te passar uma musica e voce deve sugerir "
        "EXATAMENTE UM filme que compartilhe exatamente da mesma atmosfera emocional, paleta de cores "
        "subtendida, ritmo psicologico ou alma lirica dessa musica. "
        "Nao se limite a conexoes obvias. Pense na vibe.\n\n"

        "CRITICO: Voce DEVE sugerir um filme REAL existente no banco de dados do TMDb. "
        "PROIBIDO inventar titulos de filmes. Use APENAS o titulo original ou oficial em ingles/portugues. "
        "NAO use caracteres asiaticos (como chines, japones, coreano) a menos que seja um filme "
        "autenticamente asiatico com titulo original nesses caracteres. "
        "Se nao tiver certeza, escolha um filme classico e bem conhecido.\n\n"

        "Sua resposta DEVE ser estritamente um formato JSON valido (sem qualquer tipo de formatacao markdown, "
        "apenas as chaves brutas). O JSON deve conter as seguintes chaves exatas:\n"
        "{\n"
        '  "filme_sugerido": "Nome exato do filme (de preferencia o titulo original em ingles ou o mais conhecido)",\n'
        '  "ano_filme": "Ano de lancamento do filme sugerido (Apenas os 4 digitos numericos, ex: 2002)",\n'
        '  "justificativa_vibe": "Uma explicacao poetica, profunda e envolvente (em portugues, ate 4 frases) conectando sentimentos da musica/letra com o filme."\n'
        "}"
    )

    # Monta o conteudo do usuario de forma estruturada: musica + letra + contexto extra
    conteudo_usuario = f"Musica: '{nome_musica}' do artista '{artista}'.\n"
    if letra:
        conteudo_usuario += f"Use a letra da musica para capturar a essencia poetica profunda:\n{letra}\n\n"
    else:
        conteudo_usuario += "(Nao encontramos a letra no banco de dados, baseie-se no tema geral da musica).\n\n"
    if contexto_extra:
        conteudo_usuario += f"Contexto historico, significado e fatos adicionais sobre a musica para te ajudar na escolha:\n{contexto_extra}\n"

    dados_requisicao = {
        "model": "openrouter/free",
        "temperature": 0.3,  # Reduzido para evitar alucinacoes (mais deterministico)
        "messages": [
            {"role": "system", "content": prompt_sistema},
            {"role": "user", "content": conteudo_usuario}
        ]
    }

    try:
        resposta = requests.post(URL_OPENROUTER, headers=headers, json=dados_requisicao, timeout=25)
        resposta.raise_for_status()
        retorno = response_json = resposta.json()
        texto_ia = response_json['choices'][0]['message']['content'].strip()

        # Remove eventuais poluicoes de markdown que algumas IAs geram
        texto_ia = texto_ia.replace("```json", "").replace("```", "").strip()

        # Tenta fazer o parse do JSON
        try:
            return json.loads(texto_ia)
        except json.JSONDecodeError:
            # Se falhar, tenta extrair o JSON com regex (caso a IA adicione texto antes/depois)
            print("[DEBUG] JSON direto falhou. Tentando extrair com regex...")
            print(f"[DEBUG] Texto bruto retornado pela IA:\n{texto_ia}")

            # Regex gananciosa para capturar tudo entre a primeira e a ultima chave
            match_json = re.search(r'(\{.*\})', texto_ia, re.DOTALL)
            if match_json:
                json_candidato = match_json.group(0)
                try:
                    return json.loads(json_candidato)
                except json.JSONDecodeError:
                    print(f"[DEBUG] Regex tambem falhou. Candidato JSON: {json_candidato}")
                    return None
            else:
                print("[DEBUG] Nenhum bloco JSON encontrado no texto.")
                return None

    except Exception as e:
        print(f"Erro ao conversar com a IA ou decodificar o JSON: {e}")
        return None


# ==========================================
# 3.5 FALLBACK DE FILME (DUCKDUCKGO)
# ==========================================
def buscar_dados_filme_duckduckgo(nome_filme, ano):
    """
    Fallback para quando o TMDb nao encontra dados do filme.
    Busca na web por informacoes basicas (sinopse, diretor) usando DuckDuckGo.
    Retorna um dicionario com os dados encontrados ou None se falhar.
    """
    try:
        # Monta query inteligente: tenta com ano primeiro, depois sem
        if ano:
            termo_busca = f"{nome_filme} {ano} filme sinopse"
        else:
            termo_busca = f"{nome_filme} filme sinopse"

        print(f"[DUCKDUCKGO] 🔍 TMDb nao encontrou dados para o filme. Buscando informacoes na web por: '{nome_filme}'...")
        resultados_texto = []

        with warnings.catch_warnings():
            warnings.simplefilter("ignore", RuntimeWarning)
            with DDGS() as ddgs:
                for i, resultado in enumerate(ddgs.text(termo_busca, max_results=3)):
                    titulo = resultado.get("title", "")
                    descricao = resultado.get("body", "")
                    if titulo or descricao:
                        resultados_texto.append(f"Resultado {i+1}: {titulo}\n{descricao}")

        if resultados_texto:
            sinopse_web = "\n\n".join(resultados_texto)
            print("[DUCKDUCKGO] ✓ Sucesso! Dados basicos do filme recuperados da web.")

            # Tenta extrair mencao a diretor nos resultados
            diretor_web = "Disponivel na Web"
            for texto in resultados_texto:
                # Procura padroes como "direcao de", "diretor", "dirigido por"
                match_dir = re.search(r'(?:dire[cç][aã]o\s+(?:de\s+)?|diretor[:\s]+|dirigido\s+por\s+)([A-ZÀ-Ú][A-Za-zÀ-Ú\s]+)', texto, re.IGNORECASE)
                if match_dir:
                    diretor_web = match_dir.group(1).strip()
                    break

            return {
                "sinopse": sinopse_web[:2000],
                "diretor": diretor_web
            }
        else:
            print("[DUCKDUCKGO] ⚠ Nenhum resultado encontrado na web para este filme.")

    except Exception as e:
        print(f"[DUCKDUCKGO] Erro na busca de dados do filme: {e}")

    return None


# ==========================================
# 3. DADOS COMPLEMENTARES DO FILME (TMDb)
# ==========================================
def obter_detalhes_filme_tmdb(nome_filme):
    """Busca poster, sinopse, diretor, ID do IMDb e cenas de fundo no TMDb."""
    if not TMDB_API_KEY:
        return None

    params_busca = {
        "api_key": TMDB_API_KEY,
        "query": nome_filme,
        "language": "pt-BR"
    }

    try:
        resp_busca = requests.get(URL_TMDB_BUSCA, params=params_busca, timeout=10)
        if resp_busca.status_code != 200 or not resp_busca.json().get("results"):
            return None

        filme_basico = resp_busca.json()["results"][0]
        filme_id = filme_basico["id"]

        url_detalhes = f"{URL_TMDB_BASE}/{filme_id}"
        params_detalhes = {"api_key": TMDB_API_KEY, "language": "pt-BR"}
        resp_detalhes = requests.get(url_detalhes, params=params_detalhes, timeout=10).json()

        url_creditos = f"{URL_TMDB_BASE}/{filme_id}/credits"
        resp_creditos = requests.get(url_creditos, params={"api_key": TMDB_API_KEY}, timeout=10).json()

        diretor = "Nao encontrado"
        for pessoa in resp_creditos.get("crew", []):
            if pessoa.get("job") == "Director":
                diretor = pessoa.get("name")
                break

        # Busca imagens sem filtro de idioma (remove include_image_language)
        # para pegar qualquer imagem disponivel associada ao filme
        url_imagens = f"{URL_TMDB_BASE}/{filme_id}/images"
        resp_imagens = requests.get(url_imagens, params={"api_key": TMDB_API_KEY}, timeout=10).json()

        # Captura entre 10 e 15 backdrops (alem do poster principal)
        cenas = []
        for backdrop in resp_imagens.get("backdrops", [])[:15]:  # Agora pega ate 15 backdrops
            cenas.append(f"https://image.tmdb.org/t/p/w780{backdrop['file_path']}")

        dados_filme = {
            "id_tmdb": filme_id,
            "titulo_pt": filme_basico.get("title"),
            "titulo_original": filme_basico.get("original_title"),
            "ano": filme_basico.get("release_date", "----")[:4],
            "sinopse": filme_basico.get("overview", "Sem sinopse disponivel."),
            "poster": f"https://image.tmdb.org/t/p/w500{filme_basico.get('poster_path')}" if filme_basico.get('poster_path') else None,
            "diretor": diretor,
            "imdb_id": resp_detalhes.get("imdb_id"),
            "cenas": cenas
        }
        return dados_filme

    except Exception as e:
        print(f"Erro ao consultar o TMDb: {e}")
        return None


# ==========================================
# 4. ORQUESTRACAO & ENTRADA (Main)
# ==========================================
def main():
    print()
    print("==================================================")
    print("Moovibe")
    print("==================================================")

    if not OPENROUTER_API_KEY:
        print("[ERRO] OPENROUTER_API_KEY nao encontrada no seu arquivo .env!")
        return
    if not TMDB_API_KEY:
        print("[AVISO] TMDB_API_KEY nao configurada. O app funcionara apenas com recomendacoes de texto.")

    while True:
        print()
        nome_musica = input("Digite o nome da musica (or 'sair'): ").strip()
        if nome_musica.lower() == 'sair':
            print()
            print("Até a próxima! Bom filme!")
            break

        if not nome_musica:
            continue

        artista = input("Digite o nome do artista/banda: ").strip()
        if not artista:
            print("Por favor, digite o artista também para termos precisao.")
            continue

        print()
        print("Buscando letra no banco de dados...")
        letra = buscar_letra_musica(nome_musica, artista)
        if letra:
            print("Letra encontrada no banco de dados (LRCLIB).")
        else:
            print("Letra nao encontrada no banco. Buscando na web (DuckDuckGo)...")
            letra = buscar_letra_duckduckgo(nome_musica, artista)
            if letra:
                print("Letra encontrada via busca na web (DuckDuckGo).")
            else:
                print("Letra nao encontrada. Prosseguindo apenas com a energia da musica.")

        # --- NOVO: Busca contexto da musica (Genius primeiro, depois DuckDuckGo como fallback) ---
        contexto_extra = None

        print("Buscando significado/contexto da musica (Genius)...")
        contexto_extra = buscar_contexto_genius(nome_musica, artista)

        if not contexto_extra:
            print("Genius sem resultados. Buscando na web (DuckDuckGo)...")
            contexto_extra = buscar_contexto_duckduckgo(nome_musica, artista)

        if contexto_extra:
            print("Contexto adicional obtido com sucesso. Enviando para a IA...")
        else:
            print("Nenhum contexto adicional encontrado. Seguindo apenas com a letra.")

        # --- FIM NOVO ---

        print("Analisando a vibe profunda...")
        recomendacao_ia = obter_recomendacao_ia(nome_musica, artista, letra, contexto_extra)

        if not recomendacao_ia:
            print("Falha ao obter recomendacao da IA. Tente novamente.")
            continue

        nome_filme_ia = recomendacao_ia["filme_sugerido"]
        ano_filme_ia = recomendacao_ia.get("ano_filme", "")
        justificativa = recomendacao_ia["justificativa_vibe"]

        # Se a IA forneceu o ano, inclui na busca do TMDb para maior precisao
        termo_busca_tmdb = nome_filme_ia
        if ano_filme_ia:
            termo_busca_tmdb = f"{nome_filme_ia} {ano_filme_ia}"

        print(f"Consultando TMDb para coletar as midias de '{termo_busca_tmdb}'...")
        dados_filme = obter_detalhes_filme_tmdb(termo_busca_tmdb)

        # --- FALLBACK: Se TMDb falhou ou sinopse vazia, busca na web ---
        if not dados_filme or not dados_filme.get("sinopse") or dados_filme["sinopse"] in ("Sem sinopse disponivel.", ""):
            fallback_ddg = buscar_dados_filme_duckduckgo(nome_filme_ia, ano_filme_ia)
            if fallback_ddg:
                dados_filme = {
                    "id_tmdb": None,
                    "titulo_pt": nome_filme_ia,
                    "titulo_original": nome_filme_ia,
                    "ano": ano_filme_ia if ano_filme_ia else "Nao informado",
                    "sinopse": fallback_ddg["sinopse"],
                    "poster": None,
                    "diretor": fallback_ddg["diretor"],
                    "imdb_id": None,
                    "cenas": []
                }

        print()
        print("==================================================")
        print("FILME RECOMENDADO:")
        print("==================================================")

        if dados_filme:
            print(f"Titulo: {dados_filme['titulo_pt']} ({dados_filme['titulo_original']})")
            print(f"Ano de Lancamento: {dados_filme['ano']}")
            print(f"Direcao: {dados_filme['diretor']}")
            print()
            print(f"Sinopse:\n{dados_filme['sinopse']}")
            print()
            print(f"Link do Poster: {dados_filme['poster']}")
            if dados_filme['cenas']:
                print()
                print("Cenas do Filme (Backdrops):")
                for i, cena in enumerate(dados_filme['cenas'], 1):
                    print(f"   Cena {i}: {cena}")
        else:
            print(f"Filme sugerido pela IA: {nome_filme_ia}")

        print()
        print("--------------------------------------------------")
        print("POR QUE COMBINA? (VIBE COMPARISON):")
        print("--------------------------------------------------")
        print(justificativa)
        print("--------------------------------------------------")

        print("LINKS IMPORTANTES:")
        print("--------------------------------------------------")

        if dados_filme and dados_filme.get("imdb_id"):
            print(f"IMDb: https://www.imdb.com/title/{dados_filme['imdb_id']}/")
        else:
            term_imdb = urllib.parse.quote(nome_filme_ia)
            print(f"IMDb (Busca): https://www.imdb.com/find?q={term_imdb}")

        if dados_filme and dados_filme.get("id_tmdb"):
            print(f"Letterboxd: https://letterboxd.com/tmdb/{dados_filme['id_tmdb']}")
        else:
            term_lb = urllib.parse.quote(nome_filme_ia)
            print(f"Letterboxd (Busca): https://letterboxd.com/search/{term_lb}/")

        tiktok_query = urllib.parse.quote(f"{nome_filme_ia} edit")
        print(f"TikTok (Navegador): https://www.tiktok.com/search?q={tiktok_query}")
        print(f"TikTok (Abrir direto no App): tiktok://search?keyword={tiktok_query}")
        print("==================================================")

if __name__ == "__main__":
    main()