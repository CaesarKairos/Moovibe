"""Cliente da API do TMDB com paginação, retry e backoff exponencial."""

import os
import time

import requests
from dotenv import load_dotenv

load_dotenv()

TMDB_API_KEY = os.getenv("TMDB_API_KEY")
TMDB_BASE_URL = "https://api.themoviedb.org/3"
TMDB_IMAGE_BASE = "https://image.tmdb.org/t/p"

MOOVIBE_VERSION = "1.0"
MOOVIBE_USER_AGENT = f"Moovibe/{MOOVIBE_VERSION} (mailto:cesarbatistasantos08@gmail.com)"

# Rate limit: TMDB permite ~40 req/10s. Usamos 0.3s entre chamadas como margem segura.
DEFAULT_DELAY_SECONDS = 0.3
MAX_RETRIES = 5
RETRY_BACKOFF_BASE = 2.0  # segundos


class TMDBClientError(Exception):
    """Erro genérico do cliente TMDB."""


class TMDBRateLimitError(TMDBClientError):
    """Erro de rate limit (HTTP 429)."""


class TMDBClient:
    """Cliente simples para a API do TMDB com retry/backoff exponencial."""

    def __init__(self, api_key: str = None, delay: float = DEFAULT_DELAY_SECONDS):
        self.api_key = api_key or TMDB_API_KEY
        if not self.api_key:
            raise TMDBClientError("TMDB_API_KEY não encontrada. Verifique o .env.")
        self.delay = delay
        self._last_request_time = 0.0

    def _throttle(self):
        """Garante um intervalo mínimo entre chamadas para respeitar o rate limit."""
        now = time.time()
        wait = max(0.0, self.delay - (now - self._last_request_time))
        if wait > 0:
            time.sleep(wait)
        self._last_request_time = time.time()

    def _request(self, method: str, url: str, params: dict = None, **kwargs):
        """Executa uma requisição com retry/backoff exponencial em 429/5xx/erros de rede."""
        params = dict(params or {})
        params["api_key"] = self.api_key

        headers = kwargs.pop("headers", {})
        headers.setdefault("User-Agent", MOOVIBE_USER_AGENT)

        for tentativa in range(1, MAX_RETRIES + 1):
            self._throttle()
            try:
                resp = requests.request(method, url, params=params, headers=headers, timeout=15, **kwargs)

                if resp.status_code == 200:
                    return resp.json()

                if resp.status_code == 429:
                    retry_after = resp.headers.get("Retry-After")
                    espera = float(retry_after) if retry_after else RETRY_BACKOFF_BASE ** tentativa
                    print(f"[TMDB] Rate limit (429). Aguardando {espera:.1f}s (tentativa {tentativa}/{MAX_RETRIES})...")
                    time.sleep(espera)
                    continue

                if resp.status_code >= 500:
                    espera = RETRY_BACKOFF_BASE ** tentativa
                    print(f"[TMDB] Erro {resp.status_code}. Aguardando {espera:.1f}s (tentativa {tentativa}/{MAX_RETRIES})...")
                    time.sleep(espera)
                    continue

                # Outros erros (400, 401, 404, etc.) não são retryáveis
                raise TMDBClientError(f"TMDB retornou status {resp.status_code}: {resp.text[:200]}")

            except requests.exceptions.RequestException as e:
                espera = RETRY_BACKOFF_BASE ** tentativa
                print(f"[TMDB] Erro de rede: {e}. Aguardando {espera:.1f}s (tentativa {tentativa}/{MAX_RETRIES})...")
                time.sleep(espera)

        raise TMDBClientError(f"Falha após {MAX_RETRIES} tentativas para {url}")

    def discover_page(self, params: dict):
        """
        Consulta uma única página do endpoint discover/movie.

        Retorna o dict bruto da resposta: {"page": N, "results": [...], "total_pages": M}.
        """
        url = f"{TMDB_BASE_URL}/discover/movie"
        return self._request("GET", url, params=params)

    def get_movie_details(self, tmdb_id: int, language: str = "pt-BR"):
        """Busca detalhes completos de um filme (inclui runtime, status, homepage, etc.)."""
        url = f"{TMDB_BASE_URL}/movie/{tmdb_id}"
        return self._request("GET", url, params={"language": language})

    def get_movie_credits(self, tmdb_id: int, language: str = "pt-BR"):
        """Busca créditos de um filme (para extrair o diretor)."""
        url = f"{TMDB_BASE_URL}/movie/{tmdb_id}/credits"
        return self._request("GET", url, params={"language": language})

    def get_movie_keywords(self, tmdb_id: int):
        """Busca keywords de um filme."""
        url = f"{TMDB_BASE_URL}/movie/{tmdb_id}/keywords"
        return self._request("GET", url)

    def get_genre_list(self, language: str = "pt-BR"):
        """Retorna a lista de gêneros disponíveis no TMDB."""
        url = f"{TMDB_BASE_URL}/genre/movie/list"
        return self._request("GET", url, params={"language": language})


def normalizar_filme(item: dict, detalhes: dict = None, creditos: dict = None,
                     keywords: dict = None) -> dict:
    """
    Normaliza um item retornado pelo discover/movie para o formato do banco.

    `item` é o dict bruto do resultado da listagem.
    `detalhes`, `creditos` e `keywords` são respostas opcionais de endpoints
    complementares (já buscados pelo collector quando necessário).
    """
    filme = {
        "tmdb_id": item.get("id"),
        "title": item.get("title"),
        "original_title": item.get("original_title"),
        "overview": item.get("overview"),
        "release_date": item.get("release_date"),
        "original_language": item.get("original_language"),
        "origin_country": item.get("origin_country"),
        "genres": item.get("genre_ids") or [],
        "vote_average": item.get("vote_average"),
        "vote_count": item.get("vote_count"),
        "popularity": item.get("popularity"),
        "poster_path": item.get("poster_path"),
        "backdrop_path": item.get("backdrop_path"),
        "adult": item.get("adult", False),
        "video": item.get("video", False),
    }

    # Complementa com detalhes (quando disponíveis)
    if detalhes:
        filme["runtime"] = detalhes.get("runtime")
        filme["tagline"] = detalhes.get("tagline")
        filme["status"] = detalhes.get("status")
        filme["homepage"] = detalhes.get("homepage")
        filme["imdb_id"] = detalhes.get("imdb_id")
        # Gêneros completos (com nome) vêm dos detalhes
        if detalhes.get("genres"):
            filme["genres"] = [g.get("name") for g in detalhes["genres"]]

    # Diretor via créditos
    if creditos:
        diretor = None
        for pessoa in creditos.get("crew", []):
            if pessoa.get("job") == "Director":
                diretor = pessoa.get("name")
                break
        filme["director"] = diretor

    # Keywords
    if keywords and keywords.get("keywords"):
        filme["keywords"] = [k.get("name") for k in keywords["keywords"]]

    return filme