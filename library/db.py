"""Camada de banco de dados SQLite para a biblioteca de filmes do Moovibe."""

import json
import os
import sqlite3
import time
from pathlib import Path

# Caminho padrão do banco (pode ser sobrescrito via env MOOVIBE_DB_PATH)
DEFAULT_DB_PATH = Path(__file__).resolve().parent.parent / "moovibe_library.db"


def get_db_path():
    """Retorna o caminho do arquivo .db, respeitando a env MOOVIBE_DB_PATH se definida."""
    env_path = os.getenv("MOOVIBE_DB_PATH")
    if env_path:
        return Path(env_path)
    return DEFAULT_DB_PATH


def get_connection():
    """Abre uma conexão SQLite com row_factory e WAL habilitado."""
    db_path = get_db_path()
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(db_path), timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL;")
    conn.execute("PRAGMA foreign_keys=ON;")
    return conn


def init_db():
    """Cria as tabelas do schema se ainda não existirem."""
    conn = get_connection()
    try:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS movies (
                tmdb_id INTEGER PRIMARY KEY,
                title TEXT,
                original_title TEXT,
                overview TEXT,
                release_date TEXT,
                release_year INTEGER,
                original_language TEXT,
                origin_country TEXT,
                genres TEXT,
                runtime INTEGER,
                vote_average REAL,
                vote_count INTEGER,
                popularity REAL,
                director TEXT,
                keywords TEXT,
                poster_path TEXT,
                backdrop_path TEXT,
                tagline TEXT,
                status TEXT,
                homepage TEXT,
                imdb_id TEXT,
                adult INTEGER DEFAULT 0,
                video INTEGER DEFAULT 0,
                collected_from TEXT,
                created_at TEXT,
                updated_at TEXT
            );

            CREATE TABLE IF NOT EXISTS collection_progress (
                query_id TEXT PRIMARY KEY,
                label TEXT,
                last_page INTEGER DEFAULT 0,
                total_pages INTEGER DEFAULT 0,
                status TEXT DEFAULT 'pending',
                error_message TEXT,
                created_at TEXT,
                updated_at TEXT
            );

            CREATE INDEX IF NOT EXISTS idx_movies_release_year ON movies(release_year);
            CREATE INDEX IF NOT EXISTS idx_movies_original_language ON movies(original_language);
            CREATE INDEX IF NOT EXISTS idx_movies_vote_average ON movies(vote_average);
            CREATE INDEX IF NOT EXISTS idx_movies_popularity ON movies(popularity);
            """
        )
        conn.commit()
    finally:
        conn.close()


def _now():
    """Timestamp ISO local."""
    return time.strftime("%Y-%m-%d %H:%M:%S")


def _json_dumps(valor):
    """Serializa listas/dicts para JSON string; retorna None se vazio."""
    if valor is None:
        return None
    if isinstance(valor, (list, dict)):
        return json.dumps(valor, ensure_ascii=False)
    return valor


def _json_loads(valor):
    """Desserializa JSON string; retorna lista vazia se falhar."""
    if not valor:
        return []
    try:
        return json.loads(valor)
    except (json.JSONDecodeError, TypeError):
        return []


def upsert_movie(conn, filme: dict, origem: str) -> str:
    """
    Insere ou atualiza um filme na tabela movies usando UPSERT (ON CONFLICT DO UPDATE).

    `filme` deve conter as chaves retornadas pela API do TMDB (já normalizadas).
    `origem` é o rótulo da consulta (ex: "Brasil + Drama").

    Retorna: 'new' | 'updated' | 'duplicate'
    """
    tmdb_id = filme.get("tmdb_id")
    if not tmdb_id:
        return "duplicate"

    agora = _now()

    # Busca registro existente para acumular collected_from
    row = conn.execute(
        "SELECT collected_from FROM movies WHERE tmdb_id = ?", (tmdb_id,)
    ).fetchone()

    origens_existentes = _json_loads(row["collected_from"]) if row else []
    if origem not in origens_existentes:
        origens_existentes.append(origem)
    collected_from = _json_dumps(origens_existentes)

    release_date = filme.get("release_date") or ""
    release_year = None
    if release_date and len(release_date) >= 4:
        try:
            release_year = int(release_date[:4])
        except ValueError:
            release_year = None

    conn.execute(
        """
        INSERT INTO movies (
            tmdb_id, title, original_title, overview, release_date, release_year,
            original_language, origin_country, genres, runtime, vote_average,
            vote_count, popularity, director, keywords, poster_path, backdrop_path,
            tagline, status, homepage, imdb_id, adult, video, collected_from,
            created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(tmdb_id) DO UPDATE SET
            title = excluded.title,
            original_title = excluded.original_title,
            overview = excluded.overview,
            release_date = excluded.release_date,
            release_year = excluded.release_year,
            original_language = excluded.original_language,
            origin_country = excluded.origin_country,
            genres = excluded.genres,
            runtime = excluded.runtime,
            vote_average = excluded.vote_average,
            vote_count = excluded.vote_count,
            popularity = excluded.popularity,
            director = excluded.director,
            keywords = excluded.keywords,
            poster_path = excluded.poster_path,
            backdrop_path = excluded.backdrop_path,
            tagline = excluded.tagline,
            status = excluded.status,
            homepage = excluded.homepage,
            imdb_id = excluded.imdb_id,
            adult = excluded.adult,
            video = excluded.video,
            collected_from = excluded.collected_from,
            updated_at = excluded.updated_at
        """,
        (
            tmdb_id,
            filme.get("title"),
            filme.get("original_title"),
            filme.get("overview"),
            release_date,
            release_year,
            filme.get("original_language"),
            _json_dumps(filme.get("origin_country")),
            _json_dumps(filme.get("genres")),
            filme.get("runtime"),
            filme.get("vote_average"),
            filme.get("vote_count"),
            filme.get("popularity"),
            filme.get("director"),
            _json_dumps(filme.get("keywords")),
            filme.get("poster_path"),
            filme.get("backdrop_path"),
            filme.get("tagline"),
            filme.get("status"),
            filme.get("homepage"),
            filme.get("imdb_id"),
            1 if filme.get("adult") else 0,
            1 if filme.get("video") else 0,
            collected_from,
            agora,
            agora,
        ),
    )

    if row is None:
        return "new"
    return "updated"


def get_progress(conn, query_id: str):
    """Retorna o registro de progresso de uma consulta, ou None."""
    return conn.execute(
        "SELECT * FROM collection_progress WHERE query_id = ?", (query_id,)
    ).fetchone()


def upsert_progress(conn, query_id: str, label: str, last_page: int = 0,
                    total_pages: int = 0, status: str = "pending",
                    error_message: str = None):
    """Cria ou atualiza o checkpoint de uma consulta."""
    agora = _now()
    conn.execute(
        """
        INSERT INTO collection_progress (
            query_id, label, last_page, total_pages, status, error_message,
            created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(query_id) DO UPDATE SET
            label = excluded.label,
            last_page = excluded.last_page,
            total_pages = excluded.total_pages,
            status = excluded.status,
            error_message = excluded.error_message,
            updated_at = excluded.updated_at
        """,
        (query_id, label, last_page, total_pages, status, error_message, agora, agora),
    )
    conn.commit()


def get_pending_queries(conn):
    """Retorna todas as consultas que ainda não foram concluídas (status != 'done')."""
    return conn.execute(
        "SELECT * FROM collection_progress WHERE status != 'done' ORDER BY created_at"
    ).fetchall()


def get_all_queries(conn):
    """Retorna todas as consultas registradas."""
    return conn.execute(
        "SELECT * FROM collection_progress ORDER BY created_at"
    ).fetchall()


def count_movies(conn) -> int:
    """Total de filmes únicos no banco."""
    return conn.execute("SELECT COUNT(*) AS c FROM movies").fetchone()["c"]


def get_movie(conn, tmdb_id: int):
    """Busca um filme pelo tmdb_id."""
    return conn.execute(
        "SELECT * FROM movies WHERE tmdb_id = ?", (tmdb_id,)
    ).fetchone()