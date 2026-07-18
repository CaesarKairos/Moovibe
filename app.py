import os
import json
import re
import requests
import urllib.parse
from dotenv import load_dotenv

# --- BIBLIOTECAS ---
import lyricsgenius

# Carrega as variaveis de ambiente do seu arquivo .env
load_dotenv()

OPENROUTER_API_KEY = os.getenv("OPENROUTER_API_KEY")
TMDB_API_KEY = os.getenv("TMDB_API_KEY")
GENIUS_API_KEY = os.getenv("GENIUS_API_KEY")

# Evita que editores linkifiquem as URLs e quebrem o código Python
URL_LRCLIB = "https://" + "lrclib.net/api/search"
URL_OPENROUTER = "https://" + "openrouter.ai/api/v1/chat/completions"
URL_TMDB_BUSCA = "https://" + "api.themoviedb.org/3/search/movie"
URL_TMDB_BASE = "https://" + "api.themoviedb.org/3/movie"
URL_WIKIPEDIA_PT = "https://" + "pt.wikipedia.org/api/rest_v1/page/summary/"
URL_WIKIPEDIA_EN = "https://" + "en.wikipedia.org/api/rest_v1/page/summary/"


# ==========================================
# UTILITÁRIO: Limpeza agressiva de termos
# ==========================================
def limpar_termo_musica(termo):
    """
    Remove sufixos promocionais, ruídos e anos dos títulos.
    Ex: 'Style (2014)' vira 'Style', '(Official Video)' removido, 'Feat.' removido.
    """
    termo_limpo = termo
    # Remove ano entre parenteses: (2014), (1999), etc.
    termo_limpo = re.sub(r'\(\d{4}\)', '', termo_limpo)
    # Remove ano entre colchetes: [2014], [1999], etc.
    termo_limpo = re.sub(r'\[\d{4}\]', '', termo_limpo)
    # Remove parenteses com palavras-chave promocionais
    termo_limpo = re.sub(
        r'\([^)]*(?:official|music\s*video|remaster|remastered|audio|lyric|video|visualizer|live|feat\.?|ft\.?|prod\.?|explicit|clean|edit|version|4k|hd|360|clip|single|lyrics|audio|official\s*audio)[^)]*\)',
        '', termo_limpo, flags=re.IGNORECASE
    )
    # Remove colchetes com palavras-chave promocionais
    termo_limpo = re.sub(
        r'\[[^\]]*(?:official|music\s*video|remaster|remastered|audio|lyric|video|visualizer|live|feat\.?|ft\.?|prod\.?|explicit|clean|edit|version|4k|hd|360|clip|single|lyrics|audio|official\s*audio)[^\]]*\]',
        '', termo_limpo, flags=re.IGNORECASE
    )
    # Remove "Feat.", "Ft.", etc. no final do texto
    termo_limpo = re.sub(r'\s+(?:feat\.?|ft\.?)\..*$', '', termo_limpo, flags=re.IGNORECASE)
    # Remove "Feat.", "Ft.", etc. no meio do texto (preserva o artista principal)
    termo_limpo = re.sub(r'\s+[\(\[].*?(?:feat\.?|ft\.?).*?[\)\]]', '', termo_limpo, flags=re.IGNORECASE)
    return termo_limpo.strip()


# ==========================================
# 1. BUSCA DE LETRAS (LRCLIB API)
# ==========================================
def buscar_letra_musica(nome_musica, artista):
    """Busca a letra da musica usando a API gratuita do LRCLIB."""
    params = {"track_name": nome_musica, "artist_name": artista}
    try:
        resposta = requests.get(URL_LRCLIB, params=params, timeout=10)
        if resposta.status_code == 200 and resposta.json():
            return resposta.json()[0].get("plainLyrics", "")
    except Exception:
        pass
    return None


# ==========================================
# 1.5 BUSCA DE CONTEXTO — CAMADA 1: GENIUS
# ==========================================
def buscar_contexto_genius(nome_musica, artista):
    """
    CAMADA 1 do fallback de contexto.
    Busca o significado/contexto da musica usando a API do Genius (lyricsgenius).
    Antes de buscar, limpa o titulo removendo ruidos promocionais e anos.
    """
    if not GENIUS_API_KEY:
        print("[GENIUS] GENIUS_API_KEY nao configurada. Pulando.")
        return None

    try:
        # Limpeza agressiva do termo antes de buscar
        nome_musica_limpo = limpar_termo_musica(nome_musica)
        artista_limpo = limpar_termo_musica(artista) if artista else artista

        genius = lyricsgenius.Genius(GENIUS_API_KEY, timeout=10, retries=2)
        genius.verbose = False

        musica = genius.search_song(nome_musica_limpo, artista_limpo)

        if musica and hasattr(musica, 'description'):
            descricao = musica.description
            if descricao:
                descricao_limpa = re.sub(r'<[^>]+>', '', descricao)
                print("[GENIUS] Contexto da musica encontrado com sucesso.")
                return descricao_limpa[:2000]

    except Exception as e:
        erro_str = str(e)
        if "401" in erro_str or "invalid_token" in erro_str or "Invalid" in erro_str:
            print("[GENIUS] Token expirado ou invalido. Pulando para fallback.")
        else:
            print(f"[GENIUS] Erro: {e}")

    return None


# ==========================================
# 1.6 BUSCA DE CONTEXTO — CAMADA 2: WIKIPEDIA PT
# ==========================================
def buscar_contexto_wikipedia(nome_musica, artista):
    """
    CAMADA 2 do fallback de contexto.
    Busca na Wikipedia em portugues pelo resumo da musica.
    """
    try:
        termo_busca = f"{nome_musica} {artista}"
        termo_encoded = urllib.parse.quote(termo_busca)
        url = f"{URL_WIKIPEDIA_PT}{termo_encoded}"

        print(f"[WIKIPEDIA] Buscando contexto para: '{termo_busca}'...")

        headers = {"User-Agent": "Moovibe/1.0 (movie recommendation app)"}
        resposta = requests.get(url, headers=headers, timeout=10)

        if resposta.status_code == 200:
            dados = resposta.json()
            if dados.get("type") == "disambiguation":
                print("[WIKIPEDIA] Pagina de desambiguacao. Pulando.")
                return None

            extract = dados.get("extract", "")
            if extract:
                print("[WIKIPEDIA] Contexto encontrado com sucesso!")
                return extract[:2000]

        elif resposta.status_code == 404:
            print("[WIKIPEDIA] Pagina nao encontrada.")

    except Exception as e:
        print(f"[WIKIPEDIA] Erro: {e}")

    return None


# ==========================================
# 1.7 BUSCA DE CONTEXTO — CAMADA 3: OPENROUTER (FALLBACK DRÁSTICO)
# ==========================================
def buscar_contexto_ia_fallback(nome_musica, artista):
    """
    CAMADA 3 (medida drastica) do fallback de contexto.
    Se Genius e Wikipedia falharem, faz uma chamada rapida ao OpenRouter
    com um prompt ultra-curto para gerar um resumo do significado da musica.
    """
    if not OPENROUTER_API_KEY:
        return None

    print("[OPENROUTER FALLBACK] Gerando contexto via IA...")

    headers = {
        "Authorization": f"Bearer {OPENROUTER_API_KEY}",
        "Content-Type": "application/json"
    }

    prompt_curto = (
        f"Explique brevemente em um paragrafo de ate 3 linhas em portugues "
        f"o significado e contexto cultural da musica '{nome_musica}' de '{artista}'."
    )

    payload = {
        "model": "openrouter/free",
        "temperature": 0.3,
        "max_tokens": 300,
        "messages": [
            {"role": "user", "content": prompt_curto}
        ]
    }

    try:
        resposta = requests.post(URL_OPENROUTER, headers=headers, json=payload, timeout=15)
        resposta.raise_for_status()
        dados = resposta.json()
        texto = dados['choices'][0]['message']['content'].strip()
        if texto:
            print("[OPENROUTER FALLBACK] Contexto gerado com sucesso via IA!")
            return texto[:2000]
    except Exception as e:
        print(f"[OPENROUTER FALLBACK] Erro: {e}")

    return None


# ==========================================
# 1.8 ORQUESTRADOR DE CONTEXTO (3 CAMADAS)
# ==========================================
def buscar_contexto_musica(nome_musica, artista):
    """
    Orquestrador que executa o fallback em 3 camadas para obter
    o significado/contexto da musica:
      CAMADA 1: Genius API
      CAMADA 2: Wikipedia PT
      CAMADA 3: OpenRouter (chamada rapida)
    Retorna o texto do contexto ou None se todas falharem.
    """
    # CAMADA 1: Genius
    print("[CONTEXTO] CAMADA 1: Genius...")
    contexto = buscar_contexto_genius(nome_musica, artista)
    if contexto:
        return contexto

    # CAMADA 2: Wikipedia PT
    print("[CONTEXTO] CAMADA 2: Wikipedia PT...")
    contexto = buscar_contexto_wikipedia(nome_musica, artista)
    if contexto:
        return contexto

    # CAMADA 3: OpenRouter fallback
    print("[CONTEXTO] CAMADA 3: OpenRouter (fallback drastico)...")
    contexto = buscar_contexto_ia_fallback(nome_musica, artista)
    if contexto:
        return contexto

    print("[CONTEXTO] Todas as 3 camadas falharam. Seguindo sem contexto.")
    return None


# ==========================================
# 2. INTELIGENCIA ARTIFICIAL (OpenRouter)
# ==========================================
def obter_recomendacao_ia(nome_musica, artista, letra, contexto_extra=None):
    """
    Manda a musica, artista, letra e contexto extra para a IA e recebe a indicacao de filme.
    """
    headers = {
        "Authorization": f"Bearer {OPENROUTER_API_KEY}",
        "Content-Type": "application/json"
    }

    # Prompt endurecido: campo 'filme' (nao 'filme_sugerido'), proibicao absoluta de ano junto
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

        "REGRA ABSOLUTA: No campo 'filme', retorne APENAS o nome comercial puro do filme "
        "(em ingles ou portugues). E terminantemente PROIBIDO embutir o ano ao lado do nome do filme "
        "nesse campo. Por exemplo, retorne 'The Great Gatsby' e NUNCA 'The Great Gatsby 2013'. "
        "O ano de lancamento deve habitar estritamente e apenas o campo 'ano' do JSON.\n\n"

        "Sua resposta DEVE ser estritamente um formato JSON valido (sem qualquer tipo de formatacao markdown, "
        "apenas as chaves brutas). O JSON deve conter as seguintes chaves exatas:\n"
        "{\n"
        '  "filme": "Nome exato do filme (de preferencia o titulo original em ingles ou o mais conhecido, SEM o ano)",\n'
        '  "ano": "Ano de lancamento do filme sugerido (Apenas os 4 digitos numericos, ex: 2002)",\n'
        '  "justificativa": "Uma explicacao poetica, profunda e envolvente (em portugues, ate 4 frases) conectando sentimentos da musica/letra com o filme."\n'
        "}"
    )

    conteudo_usuario = f"Musica: '{nome_musica}' do artista '{artista}'.\n"
    if letra:
        conteudo_usuario += f"Use a letra da musica para capturar a essencia poetica profunda:\n{letra}\n\n"
    else:
        conteudo_usuario += "(Nao encontramos a letra no banco de dados, baseie-se no tema geral da musica).\n\n"
    if contexto_extra:
        conteudo_usuario += f"Contexto historico, significado e fatos adicionais sobre a musica para te ajudar na escolha:\n{contexto_extra}\n"

    dados_requisicao = {
        "model": "openrouter/free",
        "temperature": 0.3,
        "messages": [
            {"role": "system", "content": prompt_sistema},
            {"role": "user", "content": conteudo_usuario}
        ]
    }

    try:
        resposta = requests.post(URL_OPENROUTER, headers=headers, json=dados_requisicao, timeout=25)
        resposta.raise_for_status()
        texto_ia = resposta.json()['choices'][0]['message']['content'].strip()
        texto_ia = texto_ia.replace("```json", "").replace("```", "").strip()

        try:
            return json.loads(texto_ia)
        except json.JSONDecodeError:
            print("[DEBUG] JSON direto falhou. Tentando extrair com regex...")
            print(f"[DEBUG] Texto bruto:\n{texto_ia}")
            match_json = re.search(r'(\{.*\})', texto_ia, re.DOTALL)
            if match_json:
                try:
                    return json.loads(match_json.group(0))
                except json.JSONDecodeError:
                    print(f"[DEBUG] Regex tambem falhou. Candidato: {match_json.group(0)}")
                    return None
            print("[DEBUG] Nenhum JSON encontrado.")
            return None

    except Exception as e:
        print(f"Erro ao conversar com a IA: {e}")
        return None


# ==========================================
# 3. FALLBACK DE FILME (WIKIPEDIA API)
# ==========================================
def buscar_dados_filme_wikipedia(nome_filme, ano):
    """
    Fallback para quando o TMDb nao encontra dados do filme.
    Tenta Wikipedia PT, depois EN. Se falhar, retorna None.
    """
    try:
        termos_tentativa = []
        if ano:
            termos_tentativa.append(f"{nome_filme} ({ano})")
            termos_tentativa.append(f"{nome_filme} {ano}")
        termos_tentativa.append(nome_filme)

        # Tenta Wikipedia PT
        for termo in termos_tentativa:
            termo_encoded = urllib.parse.quote(termo)
            url = f"{URL_WIKIPEDIA_PT}{termo_encoded}"
            print(f"[WIKIPEDIA] Buscando filme: '{termo}'...")
            headers = {"User-Agent": "Moovibe/1.0 (movie recommendation app)"}
            resposta = requests.get(url, headers=headers, timeout=10)

            if resposta.status_code == 200:
                dados = resposta.json()
                if dados.get("type") == "disambiguation":
                    print(f"[WIKIPEDIA] Desambiguacao para '{termo}'. Tentando outro...")
                    continue
                extract = dados.get("extract", "")
                if extract:
                    print(f"[WIKIPEDIA] Dados do filme encontrados para '{termo}'.")
                    diretor = "Disponivel na Wikipedia"
                    match_dir = re.search(
                        r'(?:dire[cç][aã]o\s+(?:de\s+)?|diretor[:\s]+|dirigido\s+por\s+)([A-ZÀ-Ú][A-Za-zÀ-Ú\s]+)',
                        extract, re.IGNORECASE
                    )
                    if match_dir:
                        diretor = match_dir.group(1).strip()
                    return {"sinopse": extract[:2000], "diretor": diretor}
            elif resposta.status_code == 404:
                print(f"[WIKIPEDIA] Pagina nao encontrada para '{termo}'.")

        # Tenta Wikipedia EN
        for termo in ([f"{nome_filme} ({ano})"] if ano else []) + [nome_filme]:
            termo_encoded = urllib.parse.quote(termo)
            url = f"{URL_WIKIPEDIA_EN}{termo_encoded}"
            print(f"[WIKIPEDIA EN] Buscando filme: '{termo}'...")
            headers = {"User-Agent": "Moovibe/1.0 (movie recommendation app)"}
            resposta = requests.get(url, headers=headers, timeout=10)

            if resposta.status_code == 200:
                dados = resposta.json()
                if dados.get("type") == "disambiguation":
                    continue
                extract = dados.get("extract", "")
                if extract:
                    print(f"[WIKIPEDIA EN] Dados do filme encontrados para '{termo}'.")
                    diretor = "Disponivel na Wikipedia"
                    match_dir = re.search(
                        r'(?:directed\s+by\s+|director[:\s]+)([A-Z][A-Za-z\s]+)',
                        extract, re.IGNORECASE
                    )
                    if match_dir:
                        diretor = match_dir.group(1).strip()
                    return {"sinopse": extract[:2000], "diretor": diretor}
            elif resposta.status_code == 404:
                continue

        print("[WIKIPEDIA] Nenhum resultado encontrado para o filme.")
    except Exception as e:
        print(f"[WIKIPEDIA] Erro: {e}")

    return None


# ==========================================
# 3. DADOS COMPLEMENTARES DO FILME (TMDb)
# ==========================================
def obter_detalhes_filme_tmdb(nome_filme):
    """Busca poster, sinopse, diretor, ID do IMDb e cenas de fundo no TMDb."""
    if not TMDB_API_KEY:
        return None

    params_busca = {"api_key": TMDB_API_KEY, "query": nome_filme, "language": "pt-BR"}
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

        url_imagens = f"{URL_TMDB_BASE}/{filme_id}/images"
        resp_imagens = requests.get(url_imagens, params={"api_key": TMDB_API_KEY}, timeout=10).json()

        cenas = []
        for backdrop in resp_imagens.get("backdrops", [])[:15]:
            cenas.append(f"https://image.tmdb.org/t/p/w780{backdrop['file_path']}")

        return {
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
            print("Letra nao encontrada. Prosseguindo apenas com a energia da musica.")

        # --- CONTEXTO: Fallback em 3 camadas ---
        print("Buscando significado/contexto da musica (3 camadas de fallback)...")
        contexto_extra = buscar_contexto_musica(nome_musica, artista)

        if contexto_extra:
            print("Contexto adicional obtido com sucesso. Enviando para a IA...")
        else:
            print("Nenhum contexto adicional encontrado. Seguindo apenas com a letra.")

        # --- RECOMENDACAO IA ---
        print("Analisando a vibe profunda...")
        recomendacao_ia = obter_recomendacao_ia(nome_musica, artista, letra, contexto_extra)

        if not recomendacao_ia:
            print("Falha ao obter recomendacao da IA. Tente novamente.")
            continue

        # Suporta tanto o campo 'filme' (novo) quanto 'filme_sugerido' (legado)
        nome_filme_ia = recomendacao_ia.get("filme") or recomendacao_ia.get("filme_sugerido", "")
        ano_filme_ia = recomendacao_ia.get("ano") or recomendacao_ia.get("ano_filme", "")
        justificativa = recomendacao_ia.get("justificativa") or recomendacao_ia.get("justificativa_vibe", "")

        if not nome_filme_ia:
            print("IA nao retornou um nome de filme valido. Tente novamente.")
            continue

        termo_busca_tmdb = nome_filme_ia
        if ano_filme_ia:
            termo_busca_tmdb = f"{nome_filme_ia} {ano_filme_ia}"

        print(f"Consultando TMDb para coletar as midias de '{termo_busca_tmdb}'...")
        dados_filme = obter_detalhes_filme_tmdb(termo_busca_tmdb)

        # --- FALLBACK: Se TMDb falhou, busca na Wikipedia ---
        if not dados_filme or not dados_filme.get("sinopse") or dados_filme["sinopse"] in ("Sem sinopse disponivel.", ""):
            print("TMDb sem resultados. Buscando na Wikipedia...")
            fallback_wiki = buscar_dados_filme_wikipedia(nome_filme_ia, ano_filme_ia)
            if fallback_wiki:
                dados_filme = {
                    "id_tmdb": None,
                    "titulo_pt": nome_filme_ia,
                    "titulo_original": nome_filme_ia,
                    "ano": ano_filme_ia if ano_filme_ia else "Nao informado",
                    "sinopse": fallback_wiki["sinopse"],
                    "poster": None,
                    "diretor": fallback_wiki["diretor"],
                    "imdb_id": None,
                    "cenas": []
                }
            else:
                # Fallback final: sinopse padrao
                dados_filme = {
                    "id_tmdb": None,
                    "titulo_pt": nome_filme_ia,
                    "titulo_original": nome_filme_ia,
                    "ano": ano_filme_ia if ano_filme_ia else "Nao informado",
                    "sinopse": "Sinopse indisponivel.",
                    "poster": None,
                    "diretor": "Nao encontrado",
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