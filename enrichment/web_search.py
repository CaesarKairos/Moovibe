"""Busca web para filmes com pouca informação.

Usa `duckduckgo_search` (já dependência do projeto) para encontrar resenhas
e depois baixa o texto real das 2-3 primeiras páginas relevantes usando
`requests` + `trafilatura` para extração de texto limpo.

O texto raspado é usado APENAS como contexto passageiro para gerar o campo
de estilo daquele filme — não é armazenado permanentemente no banco.

Nota: se na prática muitos sites bloquearem a requisição simples (retornando
pouco ou nenhum texto), um fallback com automação de navegador (Selenium/
Playwright) pode ser adicionado depois. Nesse hardware (sem GPU dedicada,
rodando em paralelo com o coletor) isso pesa demais e pode abrir janela
visível, então não foi implementado agora.
"""

import logging
import warnings

import requests
import trafilatura

# O pacote duckduckgo_search foi renomeado para ddgs; suprime o warning
warnings.filterwarnings("ignore", message=".*renamed to `ddgs`.*")

logger = logging.getLogger(__name__)

# Número máximo de resultados de busca a considerar.
MAX_RESULTADOS_BUSCA = 8

# Número máximo de páginas cujo texto será baixado.
MAX_PAGINAS_BAIXAR = 3

# Tamanho máximo (em caracteres) do texto incluído no prompt por página.
# Limita o contexto enviado ao modelo local (que tem janela pequena).
MAX_CARACTERES_POR_PAGINA = 3000

# Tamanho máximo total do contexto web (soma de todas as páginas).
MAX_CARACTERES_TOTAL = 6000

# Timeout para requisições HTTP simples (segundos).
TIMEOUT_HTTP = 15

# User-Agent de navegador comum para evitar bloqueios simples.
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
)


def _consultar_ddgs(consulta: str) -> tuple:
    """Executa uma consulta no DuckDuckGo.

    Retorna (resultados, aviso) onde `resultados` é a lista de dicts e
    `aviso` é uma string com o motivo real da falha (rate limit, timeout,
    bloqueio, etc.) ou None se a busca funcionou. O aviso é útil para
    diagnosticar por que a busca retornou vazio.
    """
    try:
        # Suprime o warning de pacote renomeado (duckduckgo_search -> ddgs)
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", RuntimeWarning)
            from duckduckgo_search import DDGS

            with DDGS() as ddgs:
                resultados = list(ddgs.text(consulta, max_results=MAX_RESULTADOS_BUSCA))
                return resultados, None
    except Exception as e:
        logger.warning("Falha na busca DuckDuckGo para '%s': %s", consulta, e)
        return [], f"Falha na busca DuckDuckGo: {e}"


def _buscar_wikipedia(titulo: str, ano: int = None) -> tuple:
    """Busca o resumo do filme na Wikipedia (API oficial, sem bloqueio).

    Tenta primeiro a Wikipedia em português; se não achar, faz fallback
    para a inglesa. Retorna (texto, aviso) onde `texto` é o resumo do
    artigo (ou "" se não houver) e `aviso` é uma string com o motivo da
    falha ou None.
    """
    consulta = f"{titulo}"
    if ano:
        consulta += f" {ano}"

    for idioma, base in (("pt", "https://pt.wikipedia.org/w/api.php"),
                         ("en", "https://en.wikipedia.org/w/api.php")):
        try:
            # Passo 1: busca o título do artigo
            params_busca = {
                "action": "query",
                "list": "search",
                "srsearch": consulta,
                "srlimit": 1,
                "format": "json",
            }
            resp = requests.get(base, params=params_busca, timeout=TIMEOUT_HTTP,
                                headers={"User-Agent": USER_AGENT})
            resp.raise_for_status()
            dados = resp.json()
            resultados = dados.get("query", {}).get("search", [])
            if not resultados:
                continue

            titulo_artigo = resultados[0].get("title", "")
            if not titulo_artigo:
                continue

            # Passo 2: pega o resumo (intro) do artigo
            params_extract = {
                "action": "query",
                "prop": "extracts",
                "exintro": 1,
                "explaintext": 1,
                "titles": titulo_artigo,
                "format": "json",
            }
            resp2 = requests.get(base, params=params_extract, timeout=TIMEOUT_HTTP,
                                 headers={"User-Agent": USER_AGENT})
            resp2.raise_for_status()
            dados2 = resp2.json()
            paginas = dados2.get("query", {}).get("pages", {})
            for pagina in paginas.values():
                texto = pagina.get("extract", "")
                if texto:
                    return texto[:MAX_CARACTERES_POR_PAGINA], None

        except requests.RequestException as e:
            logger.warning("Falha na Wikipedia %s para '%s': %s", idioma, titulo, e)
            return "", f"Falha na Wikipedia {idioma}: {e}"

    return "", None


def _filtrar_relevantes(resultados: list, titulo: str) -> list:
    """Filtra resultados relevantes verificando se o título aparece no snippet/URL."""
    # Palavras do título para verificação de relevância (ignora palavras muito curtas)
    palavras_titulo = [p.lower() for p in titulo.split() if len(p) > 3]

    urls = []
    for r in resultados:
        url = (r or {}).get("href") or ""
        if not url or url in urls:
            continue

        snippet = ((r or {}).get("body") or "").lower()
        url_lower = url.lower()
        title_result = ((r or {}).get("title") or "").lower()

        # Verifica relevância: pelo menos uma palavra significativa do título
        # deve aparecer no snippet, na URL ou no título do resultado
        relevante = False
        for palavra in palavras_titulo:
            if palavra in snippet or palavra in url_lower or palavra in title_result:
                relevante = True
                break

        # Se o título tem palavras significativas mas nenhuma apareceu,
        # o resultado provavelmente é irrelevante (ex: comparação de GPUs)
        if palavras_titulo and not relevante:
            continue

        urls.append(url)
        if len(urls) >= MAX_PAGINAS_BAIXAR:
            break
    return urls


def _buscar_urls(titulo: str, ano: int = None) -> tuple:
    """Busca URLs de resenhas/críticas para o filme via DuckDuckGo.

    Tenta primeiro a consulta em português; se não encontrar resultados
    relevantes, faz fallback para inglês (que tende a retornar resenhas
    melhores: IMDb, Rotten Tomatoes, Metacritic, Wikipedia).

    Retorna (urls, avisos) onde `avisos` é uma lista de strings com os
    motivos reais de falha (rate limit, timeout, etc.) para diagnóstico.
    """
    sufixo_pt = " filme resenha critica tom atmosfera"
    sufixo_en = " movie review"

    consultas = []
    consulta_pt = f"{titulo}"
    if ano:
        consulta_pt += f" ({ano})"
    consulta_pt += sufixo_pt
    consultas.append(consulta_pt)

    consulta_en = f"{titulo}"
    if ano:
        consulta_en += f" {ano}"
    consulta_en += sufixo_en
    consultas.append(consulta_en)

    avisos = []
    for consulta in consultas:
        resultados, aviso = _consultar_ddgs(consulta)
        if aviso:
            avisos.append(aviso)
        if not resultados:
            continue
        urls = _filtrar_relevantes(resultados, titulo)
        if urls:
            return urls, avisos
        # Fallback: se o filtro de relevância descartou tudo (DuckDuckGo é
        # não-determinístico), usa os primeiros resultados mesmo assim — a
        # consulta já é específica (título + ano + resenha).
        urls_fallback = []
        for r in resultados:
            url = (r or {}).get("href") or ""
            if url and url not in urls_fallback:
                urls_fallback.append(url)
            if len(urls_fallback) >= MAX_PAGINAS_BAIXAR:
                break
        if urls_fallback:
            return urls_fallback, avisos

    return [], avisos


def _baixar_texto_pagina(url: str) -> str:
    """Baixa o texto principal de uma página usando requests + trafilatura.

    Retorna string com o texto extraído (vazio se falhar ou não houver
    conteúdo aproveitável).
    """
    try:
        resp = requests.get(
            url,
            timeout=TIMEOUT_HTTP,
            headers={"User-Agent": USER_AGENT},
        )
        resp.raise_for_status()
    except requests.RequestException as e:
        logger.debug("Falha ao baixar %s: %s", url, e)
        return ""

    if not resp.text:
        return ""

    try:
        texto = trafilatura.extract(
            resp.text,
            include_comments=False,
            include_tables=False,
            favor_recall=True,
        )
    except Exception as e:
        logger.debug("Falha ao extrair texto de %s: %s", url, e)
        return ""

    if not texto:
        return ""

    # Limita o tamanho por página
    return texto[:MAX_CARACTERES_POR_PAGINA]


def buscar_contexto_web(titulo: str, ano: int = None) -> dict:
    """Busca contexto web para um filme com pouca informação.

    Tenta primeiro a Wikipedia (API oficial, sem bloqueio de scraping);
    se não houver página do filme, cai para o DuckDuckGo + download de
    páginas de resenhas.

    Retorna um dict:
      - "contexto": string com trechos do texto real (pronta para o prompt)
      - "avisos": lista de strings com motivos reais de falha (rate limit,
        timeout, bloqueio de site) para diagnóstico no log de atividade

    O texto NÃO é armazenado permanentemente — é contexto passageiro.
    """
    avisos = []

    # 1) Wikipedia primeiro (API oficial, gratuita, sem bloqueio)
    texto_wiki, aviso_wiki = _buscar_wikipedia(titulo, ano)
    if aviso_wiki:
        avisos.append(aviso_wiki)
    if texto_wiki:
        return {"contexto": f"[Fonte: Wikipedia]\n{texto_wiki}", "avisos": avisos}

    # 2) Fallback: DuckDuckGo + download de páginas de resenhas
    urls, avisos_ddgs = _buscar_urls(titulo, ano)
    avisos.extend(avisos_ddgs)
    if not urls:
        return {"contexto": "", "avisos": avisos}

    trechos = []
    total_caracteres = 0

    for url in urls:
        texto = _baixar_texto_pagina(url)
        if not texto:
            continue

        # Remove quebras de linha excessivas para compactar
        linhas = [l.strip() for l in texto.splitlines() if l.strip()]
        texto_limpo = " ".join(linhas)

        trechos.append(f"[Fonte: {url}]\n{texto_limpo}")
        total_caracteres += len(texto_limpo)

        if total_caracteres >= MAX_CARACTERES_TOTAL:
            break

    if not trechos:
        return {"contexto": "", "avisos": avisos}

    contexto = "\n\n".join(trechos)
    # Garante o limite total mesmo com múltiplas páginas
    return {"contexto": contexto[:MAX_CARACTERES_TOTAL], "avisos": avisos}
