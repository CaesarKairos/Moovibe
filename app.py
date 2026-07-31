import os
import json
import re
import requests
import urllib.parse
import time
from dotenv import load_dotenv

import lyricsgenius

load_dotenv()

OPENROUTER_API_KEY = os.getenv("OPENROUTER_API_KEY")
TMDB_API_KEY = os.getenv("TMDB_API_KEY")
GENIUS_API_KEY = os.getenv("GENIUS_API_KEY")

URL_LRCLIB_BASE = "https://" + "lrclib.net/api"
URL_LRCLIB_GET = URL_LRCLIB_BASE + "/get"
URL_LRCLIB_SEARCH = URL_LRCLIB_BASE + "/search"
URL_OPENROUTER = "https://" + "openrouter.ai/api/v1/chat/completions"
URL_TMDB_BUSCA = "https://" + "api.themoviedb.org/3/search/movie"
URL_TMDB_BASE = "https://" + "api.themoviedb.org/3/movie"
URL_WIKIPEDIA_PT = "https://" + "pt.wikipedia.org/api/rest_v1/page/summary/"
URL_WIKIPEDIA_EN = "https://" + "en.wikipedia.org/api/rest_v1/page/summary/"
URL_SONGFACTS = "https://www.songfacts.com/search"

MOOVIBE_VERSION = "1.0"
MOOVIBE_USER_AGENT = f"Moovibe/{MOOVIBE_VERSION} (mailto:cesarbatistasantos08@gmail.com)"
BROWSER_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"

LRCLIB_THROTTLE_SECONDS = 0.25
_lrclib_last_request = 0.0


def lrclib_throttle():
    global _lrclib_last_request
    now = time.time()
    wait = max(0.0, LRCLIB_THROTTLE_SECONDS - (now - _lrclib_last_request))
    _lrclib_last_request = now + wait
    if wait > 0:
        time.sleep(wait)


def lrclib_headers():
    return {
        "User-Agent": MOOVIBE_USER_AGENT,
        "X-User-Agent": MOOVIBE_USER_AGENT,
    }


# ==========================================
# HISTÓRICO EM MEMÓRIA (versão Python)
# ==========================================
# Simula um KV simples para manter o histórico durante a sessão.
# Em produção (Cloudflare) isso é substituída pelo KV real.
_historico_geral = []  # Lista de dicts: {song, artist, movie_title}


def slugify(texto):
    """Converte texto em slug amigável para URL (lowercase, hífens, sem acentos)."""
    if not texto:
        return ""
    slug = texto.lower()
    slug = slug.replace(" & ", " e ")
    slug = slug.replace(" / ", " ")
    slug = re.sub(r'[áàâãäå]', 'a', slug)
    slug = re.sub(r'[éèêë]', 'e', slug)
    slug = re.sub(r'[íìîï]', 'i', slug)
    slug = re.sub(r'[óòôõö]', 'o', slug)
    slug = re.sub(r'[úùûü]', 'u', slug)
    slug = re.sub(r'[ç]', 'c', slug)
    slug = re.sub(r'[ñ]', 'n', slug)
    slug = re.sub(r'[^a-z0-9\s-]', '', slug)
    slug = re.sub(r'[\s]+', '-', slug)
    slug = re.sub(r'-+', '-', slug)
    slug = slug.strip('-')
    return slug


def adicionar_ao_historico(nome_musica, artista, titulo_filme):
    """Adiciona uma entrada ao histórico em memória."""
    entrada = {
        "song": nome_musica,
        "artist": artista,
        "movie_title": titulo_filme
    }
    _historico_geral.append(entrada)
    # Mantém apenas os últimos 50
    if len(_historico_geral) > 50:
        _historico_geral.pop(0)


def obter_filmes_excluidos(nome_musica, artista):
    """
    Separa o histórico em dois arrays de exclusão:
    - Globais: últimos 20 filmes recomendados (independente da música)
    - Específicos: últimos 5 filmes para EXATAMENTE esta música
    """
    globais = []
    especificos = []

    for entrada in reversed(_historico_geral):
        titulo = entrada.get("movie_title", "")
        if titulo and titulo not in globais and len(globais) < 20:
            globais.append(titulo)
        # Verifica se é da mesma música
        mesma_musica = (
            entrada.get("song", "").lower() == nome_musica.lower() and
            (not artista or entrada.get("artist", "").lower() == artista.lower())
        )
        if mesma_musica and titulo and titulo not in especificos and len(especificos) < 5:
            especificos.append(titulo)

    return globais, especificos


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


def extrair_json_de_texto(texto_bruto):
    """
    Extrai JSON de texto bruto usando regex robusta.
    Retorna o objeto JSON parseado ou None se falhar.
    """
    if not texto_bruto or not isinstance(texto_bruto, str):
        return None
    
    # Remove marcadores markdown
    texto_limpo = texto_bruto.replace("```json", "").replace("```", "").strip()
    
    # Regex para encontrar objeto JSON completo
    match = re.search(r'\{.*\}', texto_limpo, re.DOTALL)
    if match:
        texto_json = match.group(0)
        try:
            return json.loads(texto_json)
        except json.JSONDecodeError:
            pass
    
    # Tenta parse direto se não houver markdown
    try:
        return json.loads(texto_limpo)
    except json.JSONDecodeError:
        pass
    
    return None


# ==========================================
# BUSCA GENERICA: Brave Search
# ==========================================
def buscar_brave(query):
    """
    Busca no Brave Search, remove blocos <script>, <style> e tags HTML,
    retorna o texto limpo ou None.
    """
    try:
        url = f"https://search.brave.com/search?q={urllib.parse.quote(query)}"
        headers = {
            "User-Agent": BROWSER_USER_AGENT,
        }
        resp = requests.get(url, headers=headers, timeout=15)
        if resp.status_code != 200:
            print(f"[BRAVE] Status {resp.status_code}")
            return None

        html = resp.text
        # Remove blocos <script>...</script> e <style>...</style>
        html = re.sub(r'<script[^>]*>.*?</script>', '', html, flags=re.DOTALL | re.IGNORECASE)
        html = re.sub(r'<style[^>]*>.*?</style>', '', html, flags=re.DOTALL | re.IGNORECASE)
        # Remove tags HTML restantes
        texto = re.sub(r'<[^>]+>', '', html)
        # Limpa espacos duplicados
        texto = re.sub(r'\s+', ' ', texto).strip()
        # Trunca para evitar excesso
        texto = texto[:5000]
        if texto:
            print(f"[BRAVE] OK! {len(texto)} chars obtidos.")
            return texto
        return None
    except Exception as e:
        print(f"[BRAVE] Erro: {e}")
        return None


# ==========================================
# BUSCA DE CITACOES DO FILME (Brave Search)
# ==========================================
def buscar_citacoes_filme(nome_filme):
    """
    Busca ate 3 citacoes/frases celebres do filme usando Brave Search.
    Suporta aspas normais e tipograficas.
    Retorna uma lista de strings ou uma lista com 3 frases genericas se falhar.
    """
    try:
        query = f'"{nome_filme}" movie quotes memorable lines'
        resultado = buscar_brave(query)
        if resultado:
            frases = []
            for linha in resultado.split("\n"):
                linha = linha.strip()
                # Tenta extrair trechos entre aspas (normais e tipograficas: ", ", "", “)
                citacoes = re.findall(r'["""\u201C\u201D]([^""\u201C\u201D]{10,80})["""\u201C\u201D]', linha)
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


def extrair_quotes_da_letra(letra, max_quotes=3):
    """Extrai versos da letra para usar como quotes de fallback."""
    if not letra or not isinstance(letra, str):
        return []
    
    linhas = letra.split('\n')
    quotes = []
    estruturas = re.compile(r'^\[.*?\]$|^\(.*?\)$|^[A-Za-z\s]+:$|^---.*?---$')
    
    for linha in linhas:
        limpa = linha.strip()
        if not limpa:
            continue
        if estruturas.match(limpa):
            continue
        if len(limpa) < 15 or len(limpa) > 120:
            continue
        
        quotes.append(limpa)
        if len(quotes) >= max_quotes:
            break
    
    return quotes


# ==========================================
# 1. FLUXO DA LETRA DA MUSICA
# ==========================================
def buscar_letra_musica(nome_musica, artista):
    """
    CAMADA 1: LRCLIB /api/get (letra completa)
    CAMADA 1b: LRCLIB /api/search (fallback)
    CAMADA 2: Genius API (letra)
    CAMADA 3: Brave Search
    """
    nome_limpo = limpar_termo_musica(nome_musica)
    artista_limpo = limpar_termo_musica(artista) if artista else artista

    # CAMADA 1: LRCLIB /api/get (letra completa)
    print("[LETRA] CAMADA 1: LRCLIB /api/get...")
    try:
        lrclib_throttle()
        params = {"track_name": nome_limpo, "artist_name": artista_limpo}
        resp = requests.get(URL_LRCLIB_GET, params=params, headers=lrclib_headers(), timeout=10)
        if resp.status_code == 429:
            retry_after = int(resp.headers.get("Retry-After", "2"))
            print(f"[LETRA] LRCLIB rate limited. Aguardando {retry_after}s...")
            time.sleep(retry_after)
            resp = requests.get(URL_LRCLIB_GET, params=params, headers=lrclib_headers(), timeout=10)
        if resp.status_code == 200:
            data = resp.json()
            if data and data.get("plainLyrics"):
                print("[LETRA] LRCLIB /api/get: Letra encontrada!")
                return data["plainLyrics"][:5000]
    except Exception as e:
        print(f"[LETRA] LRCLIB /api/get erro: {e}")

    # CAMADA 1b: LRCLIB /api/search (fallback)
    print("[LETRA] CAMADA 1b: LRCLIB /api/search (fallback)...")
    try:
        lrclib_throttle()
        params_search = {"track_name": nome_limpo, "artist_name": artista_limpo}
        resp_search = requests.get(URL_LRCLIB_SEARCH, params=params_search, headers=lrclib_headers(), timeout=10)
        if resp_search.status_code == 429:
            retry_after = int(resp_search.headers.get("Retry-After", "2"))
            print(f"[LETRA] LRCLIB search rate limited. Aguardando {retry_after}s...")
            time.sleep(retry_after)
            resp_search = requests.get(URL_LRCLIB_SEARCH, params=params_search, headers=lrclib_headers(), timeout=10)
        if resp_search.status_code == 200:
            dados = resp_search.json()
            if isinstance(dados, list) and dados and dados[0].get("plainLyrics"):
                print("[LETRA] LRCLIB /api/search: Letra encontrada!")
                return dados[0]["plainLyrics"][:5000]
    except Exception as e:
        print(f"[LETRA] LRCLIB /api/search erro: {e}")

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

    print("[LETRA] CAMADA 3: Brave Search...")
    query_brave = f"{nome_limpo} {artista_limpo} lyrics"
    letra_brave = buscar_brave(query_brave)
    if letra_brave:
        print("[LETRA] Brave Search: Letra encontrada!")
        return letra_brave[:5000]

    print("[LETRA] Todas as camadas falharam.")
    return ""


# ==========================================
# 2. FLUXO DO SIGNIFICADO/CONTEXTO DA MUSICA
# ==========================================
def buscar_contexto_musica(nome_musica, artista, lang='en'):
    """
    CAMADA 1: Genius API (descricao)
    CAMADA 2: Brave Search
    CAMADA 3: Wikipedia (PT ou EN)
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

    print("[CONTEXTO] CAMADA 2: Brave Search...")
    query_brave = f"significado da musica {nome_limpo} {artista_limpo}"
    ctx_brave = buscar_brave(query_brave)
    if ctx_brave:
        print("[CONTEXTO] Brave Search: Contexto encontrado!")
        return ctx_brave[:2000]

    print("[CONTEXTO] CAMADA 3: Wikipedia...")
    wiki_url = URL_WIKIPEDIA_PT if lang == 'pt' else URL_WIKIPEDIA_EN
    wiki_label = "Wikipedia PT" if lang == 'pt' else "Wikipedia EN"
    print(f"[CONTEXTO] Usando {wiki_label}...")
    try:
        url = f"{wiki_url}{urllib.parse.quote(termo_busca)}"
        headers = {"User-Agent": MOOVIBE_USER_AGENT}
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
            idioma_prompt = "em português" if lang == 'pt' else "in English"
            headers = {
                "Authorization": f"Bearer {OPENROUTER_API_KEY}",
                "Content-Type": "application/json"
            }
            prompt = (
                f"Pesquise na web o contexto oficial e o significado da música '{nome_limpo}' "
                f"do artista '{artista_limpo}'. Explique brevemente em um parágrafo curto {idioma_prompt}."
            )
            payload = {
                "model": "openrouter/free",
                "temperature": 0.3,
                "max_tokens": 300,
                "messages": [{"role": "user", "content": prompt}]
            }

            # === LOGS OPENROUTER CONTEXTO ===
            print("\n=== [DEBUG] ENVIO OPENROUTER (CONTEXTO) ===")
            print(f"[DEBUG] Payload enviado:\n{json.dumps(payload, indent=2, ensure_ascii=False)}")
            print(f"Prompt: {prompt}")
            tempo_inicio = time.time()
            resp = requests.post(URL_OPENROUTER, headers=headers, json=payload, timeout=15)
            tempo_resposta = round(time.time() - tempo_inicio, 2)
            print(f"Status: {resp.status_code} | Tempo: {tempo_resposta}s")

            resp.raise_for_status()
            dados_resp = resp.json()
            
            # Tratamento defensivo contra NoneType
            texto = ""
            if isinstance(dados_resp, dict):
                choices = dados_resp.get("choices")
                if choices and isinstance(choices, list) and len(choices) > 0 and choices[0]:
                    texto = choices[0].get("message", {}).get("content", "")
            
            print(f"Resposta Bruta (raw):\n{texto[:300]}...\n")
            
            if texto and isinstance(texto, str):
                texto = texto.strip()
                if texto:
                    print("[CONTEXTO] OpenRouter: Contexto gerado via IA!")
                    return texto[:2000]
        except Exception as e:
            print(f"[CONTEXTO] OpenRouter erro: {e}")

    print("[CONTEXTO] Todas as camadas falharam.")
    return None


# ==========================================
# 3. INTELIGENCIA ARTIFICIAL - RECOMENDACAO PRINCIPAL
# ==========================================
def obter_recomendacao_ia(nome_musica, artista, letra, contexto_extra=None, filmes_excluidos_globais=None, filmes_excluidos_musica=None, lang='en'):
    headers = {
        "Authorization": f"Bearer {OPENROUTER_API_KEY}",
        "Content-Type": "application/json",
        "HTTP-Referer": "https://moovibe.pages.dev",
        "X-Title": "Moovibe",
    }

    # Monta regras de exclusão
    regra_global = ""
    if filmes_excluidos_globais and len(filmes_excluidos_globais) > 0:
        regra_global = f"REGRA DE DIVERSIFICAÇÃO GLOBAL: NÃO recomende nenhum destes filmes sob nenhuma hipótese: {', '.join(filmes_excluidos_globais)}.\n\n"
    
    regra_especifica = ""
    if filmes_excluidos_musica and len(filmes_excluidos_musica) > 0:
        regra_especifica = f"REGRA ESPECÍFICA DA MÚSICA: Para esta música específica, os seguintes filmes já foram recomendados recentemente e estão PROIBIDOS de serem repetidos: {', '.join(filmes_excluidos_musica)}. Escolha algo novo.\n\n"

    idioma_justificativa = "em português, até 4 frases" if lang == 'pt' else "in English, up to 4 sentences"
    prompt_sistema = (
        "Voce e um curador de cinema genial. O usuario vai te passar uma musica e voce deve sugerir "
        "EXATAMENTE UM filme que compartilhe exatamente da mesma atmosfera emocional, paleta de cores "
        "subtendida, ritmo psicologico ou alma lirica dessa musica. "
        "Nao se limite a conexoes obvias. Pense na vibe.\n\n"

        f"{regra_global}"
        f"{regra_especifica}"

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
        f'  "justificativa": "Uma explicacao poetica, profunda e envolvente ({idioma_justificativa}) conectando sentimentos da musica/letra com o filme."\n'
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
        # === LOGS OPENROUTER ===
        print("\n=== [DEBUG] ENVIO PARA OPENROUTER ===")
        print(f"[DEBUG] Payload enviado:\n{json.dumps(payload, indent=2, ensure_ascii=False)}")
        print(f"Modelo: {payload['model']}")
        print("Prompt Sistema:")
        print(prompt_sistema)
        print("\nConteudo Usuario:")
        print(conteudo_usuario[:500] + ("..." if len(conteudo_usuario) > 500 else ""))

        tempo_inicio = time.time()
        resp = requests.post(URL_OPENROUTER, headers=headers, json=payload, timeout=25)
        tempo_resposta = round(time.time() - tempo_inicio, 2)

        print(f"\n=== [DEBUG] RESPOSTA OPENROUTER ===")
        print(f"Status Code: {resp.status_code}")
        print(f"Tempo: {tempo_resposta}s")

        resp.raise_for_status()
        dados_resp_ia = resp.json()
        
        # Tratamento defensivo contra NoneType
        texto_ia = ""
        if isinstance(dados_resp_ia, dict):
            choices = dados_resp_ia.get("choices")
            if choices and isinstance(choices, list) and len(choices) > 0 and choices[0]:
                texto_ia = choices[0].get("message", {}).get("content", "")
        
        print(f"Resposta Bruta (raw):\n{texto_ia}\n")

        if not isinstance(texto_ia, str):
            print("[DEBUG] Resposta nao e string.")
            return None
        
        # Trata resposta de safety do OpenRouter
        if "User Safety" in texto_ia or "safe" in texto_ia.lower():
            print("[DEBUG] Resposta de seguranca detectada.")
            return None

        # Parse robusto de JSON
        dados = extrair_json_de_texto(texto_ia)
        if dados and isinstance(dados, dict):
            print("=== [DEBUG] JSON EXTRAIDO COM SUCESSO ===")
            print(json.dumps(dados, indent=2, ensure_ascii=False))
            if "filme" in dados:
                dados["filme"] = sanitizar_titulo_filme(dados.get("filme") or dados.get("filme_sugerido", ""))
                return dados
        
        print("[DEBUG] Nenhum JSON encontrado na resposta.")
        return None

    except Exception as e:
        print(f"Erro ao conversar com a IA: {e}")
        return None


# ==========================================
# 4. DADOS DO FILME (TMDb + Fallbacks)
# ==========================================
def obter_detalhes_filme_tmdb(nome_filme, ano=None, lang='en'):
    """
    Busca dados do filme no TMDb.
    O parametro 'lang' pode ser 'pt' ou 'en'.
    """
    if not TMDB_API_KEY:
        return None

    # Usa APENAS o nome limpo do filme na query; ano e passado separadamente
    nome_limpo = nome_filme
    idioma_tmdb = "pt-BR" if lang == 'pt' else "en-US"

    params_busca = {"api_key": TMDB_API_KEY, "query": nome_limpo, "language": idioma_tmdb}
    if ano:
        params_busca["primary_release_year"] = ano
    try:
        resp_busca = requests.get(URL_TMDB_BUSCA, params=params_busca, headers={"User-Agent": MOOVIBE_USER_AGENT}, timeout=10)
        if resp_busca.status_code != 200:
            return None
        dados_busca = resp_busca.json()
        if not dados_busca.get("results"):
            return None

        filme_basico = dados_busca["results"][0]
        filme_id = filme_basico["id"]

        print(f">>> [TMDB] FILME ENCONTRADO:")
        print(f"    ID: {filme_id}")
        print(f"    Titulo: {filme_basico.get('title')} ({filme_basico.get('original_title')})")
        print(f"    Data: {filme_basico.get('release_date')}")

        url_detalhes = f"{URL_TMDB_BASE}/{filme_id}"
        resp_detalhes = requests.get(url_detalhes, params={"api_key": TMDB_API_KEY, "language": idioma_tmdb}, headers={"User-Agent": MOOVIBE_USER_AGENT}, timeout=10)
        detalhes = resp_detalhes.json() if resp_detalhes.status_code == 200 else {}

        url_creditos = f"{URL_TMDB_BASE}/{filme_id}/credits"
        resp_creditos = requests.get(url_creditos, params={"api_key": TMDB_API_KEY, "language": idioma_tmdb}, headers={"User-Agent": MOOVIBE_USER_AGENT}, timeout=10)
        creditos = resp_creditos.json() if resp_creditos.status_code == 200 else {}
        diretor = "Nao encontrado"
        for pessoa in creditos.get("crew", []):
            if pessoa.get("job") == "Director":
                diretor = pessoa.get("name")
                break

        url_imagens = f"{URL_TMDB_BASE}/{filme_id}/images"
        params_imagens = {"api_key": TMDB_API_KEY, "include_image_language": "en,null"}
        resp_imagens = requests.get(url_imagens, params=params_imagens, headers={"User-Agent": MOOVIBE_USER_AGENT}, timeout=10)
        dados_imagens = resp_imagens.json() if resp_imagens.status_code == 200 else {}

        cenas = []
        for backdrop in dados_imagens.get("backdrops", [])[:15]:
            if backdrop.get("file_path"):
                cenas.append(f"https://image.tmdb.org/t/p/w780{backdrop['file_path']}")

        poster_url = None
        for poster in dados_imagens.get("posters", []):
            if poster.get("file_path"):
                lang_poster = (poster.get("iso_639_1") or "").lower()
                if lang_poster in ("en", "") or lang_poster is None:
                    poster_url = f"https://image.tmdb.org/t/p/w500{poster['file_path']}"
                    break
        if not poster_url and filme_basico.get("poster_path"):
            poster_url = f"https://image.tmdb.org/t/p/w500{filme_basico['poster_path']}"

        # Busca tagline do TMDb para usar como fallback de citacoes
        tagline = detalhes.get("tagline") if isinstance(detalhes, dict) else None
        if tagline and isinstance(tagline, str):
            tagline = tagline.strip()

        return {
            "id_tmdb": filme_id,
            "titulo_pt": filme_basico.get("title"),
            "titulo_original": filme_basico.get("original_title"),
            "ano": filme_basico.get("release_date", "----")[:4],
            "sinopse": filme_basico.get("overview", "Sem sinopse disponivel."),
            "poster": poster_url,
            "diretor": diretor,
            "imdb_id": detalhes.get("imdb_id"),
            "cenas": cenas,
            "tagline": tagline or ""
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


def buscar_dados_filme_fallback(nome_filme, ano, lang='en'):
    """
    Fallback para dados do filme quando TMDb falha.
    CAMADA 1: Wikipedia (forcando 'filme' no termo)
    CAMADA 2: Brave Search (movie plot synopsis)
    """
    wiki_url = URL_WIKIPEDIA_PT if lang == 'pt' else URL_WIKIPEDIA_EN
    wiki_label = "Wikipedia PT" if lang == 'pt' else "Wikipedia EN"
    print(f"[FILME FALLBACK] CAMADA 1: {wiki_label}...")
    try:
        termos = []
        if ano:
            termos.append(f"{nome_filme} ({ano}) filme")
            termos.append(f"{nome_filme} {ano} filme")
        termos.append(f"{nome_filme} filme")
        termos.append(nome_filme)

        for termo in termos:
            print(f"[FALLBACK] Query Wikipedia: {termo}")
            url = f"{wiki_url}{urllib.parse.quote(termo)}"
            headers = {"User-Agent": MOOVIBE_USER_AGENT}
            resp = requests.get(url, headers=headers, timeout=10)
            if resp.status_code == 200:
                dados = resp.json()
                if dados.get("type") == "disambiguation":
                    print(f"[FALLBACK] Wikipedia: disambiguation encontrado para '{termo}'")
                    continue
                extract = dados.get("extract", "")
                if extract:
                    sinopse = extrair_duas_primeiras_frases(extract)
                    diretor = extrair_diretor_wikipedia(extract)
                    poster_url = None
                    originalimage = dados.get("originalimage") or {}
                    if isinstance(originalimage, dict):
                        poster_url = originalimage.get("source")

                    print(f"[FALLBACK ATIVADO: {wiki_label}]")
                    print(f"  Termo: {termo}")
                    print(f"  Sinopse extraida: {sinopse[:150]}...")
                    print(f"  Diretor: {diretor}")
                    print(f"  Poster: {poster_url}")
                    return {
                        "sinopse": sinopse[:2000],
                        "diretor": diretor,
                        "poster": poster_url
                    }

    except Exception as e:
        print(f"[FILME FALLBACK] Wikipedia erro: {e}")

    print("[FILME FALLBACK] CAMADA 2: Brave Search...")
    try:
        query = f"{nome_filme} movie plot synopsis"
        if ano:
            query = f"{nome_filme} {ano} movie plot synopsis"
        print(f"[FALLBACK] Query Brave: {query}")
        resultado = buscar_brave(query)
        if resultado:
            print(f"[FALLBACK ATIVADO: Brave Search]")
            print(f"  Resultado bruto: {resultado[:300]}...")
            return {
                "sinopse": resultado[:2000],
                "diretor": "Disponível na Web",
                "poster": None
            }
    except Exception as e:
        print(f"[FILME FALLBACK] Brave Search erro: {e}")

    print("[FILME FALLBACK] CAMADA 3: OpenRouter (fallback final)...")
    if OPENROUTER_API_KEY:
        try:
            idioma_prompt = "em português" if lang == 'pt' else "in English"
            prompt = (
                f"Generate a brief movie synopsis based on the search context. "
                f"Return strictly JSON with: 'sinopse' ({idioma_prompt}), 'diretor', 'poster' (URL or null)."
            )
            payload = {
                "model": "openrouter/free",
                "temperature": 0.3,
                "max_tokens": 500,
                "messages": [{"role": "user", "content": prompt}]
            }
            headers = {
                "Authorization": f"Bearer {OPENROUTER_API_KEY}",
                "Content-Type": "application/json",
                "HTTP-Referer": "https://moovibe.pages.dev",
                "X-Title": "Moovibe",
            }
            print(f"\n[DEBUG] Enviando Payload para OpenRouter (FILME FALLBACK):\n{json.dumps(payload, indent=2, ensure_ascii=False)}")
            tempo_inicio = time.time()
            resp = requests.post(URL_OPENROUTER, headers=headers, json=payload, timeout=20)
            tempo_resposta = round(time.time() - tempo_inicio, 2)
            print(f"[FILME FALLBACK] OpenRouter status: {resp.status_code} | Tempo: {tempo_resposta}s")
            resp.raise_for_status()
            dados_resp = resp.json()
            texto = ""
            if isinstance(dados_resp, dict):
                choices = dados_resp.get("choices")
                if choices and isinstance(choices, list) and len(choices) > 0 and choices[0]:
                    texto = choices[0].get("message", {}).get("content", "")
            if texto and isinstance(texto, str):
                print(f"[FILME FALLBACK] OpenRouter resposta bruta: {texto[:300]}...")
                dados = extrair_json_de_texto(texto)
                if dados and isinstance(dados, dict):
                    poster = dados.get("poster")
                    if poster and not str(poster).startswith('http'):
                        poster = None
                    return {
                        "sinopse": dados.get("sinopse", "Sinopse indisponível.") or "Sinopse indisponível.",
                        "diretor": dados.get("diretor", "Não encontrado") or "Não encontrado",
                        "poster": poster
                    }
                else:
                    print("[FILME FALLBACK] OpenRouter JSON não encontrado, usando texto como sinopse.")
                    return {
                        "sinopse": texto[:2000],
                        "diretor": "Encontrado via IA",
                        "poster": None
                    }
        except Exception as e:
            print(f"[FILME FALLBACK] OpenRouter erro: {e}")

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

    # Selecao de idioma
    idioma = input("Select language / Selecione o idioma [1] English [2] Português (Default: 1): ").strip()
    LANG = 'pt' if idioma == '2' else 'en'

    if not OPENROUTER_API_KEY:
        print("[ERRO] OPENROUTER_API_KEY nao encontrada no seu arquivo .env!")
        return
    if not TMDB_API_KEY:
        print("[AVISO] TMDB_API_KEY nao configurada. O app funcionara apenas com recomendacoes de texto.")

    # ---- LOGS DE VARIAVEIS DE AMBIENTE ----
    print("\n[DEBUG] VARIAVEIS DE AMBIENTE:")
    env_vars = {
        "OPENROUTER_API_KEY": OPENROUTER_API_KEY,
        "TMDB_API_KEY": TMDB_API_KEY,
        "GENIUS_API_KEY": GENIUS_API_KEY,
        "GOOGLE_SEARCH_API_KEY": os.getenv("GOOGLE_SEARCH_API_KEY"),
        "GOOGLE_CSE_CX": os.getenv("GOOGLE_CSE_CX"),
    }
    for key, val in env_vars.items():
        status = "[OK]" if val else "[NAO CONFIGURADO]"
        print(f"  {status} {key}")

    while True:
        print()
        if LANG == 'pt':
            nome_musica = input("Digite o nome da musica (ou 'sair'): ").strip()
        else:
            nome_musica = input("Enter song name (or 'exit'): ").strip()
        if nome_musica.lower() in ['sair', 'exit']:
            print()
            if LANG == 'pt':
                print("Até a próxima! Bom filme!")
            else:
                print("See you next time! Enjoy the movie!")
            break

        if not nome_musica:
            continue

        if LANG == 'pt':
            artista = input("Digite o nome do artista/banda: ").strip()
            if not artista:
                print("Por favor, digite o artista tambem para termos precisao.")
                continue
        else:
            artista = input("Enter artist/band name: ").strip()
            if not artista:
                print("Please enter the artist as well for accuracy.")
                continue

        print()
        if LANG == 'pt':
            print("=== BUSCANDO LETRA DA MUSICA ===")
        else:
            print("=== SEARCHING SONG LYRICS ===")
        letra = buscar_letra_musica(nome_musica, artista)
        if letra:
            if LANG == 'pt':
                print("✓ Letra obtida com sucesso.")
            else:
                print("✓ Lyrics obtained successfully.")
        else:
            if LANG == 'pt':
                print("✗ Letra nao encontrada. Seguindo sem letra.")
            else:
                print("✗ Lyrics not found. Proceeding without lyrics.")

        print()
        if LANG == 'pt':
            print("=== BUSCANDO CONTEXTO/SIGNIFICADO ===")
        else:
            print("=== SEARCHING CONTEXT/MEANING ===")
        contexto_extra = buscar_contexto_musica(nome_musica, artista, LANG)
        if contexto_extra:
            if LANG == 'pt':
                print("✓ Contexto obtido com sucesso.")
            else:
                print("✓ Context obtained successfully.")
        else:
            if LANG == 'pt':
                print("✗ Contexto nao encontrado.")
            else:
                print("✗ Context not found.")

        print()
        if LANG == 'pt':
            print("=== ANALISANDO VIBE (IA) ===")
        else:
            print("=== ANALYZING VIBE (AI) ===")
        # Obtém filmes excluídos do histórico
        filmes_excluidos_globais, filmes_excluidos_musica = obter_filmes_excluidos(nome_musica, artista)
        if filmes_excluidos_globais:
            print(f"[ANTI-REPETICAO] Globais excluidos: {', '.join(filmes_excluidos_globais)}")
        if filmes_excluidos_musica:
            print(f"[ANTI-REPETICAO] Especificos da musica excluidos: {', '.join(filmes_excluidos_musica)}")

        recomendacao_ia = obter_recomendacao_ia(
            nome_musica, artista, letra, contexto_extra,
            filmes_excluidos_globais=filmes_excluidos_globais,
            filmes_excluidos_musica=filmes_excluidos_musica,
            lang=LANG
        )

        if not recomendacao_ia:
            if LANG == 'pt':
                print("Falha ao obter recomendacao da IA. Tente novamente.")
            else:
                print("Failed to get AI recommendation. Try again.")
            continue

        # Sanitizacao do titulo do filme (remove ano colado)
        nome_filme_ia = sanitizar_titulo_filme(
            recomendacao_ia.get("filme") or recomendacao_ia.get("filme_sugerido", "")
        )
        ano_filme_ia = recomendacao_ia.get("ano") or recomendacao_ia.get("ano_filme", "")
        justificativa = recomendacao_ia.get("justificativa") or recomendacao_ia.get("justificativa_vibe", "")
        vibe_title = recomendacao_ia.get("vibe_title") or "CINEMATIC VIBE"
        tags = recomendacao_ia.get("tags") or []

        if not nome_filme_ia:
            if LANG == 'pt':
                print("IA nao retornou um nome de filme valido. Tente novamente.")
            else:
                print("AI did not return a valid movie name. Try again.")
            continue

        # Adiciona ao histórico em memória
        adicionar_ao_historico(nome_musica, artista, nome_filme_ia)

        print()
        if LANG == 'pt':
            print("=== BUSCANDO DADOS DO FILME ===")
        else:
            print("=== SEARCHING MOVIE DATA ===")
        # Passa APENAS o nome limpo do filme, sem ano concatenado
        print(f"TMDb: '{nome_filme_ia}' (ano separado: '{ano_filme_ia}')...")
        dados_filme = obter_detalhes_filme_tmdb(nome_filme_ia, ano_filme_ia, LANG)

        if not dados_filme or not dados_filme.get("sinopse") or dados_filme["sinopse"] in ("Sem sinopse disponivel.", ""):
            print("[FALLBACK ATIVADO: TMDb falhou, usando fallback]")
            fallback = buscar_dados_filme_fallback(nome_filme_ia, ano_filme_ia, LANG)
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
        if LANG == 'pt':
            print("=== BUSCANDO CITACOES DO FILME ===")
        else:
            print("=== SEARCHING MOVIE QUOTES ===")
        citacoes = buscar_citacoes_filme(nome_filme_ia)
        # Detecta se o fallback generico foi usado (frases padrao)
        CITACOES_PADRAO = ["Cinema is magic.", "Every film is a journey.", "Lights, camera, action!"]
        is_fallback_padrao = (citacoes == CITACOES_PADRAO)
        
        # Fallback: usar quotes da letra se as quotes do Brave falharem
        if is_fallback_padrao or len(citacoes) < 3:
            quotes_da_letra = extrair_quotes_da_letra(letra, 3)
            if quotes_da_letra and len(quotes_da_letra) >= 3:
                citacoes = quotes_da_letra
            elif is_fallback_padrao:
                # Manter fallback padrao se nao houver letra
                citacoes = CITACOES_PADRAO
        
        # Se Brave falhou (fallback padrao) ou retornou menos de 3, tenta usar a tagline do TMDb
        if (is_fallback_padrao or len(citacoes) < 3) and dados_filme and dados_filme.get("tagline"):
            tagline = dados_filme["tagline"].strip()
            if tagline:
                # Se for fallback padrao, substitui a primeira citacao pela tagline
                if is_fallback_padrao:
                    citacoes = [tagline, citacoes[1], citacoes[2]]
                elif tagline not in citacoes:
                    citacoes.insert(0, tagline)
                    citacoes = citacoes[:3]
        if dados_filme:
            dados_filme["citacoes"] = citacoes

        print()
        print("==================================================")
        if LANG == 'pt':
            print("FILME RECOMENDADO:")
        else:
            print("RECOMMENDED MOVIE:")
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
        if LANG == 'pt':
            print("POR QUE COMBINA? (COMPARACAO DE VIBE):")
        else:
            print("WHY IT MATCHES? (VIBE COMPARISON):")
        print("--------------------------------------------------")
        print(justificativa)
        print("--------------------------------------------------")

        if LANG == 'pt':
            print("LINKS IMPORTANTES:")
        else:
            print("IMPORTANT LINKS:")
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
        if LANG == 'pt':
            print(f"TikTok (Navegador): https://www.tiktok.com/search?q={tiktok_query}")
            print(f"TikTok (Abrir direto no App): tiktok://search?keyword={tiktok_query}")
        else:
            print(f"TikTok (Browser): https://www.tiktok.com/search?q={tiktok_query}")
            print(f"TikTok (Open directly in App): tiktok://search?keyword={tiktok_query}")

        # === PAYLOAD FINAL CONSOLIDADO ===
        payload_final = {
            "song": nome_musica,
            "artist": artista,
            "movie": {
                "title": dados_filme.get("titulo_pt") if dados_filme else nome_filme_ia,
                "original_title": dados_filme.get("titulo_original") if dados_filme else nome_filme_ia,
                "release_year": dados_filme.get("ano") if dados_filme else "Nao informado",
                "director": dados_filme.get("diretor") if dados_filme else "Nao encontrado",
                "synopsis": dados_filme.get("sinopse") if dados_filme else "Sinopse indisponivel.",
                "poster_url": dados_filme.get("poster") if dados_filme else None,
                "stills": dados_filme.get("cenas", []) if dados_filme else [],
                "quotes": dados_filme.get("citacoes", []) if dados_filme else [],
                "ai_explanation": f"<p>{justificativa}</p>",
                "vibe_title": vibe_title if 'vibe_title' in locals() else "CINEMATIC INTROSPECTION",
                "tags": tags if 'tags' in locals() else [],
                "imdb_url": f"https://www.imdb.com/title/{dados_filme['imdb_id']}/" if (dados_filme and dados_filme.get("imdb_id")) else f"https://www.imdb.com/find?q={urllib.parse.quote(nome_filme_ia)}",
                "letterboxd_url": f"https://letterboxd.com/tmdb/{dados_filme['id_tmdb']}" if (dados_filme and dados_filme.get("id_tmdb")) else f"https://letterboxd.com/search/{urllib.parse.quote(nome_filme_ia)}/",
                "tiktok_url": f"https://www.tiktok.com/search?q={tiktok_query}",
            }
        }
        print("\n" + "="*60)
        print(">>> [PAYLOAD FINAL CONSOLIDADO]")
        print("="*60)
        print(json.dumps(payload_final, indent=2, ensure_ascii=False))
        print("="*60)

        print("==================================================")

if __name__ == "__main__":
    main()