import os
import json
import re
import requests
import urllib.parse
from dotenv import load_dotenv

import lyricsgenius

load_dotenv()

OPENROUTER_API_KEY = os.getenv("OPENROUTER_API_KEY")
TMDB_API_KEY = os.getenv("TMDB_API_KEY")
GENIUS_API_KEY = os.getenv("GENIUS_API_KEY")

URL_LRCLIB = "https://" + "lrclib.net/api/search"
URL_OPENROUTER = "https://" + "openrouter.ai/api/v1/chat/completions"
URL_TMDB_BUSCA = "https://" + "api.themoviedb.org/3/search/movie"
URL_TMDB_BASE = "https://" + "api.themoviedb.org/3/movie"
URL_WIKIPEDIA_PT = "https://" + "pt.wikipedia.org/api/rest_v1/page/summary/"
URL_WIKIPEDIA_EN = "https://" + "en.wikipedia.org/api/rest_v1/page/summary/"

# Instancias SearXNG para rotacao
INSTANCIAS_SEARXNG = [
    "https://" + "search.disroot.org/search",
    "https://" + "searx.be/search",
    "https://" + "searx.space/search",
]


def limpar_termo_musica(termo):
    """Remove sufixos promocionais, ruidos e anos dos titulos."""
    if not termo:
        return termo
    t = termo
    t = re.sub(r'\(\d{4}\)', '', t)
    t = re.sub(r'\[\d{4}\]', '', t)
    t = re.sub(
        r'\([^)]*(?:official|music\s*video|remaster|remastered|audio|lyric|video|visualizer|live|feat\.?|ft\.?|prod\.?|explicit|clean|edit|version|4k|hd|360|clip|single|lyrics|audio|official\s*audio)[^)]*\)',
        '', t, flags=re.IGNORECASE
    )
    t = re.sub(
        r'\[[^\]]*(?:official|music\s*video|remaster|remastered|audio|lyric|video|visualizer|live|feat\.?|ft\.?|prod\.?|explicit|clean|edit|version|4k|hd|360|clip|single|lyrics|audio|official\s*audio)[^\]]*\]',
        '', t, flags=re.IGNORECASE
    )
    t = re.sub(r'\s+(?:feat\.?|ft\.?)\..*$', '', t, flags=re.IGNORECASE)
    t = re.sub(r'\s+[\(\[].*?(?:feat\.?|ft\.?).*?[\)\]]', '', t, flags=re.IGNORECASE)
    return t.strip()


def sanitizar_titulo_filme(titulo):
    """
    Remove qualquer ano colado ao nome do filme.
    Ex: 'Interstellar 2014' -> 'Interstellar', 'Interstellar (2014)' -> 'Interstellar'
    """
    if not titulo:
        return ""
    if not isinstance(titulo, str):
        return ""

    t = titulo.strip()
    t = re.sub(r'\s+(?:19|20)\d{2}\s*$', '', t)
    t = re.sub(r'\s*[\(\[]\s*(?:19|20)\d{2}\s*[\)\]]\s*$', '', t)
    t = re.sub(r'\s*[-–—]\s*(?:19|20)\d{2}\s*$', '', t)
    return t.strip()


# ==========================================
# BUSCA GENERICA: SearXNG (COM ROTACAO)
# ==========================================
def buscar_searxng(query, max_results=3):
    """
    Busca em instancias publicas SearXNG com rotacao, validacao e fallback gracioso.
    Retorna snippets de texto ou None.
    """
    for instancia in INSTANCIAS_SEARXNG:
        try:
            params = {
                "q": query,
                "format": "json",
                "language": "en",
                "categories": "general"
            }
            headers = {
                "User-Agent": "Mozilla/5.0 (compatible; Moovibe/1.0)"
            }
            resposta = requests.get(instancia, params=params, headers=headers, timeout=10)
            content_type = (resposta.headers.get("Content-Type", "") or "").lower()

            if resposta.status_code != 200:
                print(f"[SEARXNG] Instancia {instancia} retornou status {resposta.status_code}. Tentando proxima...")
                continue

            if "application/json" not in content_type:
                preview = " ".join((resposta.text or "")[:200].split())
                print(f"[SEARXNG] Instancia {instancia} retornou {content_type or 'sem content-type'}: {preview}")
                continue

            dados = resposta.json()
            resultados = dados.get("results", [])
            if resultados:
                snippets = []
                for r in resultados[:max_results]:
                    snippet = ""
                    for field in ("content", "title", "snippet"):
                        valor = r.get(field)
                        if isinstance(valor, str) and valor.strip():
                            snippet = valor.strip()
                            break
                    if snippet:
                        snippets.append(snippet)
                if snippets:
                    print(f"[SEARXNG] Instancia {instancia} OK!")
                    return "\n\n".join(snippets)[:3000]

        except requests.exceptions.JSONDecodeError:
            print(f"[SEARXNG] Instancia {instancia} retornou JSON invalido. Tentando proxima...")
            continue
        except Exception as e:
            print(f"[SEARXNG] Instancia {instancia} erro: {e}. Tentando proxima...")
            continue

    return None


# ==========================================
# BUSCA DE CITACOES DO FILME (SearXNG)
# ==========================================
def buscar_citacoes_filme(nome_filme):
    """
    Busca ate 3 citacoes/frases celebres do filme usando SearXNG.
    Retorna uma lista de strings ou uma lista com 3 frases genericas se falhar.
    """
    try:
        query = f'"{nome_filme}" movie quotes'
        resultado = buscar_searxng(query, max_results=5)
        if resultado:
            frases = []
            for linha in resultado.split("\n"):
                linha = linha.strip()
                # Tenta extrair trechos entre aspas
                citacoes = re.findall(r'[""]([^""]{10,80})[""]', linha)
                for c in citacoes:
                    c = c.strip()
                    if len(c) > 15 and c not in frases:
                        frases.append(c)
                    if len(frases) >= 3:
                        break
                if len(frases) >= 3:
                    break
            if len(frases) >= 3:
                return frases[:3]
    except Exception as e:
        print(f"[CITACOES] Erro: {e}")

    return ["Cinema is magic.",
            "Every film is a journey.",
            "Lights, camera, action!"]


# ==========================================
# 1. FLUXO DA LETRA DA MUSICA
# ==========================================
def buscar_letra_musica(nome_musica, artista):
    """
    CAMADA 1: LRCLIB API
    CAMADA 2: Genius API (letra)
    CAMADA 3: SearXNG
    """
    nome_limpo = limpar_termo_musica(nome_musica)
    artista_limpo = limpar_termo_musica(artista) if artista else artista

    print("[LETRA] CAMADA 1: LRCLIB...")
    try:
        params = {"track_name": nome_limpo, "artist_name": artista_limpo}
        resp = requests.get(URL_LRCLIB, params=params, timeout=10)
        if resp.status_code == 200:
            dados = resp.json()
            if isinstance(dados, list) and dados:
                letra = dados[0].get("plainLyrics", "")
                if letra:
                    print("[LETRA] LRCLIB: Letra encontrada!")
                    return letra[:5000]
    except Exception as e:
        print(f"[LETRA] LRCLIB erro: {e}")

    print("[LETRA] CAMADA 2: Genius...")
    if GENIUS_API_KEY:
        try:
            genius = lyricsgenius.Genius(GENIUS_API_KEY, timeout=10, retries=2)
            genius.verbose = False
            musica = genius.search_song(nome_limpo, artista_limpo)
            if musica and getattr(musica, "lyrics", None):
                letra_genius = musica.lyrics
                letra_genius = re.sub(r'^\d+ Contributors.*$', '', letra_genius, flags=re.MULTILINE | re.DOTALL)
                letra_genius = re.sub(r'\d+Embed$', '', letra_genius)
                letra_genius = re.sub(r'\s+', ' ', letra_genius).strip()
                if letra_genius:
                    print("[LETRA] Genius: Letra encontrada!")
                    return letra_genius[:5000]
        except Exception as e:
            print(f"[LETRA] Genius erro: {e}")

    print("[LETRA] CAMADA 3: SearXNG...")
    query_searxng = f"{nome_limpo} {artista_limpo} lyrics"
    letra_searxng = buscar_searxng(query_searxng)
    if letra_searxng:
        print("[LETRA] SearXNG: Letra encontrada!")
        return letra_searxng[:5000]

    print("[LETRA] Todas as camadas falharam.")
    return ""


# ==========================================
# 2. FLUXO DO SIGNIFICADO/CONTEXTO DA MUSICA
# ==========================================
def buscar_contexto_musica(nome_musica, artista):
    """
    CAMADA 1: Genius API (descricao)
    CAMADA 2: SearXNG
    CAMADA 3: Wikipedia PT
    CAMADA 4: OpenRouter (mini-IA) - com fallback string seguro
    """
    nome_limpo = limpar_termo_musica(nome_musica)
    artista_limpo = limpar_termo_musica(artista) if artista else artista
    termo_busca = f"{nome_limpo} {artista_limpo}"

    print("[CONTEXTO] CAMADA 1: Genius...")
    if GENIUS_API_KEY:
        try:
            genius = lyricsgenius.Genius(GENIUS_API_KEY, timeout=10, retries=2)
            genius.verbose = False
            musica = genius.search_song(nome_limpo, artista_limpo)
            if musica and hasattr(musica, 'description'):
                desc = musica.description
                if desc:
                    desc_limpa = re.sub(r'<[^>]+>', '', desc)
                    desc_limpa = re.sub(r'\s+', ' ', desc_limpa).strip()
                    if desc_limpa:
                        print("[CONTEXTO] Genius: Descricao encontrada!")
                        return desc_limpa[:2000]
        except Exception as e:
            print(f"[CONTEXTO] Genius erro: {e}")

    print("[CONTEXTO] CAMADA 2: SearXNG...")
    query_searxng = f"{nome_limpo} {artista_limpo} song meaning explanation"
    ctx_searxng = buscar_searxng(query_searxng)
    if ctx_searxng:
        print("[CONTEXTO] SearXNG: Contexto encontrado!")
        return ctx_searxng[:2000]

    print("[CONTEXTO] CAMADA 3: Wikipedia PT...")
    try:
        url = f"{URL_WIKIPEDIA_PT}{urllib.parse.quote(termo_busca)}"
        headers = {"User-Agent": "Moovibe/1.0 (movie recommendation app)"}
        resp = requests.get(url, headers=headers, timeout=10)
        if resp.status_code == 200:
            dados = resp.json()
            if dados.get("type") != "disambiguation" and dados.get("extract"):
                print("[CONTEXTO] Wikipedia: Contexto encontrado!")
                return dados["extract"][:2000]
    except Exception as e:
        print(f"[CONTEXTO] Wikipedia erro: {e}")

    print("[CONTEXTO] CAMADA 4: OpenRouter (mini-IA)...")
    if OPENROUTER_API_KEY:
        try:
            headers = {
                "Authorization": f"Bearer {OPENROUTER_API_KEY}",
                "Content-Type": "application/json"
            }
            prompt = (
                f"Explique brevemente em um paragrafo curto em portugues "
                f"o significado da musica '{nome_limpo}' de '{artista_limpo}'."
            )
            payload = {
                "model": "openrouter/free",
                "temperature": 0.3,
                "max_tokens": 300,
                "messages": [{"role": "user", "content": prompt}]
            }
            resp = requests.post(URL_OPENROUTER, headers=headers, json=payload, timeout=15)
            resp.raise_for_status()
            texto = resp.json().get("choices", [{}])[0].get("message", {}).get("content", "")
            if texto and isinstance(texto, str):
                texto = texto.strip()
                if texto:
                    print("[CONTEXTO] OpenRouter: Contexto gerado via IA!")
                    return texto[:2000]
        except Exception as e:
            print(f"[CONTEXTO] OpenRouter erro: {e}")

    print("[CONTEXTO] Todas as camadas falharam.")
    return "Contexto não encontrado."


# ==========================================
# 3. INTELIGENCIA ARTIFICIAL - RECOMENDACAO PRINCIPAL
# ==========================================
def obter_recomendacao_ia(nome_musica, artista, letra, contexto_extra=None):
    headers = {
        "Authorization": f"Bearer {OPENROUTER_API_KEY}",
        "Content-Type": "application/json"
    }

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

    payload = {
        "model": "openrouter/free",
        "temperature": 0.3,
        "messages": [
            {"role": "system", "content": prompt_sistema},
            {"role": "user", "content": conteudo_usuario}
        ]
    }

    try:
        resp = requests.post(URL_OPENROUTER, headers=headers, json=payload, timeout=25)
        resp.raise_for_status()
        texto_ia = resp.json().get("choices", [{}])[0].get("message", {}).get("content", "")
        if not isinstance(texto_ia, str):
            return None
        texto_ia = texto_ia.replace("```json", "").replace("```", "").strip()

        try:
            dados = json.loads(texto_ia)
            if isinstance(dados, dict):
                dados["filme"] = sanitizar_titulo_filme(dados.get("filme") or dados.get("filme_sugerido", ""))
                return dados
            return None
        except json.JSONDecodeError:
            print("[DEBUG] JSON direto falhou. Tentando extrair com regex...")
            print(f"[DEBUG] Texto bruto:\n{texto_ia}")
            match_json = re.search(r'(\{.*\})', texto_ia, re.DOTALL)
            if match_json:
                try:
                    dados = json.loads(match_json.group(0))
                    if isinstance(dados, dict):
                        dados["filme"] = sanitizar_titulo_filme(dados.get("filme") or dados.get("filme_sugerido", ""))
                        return dados
                except json.JSONDecodeError:
                    print("[DEBUG] Regex tambem falhou.")
                    return None
            print("[DEBUG] Nenhum JSON encontrado.")
            return None

    except Exception as e:
        print(f"Erro ao conversar com a IA: {e}")
        return None


# ==========================================
# 4. DADOS DO FILME (TMDb + Fallbacks)
# ==========================================
def obter_detalhes_filme_tmdb(nome_filme):
    """
    Busca dados do filme no TMDb sem filtro de idioma forçado.
    Prioriza poster original em inglês/internacional, evitando pôsteres com títulos adaptados.
    """
    if not TMDB_API_KEY:
        return None

    # Extrai o ano do nome_filme se existir (ex: "Interstellar 2014") e usa como parametro separado
    nome_limpo = nome_filme
    ano_extraido = None
    match_ano = re.search(r'(?:19|20)\d{2}$', nome_filme.strip())
    if match_ano:
        ano_extraido = match_ano.group(0)
        nome_limpo = nome_filme.strip()[:-5].strip()

    params_busca = {"api_key": TMDB_API_KEY, "query": nome_limpo}
    if ano_extraido:
        params_busca["year"] = ano_extraido
    try:
        resp_busca = requests.get(URL_TMDB_BUSCA, params=params_busca, timeout=10)
        if resp_busca.status_code != 200:
            return None
        dados_busca = resp_busca.json()
        if not dados_busca.get("results"):
            return None

        filme_basico = dados_busca["results"][0]
        filme_id = filme_basico["id"]

        url_detalhes = f"{URL_TMDB_BASE}/{filme_id}"
        resp_detalhes = requests.get(url_detalhes, params={"api_key": TMDB_API_KEY}, timeout=10)
        detalhes = resp_detalhes.json() if resp_detalhes.status_code == 200 else {}

        url_creditos = f"{URL_TMDB_BASE}/{filme_id}/credits"
        resp_creditos = requests.get(url_creditos, params={"api_key": TMDB_API_KEY}, timeout=10)
        creditos = resp_creditos.json() if resp_creditos.status_code == 200 else {}
        diretor = "Nao encontrado"
        for pessoa in creditos.get("crew", []):
            if pessoa.get("job") == "Director":
                diretor = pessoa.get("name")
                break

        url_imagens = f"{URL_TMDB_BASE}/{filme_id}/images"
        params_imagens = {"api_key": TMDB_API_KEY, "include_image_language": "en,null"}
        resp_imagens = requests.get(url_imagens, params=params_imagens, timeout=10)
        dados_imagens = resp_imagens.json() if resp_imagens.status_code == 200 else {}

        cenas = []
        for backdrop in dados_imagens.get("backdrops", [])[:15]:
            if backdrop.get("file_path"):
                cenas.append(f"https://image.tmdb.org/t/p/w780{backdrop['file_path']}")

        poster_url = None
        for poster in dados_imagens.get("posters", []):
            if poster.get("file_path"):
                lang = (poster.get("iso_639_1") or "").lower()
                if lang in ("en", "") or lang is None:
                    poster_url = f"https://image.tmdb.org/t/p/w500{poster['file_path']}"
                    break
        if not poster_url and filme_basico.get("poster_path"):
            poster_url = f"https://image.tmdb.org/t/p/w500{filme_basico['poster_path']}"

        return {
            "id_tmdb": filme_id,
            "titulo_pt": filme_basico.get("title"),
            "titulo_original": filme_basico.get("original_title"),
            "ano": filme_basico.get("release_date", "----")[:4],
            "sinopse": filme_basico.get("overview", "Sem sinopse disponivel."),
            "poster": poster_url,
            "diretor": diretor,
            "imdb_id": detalhes.get("imdb_id"),
            "cenas": cenas
        }
    except Exception as e:
        print(f"Erro ao consultar o TMDb: {e}")
        return None


def extrair_duas_primeiras_frases(texto):
    """Extrai apenas as duas primeiras frases de um texto."""
    if not texto:
        return ""
    texto_limpo = re.sub(r'\s+', ' ', texto).strip()
    frases = [f.strip() for f in re.split(r'(?<=[.!?])\s+', texto_limpo) if f.strip()]
    if len(frases) >= 2:
        return f"{frases[0]} {frases[1]}"
    elif frases:
        return frases[0]
    return texto_limpo[:500]


def extrair_diretor_wikipedia(extract):
    """
    Extrai APENAS o nome do diretor do extract da Wikipedia,
    eliminando complementos como 'e estrelado por...'.
    """
    if not extract:
        return "Disponível na Wikipédia"

    match = re.search(
        r'(?:dirigido\s+por|dire[cç][aã]o\s+(?:de\s+)?|diretor[:\s]+)\s+([A-ZÀ-Ú][A-Za-zÀ-Ú0-9\'\-\s]+?)(?=(?:,|\.|\s+e\s+|\s+\(|\s*$))',
        extract,
        re.IGNORECASE
    )
    if match:
        nome = match.group(1).strip()
        nome = re.sub(r'\s+e\s+.*$', '', nome).strip()
        if len(nome) > 2:
            return nome

    match_en = re.search(
        r'(?:directed\s+by|director[:\s]+)\s+([A-Z][A-Za-z0-9\'\-\s]+?)(?=(?:,|\.|\s+and\s+|\s+\(|\s*$))',
        extract,
        re.IGNORECASE
    )
    if match_en:
        nome = match_en.group(1).strip()
        nome = re.sub(r'\s+and\s+.*$', '', nome).strip()
        if len(nome) > 2:
            return nome

    return "Disponível na Wikipédia"


def buscar_dados_filme_fallback(nome_filme, ano):
    """
    Fallback para dados do filme quando TMDb falha.
    CAMADA 1: Wikipedia (forcando 'filme' no termo)
    CAMADA 2: SearXNG (movie plot synopsis)
    """
    print("[FILME FALLBACK] CAMADA 1: Wikipedia PT...")
    try:
        termos = []
        if ano:
            termos.append(f"{nome_filme} ({ano}) filme")
            termos.append(f"{nome_filme} {ano} filme")
        termos.append(f"{nome_filme} filme")
        termos.append(nome_filme)

        for termo in termos:
            url = f"{URL_WIKIPEDIA_PT}{urllib.parse.quote(termo)}"
            headers = {"User-Agent": "Moovibe/1.0 (movie recommendation app)"}
            resp = requests.get(url, headers=headers, timeout=10)
            if resp.status_code == 200:
                dados = resp.json()
                if dados.get("type") == "disambiguation":
                    continue
                extract = dados.get("extract", "")
                if extract:
                    sinopse = extrair_duas_primeiras_frases(extract)
                    diretor = extrair_diretor_wikipedia(extract)
                    poster_url = None
                    originalimage = dados.get("originalimage") or {}
                    if isinstance(originalimage, dict):
                        poster_url = originalimage.get("source")

                    print("[FILME FALLBACK] Wikipedia: Dados encontrados!")
                    return {
                        "sinopse": sinopse[:2000],
                        "diretor": diretor,
                        "poster": poster_url
                    }

    except Exception as e:
        print(f"[FILME FALLBACK] Wikipedia erro: {e}")

    print("[FILME FALLBACK] CAMADA 2: SearXNG...")
    try:
        query = f"{nome_filme} movie plot synopsis"
        if ano:
            query = f"{nome_filme} {ano} movie plot synopsis"
        resultado = buscar_searxng(query)
        if resultado:
            print("[FILME FALLBACK] SearXNG: Dados encontrados!")
            return {
                "sinopse": resultado[:2000],
                "diretor": "Disponível na Web",
                "poster": None
            }
    except Exception as e:
        print(f"[FILME FALLBACK] SearXNG erro: {e}")

    print("[FILME FALLBACK] Todas as camadas falharam.")
    return None


# ==========================================
# 5. ORQUESTRACAO PRINCIPAL
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
            print("Por favor, digite o artista tambem para termos precisao.")
            continue

        print()
        print("=== BUSCANDO LETRA DA MUSICA ===")
        letra = buscar_letra_musica(nome_musica, artista)
        if letra:
            print("✓ Letra obtida com sucesso.")
        else:
            print("✗ Letra nao encontrada. Seguindo sem letra.")

        print()
        print("=== BUSCANDO CONTEXTO/SIGNIFICADO ===")
        contexto_extra = buscar_contexto_musica(nome_musica, artista)
        if contexto_extra:
            print("✓ Contexto obtido com sucesso.")
        else:
            print("✗ Contexto nao encontrado.")

        print()
        print("=== ANALISANDO VIBE (IA) ===")
        recomendacao_ia = obter_recomendacao_ia(nome_musica, artista, letra, contexto_extra)

        if not recomendacao_ia:
            print("Falha ao obter recomendacao da IA. Tente novamente.")
            continue

        # Sanitizacao do titulo do filme (remove ano colado)
        nome_filme_ia = sanitizar_titulo_filme(
            recomendacao_ia.get("filme") or recomendacao_ia.get("filme_sugerido", "")
        )
        ano_filme_ia = recomendacao_ia.get("ano") or recomendacao_ia.get("ano_filme", "")
        justificativa = recomendacao_ia.get("justificativa") or recomendacao_ia.get("justificativa_vibe", "")

        if not nome_filme_ia:
            print("IA nao retornou um nome de filme valido. Tente novamente.")
            continue

        print()
        print("=== BUSCANDO DADOS DO FILME ===")
        termo_busca_tmdb = nome_filme_ia
        if ano_filme_ia:
            termo_busca_tmdb = f"{nome_filme_ia} {ano_filme_ia}"

        print(f"TMDb: '{termo_busca_tmdb}'...")
        dados_filme = obter_detalhes_filme_tmdb(termo_busca_tmdb)

        if not dados_filme or not dados_filme.get("sinopse") or dados_filme["sinopse"] in ("Sem sinopse disponivel.", ""):
            print("TMDb sem resultados. Buscando fallbacks...")
            fallback = buscar_dados_filme_fallback(nome_filme_ia, ano_filme_ia)
            if fallback:
                dados_filme = {
                    "id_tmdb": None,
                    "titulo_pt": nome_filme_ia,
                    "titulo_original": nome_filme_ia,
                    "ano": ano_filme_ia if ano_filme_ia else "Nao informado",
                    "sinopse": fallback.get("sinopse", "Sinopse indisponivel."),
                    "poster": fallback.get("poster"),
                    "diretor": fallback.get("diretor", "Nao encontrado"),
                    "imdb_id": None,
                    "cenas": []
                }
            else:
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

        # --- BUSCA CITACOES DO FILME ---
        print()
        print("=== BUSCANDO CITACOES DO FILME ===")
        citacoes = buscar_citacoes_filme(nome_filme_ia)
        if dados_filme:
            dados_filme["citacoes"] = citacoes

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
            print(f"IMDb (Busca): https://www.imdb.com/find?q={urllib.parse.quote(nome_filme_ia)}")

        if dados_filme and dados_filme.get("id_tmdb"):
            print(f"Letterboxd: https://letterboxd.com/tmdb/{dados_filme['id_tmdb']}")
        else:
            print(f"Letterboxd (Busca): https://letterboxd.com/search/{urllib.parse.quote(nome_filme_ia)}/")

        tiktok_query = urllib.parse.quote(f"{nome_filme_ia} edit")
        print(f"TikTok (Navegador): https://www.tiktok.com/search?q={tiktok_query}")
        print(f"TikTok (Abrir direto no App): tiktok://search?keyword={tiktok_query}")
        print("==================================================")

if __name__ == "__main__":
    main()