"""Camada de banco de dados para a etapa de enriquecimento de estilo.

Reaproveita o mesmo banco SQLite do coletor (moovibe_library.db), mas usa
tabelas próprias desta etapa (enrichment_progress e enrichment_stats) para
não misturar com o checkpoint do coletor.

Cuidados de concorrência (mesmos do coletor):
- WAL habilitado (via library.db.get_connection)
- Retry curto em erro "database is locked"
- Migração idempotente via ALTER TABLE (não falha se a coluna já existir)
"""

import json
import logging
import sqlite3
import time

from library import db as library_db

logger = logging.getLogger(__name__)

# Nome da coluna nova na tabela movies.
COLUNA_ESTILO = "estilo"

# Número máximo de tentativas ao lidar com "database is locked".
MAX_RETRIES_LOCKED = 5

# Atraso inicial entre retries (segundos); dobra a cada tentativa.
RETRY_BASE_DELAY = 0.2


def get_connection():
    """Abre conexão SQLite reutilizando a configuração do coletor (WAL, row_factory)."""
    return library_db.get_connection()


def _executar_com_retry(conn, sql: str, params=()):
    """Executa um comando com retry curto em caso de 'database is locked'.

    O coletor roda em paralelo e pode estar escrevendo no mesmo banco.
    """
    tentativa = 0
    while True:
        try:
            conn.execute(sql, params)
            return
        except sqlite3.OperationalError as e:
            if "locked" not in str(e).lower():
                raise
            tentativa += 1
            if tentativa > MAX_RETRIES_LOCKED:
                raise
            delay = RETRY_BASE_DELAY * (2 ** (tentativa - 1))
            logger.debug("Banco ocupado (tentativa %d/%d), aguardando %.1fs: %s",
                         tentativa, MAX_RETRIES_LOCKED, delay, e)
            time.sleep(delay)


def init_db():
    """Cria as tabelas desta etapa e adiciona a coluna `estilo` de forma idempotente.

    Cada statement é executado individualmente com retry curto em caso de
    "database is locked", pois o coletor pode estar escrevendo no mesmo banco
    em paralelo.
    """
    conn = get_connection()
    try:
        # Tabela de checkpoint própria desta etapa (não mistura com collection_progress)
        _executar_com_retry(
            conn,
            """
            CREATE TABLE IF NOT EXISTS enrichment_progress (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                tmdb_id INTEGER NOT NULL UNIQUE,
                status TEXT DEFAULT 'pending',
                error_message TEXT,
                created_at TEXT,
                updated_at TEXT
            )
            """
        )

        _executar_com_retry(
            conn,
            """
            CREATE TABLE IF NOT EXISTS enrichment_stats (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                processados INTEGER DEFAULT 0,
                com_busca_web INTEGER DEFAULT 0,
                erros INTEGER DEFAULT 0,
                tempo_total_segundos REAL DEFAULT 0
            )
            """
        )

        # Inicializa a linha única de stats se ainda não existir
        row = conn.execute("SELECT id FROM enrichment_stats WHERE id = 1").fetchone()
        if row is None:
            _executar_com_retry(
                conn,
                "INSERT INTO enrichment_stats "
                "(id, processados, com_busca_web, erros, tempo_total_segundos) "
                "VALUES (1, 0, 0, 0, 0)"
            )

        # Migração idempotente: adiciona a coluna `estilo` se não existir.
        # Verifica via PRAGMA table_info para não falhar se já existir.
        colunas = [r["name"] for r in conn.execute("PRAGMA table_info(movies)").fetchall()]
        if COLUNA_ESTILO not in colunas:
            _executar_com_retry(
                conn,
                f"ALTER TABLE movies ADD COLUMN {COLUNA_ESTILO} TEXT"
            )
            logger.info("Coluna '%s' adicionada à tabela movies.", COLUNA_ESTILO)

        conn.commit()
    finally:
        conn.close()


def _now():
    """Timestamp ISO local."""
    return time.strftime("%Y-%m-%d %H:%M:%S")


def get_pendentes(conn, limite: int = 10):
    """Retorna filmes sem estilo, em lotes pequenos.

    Processa apenas filmes onde `estilo IS NULL` (permite resumir se
    interrompido). O lote pequeno evita segurar transação longa enquanto
    o coletor escreve no mesmo banco.
    """
    return conn.execute(
        "SELECT tmdb_id, title, release_year, overview, genres, keywords, director "
        "FROM movies WHERE estilo IS NULL OR TRIM(estilo) = '' ORDER BY tmdb_id LIMIT ?",
        (limite,),
    ).fetchall()


def count_pendentes(conn) -> int:
    """Total de filmes ainda sem estilo preenchido."""
    return conn.execute(
        "SELECT COUNT(*) AS c FROM movies "
        "WHERE estilo IS NULL OR TRIM(estilo) = ''"
    ).fetchone()["c"]


def count_processados(conn) -> int:
    """Total de filmes com estilo preenchido."""
    return conn.execute(
        "SELECT COUNT(*) AS c FROM movies "
        "WHERE estilo IS NOT NULL AND TRIM(estilo) <> ''"
    ).fetchone()["c"]


def salvar_estilo(conn, tmdb_id: int, estilo: dict):
    """Salva o JSON de estilo na coluna `estilo` do filme (com retry em lock)."""
    payload = json.dumps(estilo, ensure_ascii=False)
    _executar_com_retry(
        conn,
        "UPDATE movies SET estilo = ?, updated_at = ? WHERE tmdb_id = ?",
        (payload, _now(), tmdb_id),
    )
    conn.commit()


def salvar_estilo_e_done(conn, tmdb_id: int, estilo: dict):
    """Salva o estilo e marca o checkpoint como done em uma única transação.

    Garante que `done` só é registrado depois que o estilo foi realmente
    persistido na tabela movies.
    """
    payload = json.dumps(estilo, ensure_ascii=False)
    agora = _now()
    _executar_com_retry(
        conn,
        "UPDATE movies SET estilo = ?, updated_at = ? WHERE tmdb_id = ?",
        (payload, agora, tmdb_id),
    )
    _executar_com_retry(
        conn,
        """
        INSERT INTO enrichment_progress (tmdb_id, status, error_message, created_at, updated_at)
        VALUES (?, 'done', NULL, ?, ?)
        ON CONFLICT(tmdb_id) DO UPDATE SET
            status = 'done',
            error_message = NULL,
            updated_at = excluded.updated_at
        """,
        (tmdb_id, agora, agora),
    )
    conn.commit()


def registrar_running(conn, tmdb_id: int):
    """Marca o filme como em processamento na tabela enrichment_progress."""
    agora = _now()
    _executar_com_retry(
        conn,
        """
        INSERT INTO enrichment_progress (tmdb_id, status, error_message, created_at, updated_at)
        VALUES (?, 'running', NULL, ?, ?)
        ON CONFLICT(tmdb_id) DO UPDATE SET
            status = 'running',
            error_message = NULL,
            updated_at = excluded.updated_at
        """,
        (tmdb_id, agora, agora),
    )
    conn.commit()


def reset_enriquecimento(conn=None):
    """Reseta completamente o enriquecimento: limpa estilos, progresso e stats.

    Ação explícita de migração/reinicialização — NÃO é chamada automaticamente
    na abertura do programa.
    """
    fechar = conn is None
    if conn is None:
        conn = get_connection()
    try:
        _executar_com_retry(conn, "UPDATE movies SET estilo = NULL")
        _executar_com_retry(conn, "DELETE FROM enrichment_progress")
        _executar_com_retry(conn, "DELETE FROM enrichment_stats")
        _executar_com_retry(
            conn,
            "INSERT INTO enrichment_stats "
            "(id, processados, com_busca_web, erros, tempo_total_segundos) "
            "VALUES (1, 0, 0, 0, 0)"
        )
        conn.commit()
    finally:
        if fechar:
            conn.close()


def registrar_checkpoint(conn, tmdb_id: int, status: str, error_message: str = None):
    """Registra o checkpoint de um filme na tabela enrichment_progress."""
    agora = _now()
    _executar_com_retry(
        conn,
        """
        INSERT INTO enrichment_progress (tmdb_id, status, error_message, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(tmdb_id) DO UPDATE SET
            status = excluded.status,
            error_message = excluded.error_message,
            updated_at = excluded.updated_at
        """,
        (tmdb_id, status, error_message, agora, agora),
    )
    conn.commit()


def get_enrichment_stats(conn):
    """Retorna os totais acumulados da tabela enrichment_stats (ou zeros se ausente)."""
    row = conn.execute(
        "SELECT processados, com_busca_web, erros, tempo_total_segundos "
        "FROM enrichment_stats WHERE id = 1"
    ).fetchone()
    if row is None:
        return {
            "processados": 0,
            "com_busca_web": 0,
            "erros": 0,
            "tempo_total_segundos": 0.0,
        }
    return {
        "processados": row["processados"] or 0,
        "com_busca_web": row["com_busca_web"] or 0,
        "erros": row["erros"] or 0,
        "tempo_total_segundos": row["tempo_total_segundos"] or 0.0,
    }


def save_enrichment_stats(conn, processados: int, com_busca_web: int,
                          erros: int, tempo_total_segundos: float):
    """Persiste os totais acumulados na tabela enrichment_stats (linha única id=1)."""
    _executar_com_retry(
        conn,
        """
        INSERT INTO enrichment_stats (
            id, processados, com_busca_web, erros, tempo_total_segundos
        ) VALUES (1, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
            processados = excluded.processados,
            com_busca_web = excluded.com_busca_web,
            erros = excluded.erros,
            tempo_total_segundos = excluded.tempo_total_segundos
        """,
        (processados, com_busca_web, erros, tempo_total_segundos),
    )
    conn.commit()