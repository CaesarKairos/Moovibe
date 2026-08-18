"""Script explícito de reset do enriquecimento.

Faz backup do banco, limpa `movies.estilo`, reseta `enrichment_progress`
e zera `enrichment_stats`. Depois executa as validações de reconciliação.

USO:
    python reset_enriquecimento.py
    python reset_enriquecimento.py --confirm

O reset NÃO é executado automaticamente na abertura do programa.
"""
import argparse
import shutil
import sqlite3
import sys
import time
from pathlib import Path

RAIZ = Path(__file__).resolve().parent
DB_PATH = RAIZ / "moovibe_library.db"

def _get_conn():
    """Abre conexão com timeout amplo e busy_timeout (mesma política do app)."""
    conn = sqlite3.connect(str(DB_PATH), timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA busy_timeout = 30000;")
    conn.execute("PRAGMA journal_mode=WAL;")
    return conn


def fazer_backup():
    """Copia o banco atual para um arquivo com timestamp no nome."""
    if not DB_PATH.exists():
        print(f"[ERRO] Banco não encontrado: {DB_PATH}")
        sys.exit(1)

    timestamp = time.strftime("%Y%m%d_%H%M%S")
    backup_path = RAIZ / f"backups" / f"moovibe_backup_{timestamp}.db"
    backup_path.parent.mkdir(exist_ok=True)
    shutil.copy2(DB_PATH, backup_path)
    print(f"[OK] Backup criado: {backup_path}")
    return backup_path


def verificar_estado_atual(conn):
    """Exibe o estado atual antes do reset."""
    total = conn.execute("SELECT COUNT(*) AS c FROM movies").fetchone()["c"]
    com_estilo = conn.execute(
        "SELECT COUNT(*) AS c FROM movies "
        "WHERE estilo IS NOT NULL AND TRIM(estilo) <> ''"
    ).fetchone()["c"]

    print("\n=== ESTADO ATUAL ===")
    print(f"Total de filmes: {total}")
    print(f"Com estilo preenchido: {com_estilo}")

    print("\n=== ENRICHMENT_PROGRESS ===")
    for status in ("pending", "running", "done", "error"):
        c = conn.execute(
            "SELECT COUNT(*) AS c FROM enrichment_progress WHERE status = ?", (status,)
        ).fetchone()["c"]
        print(f"  {status}: {c}")

    print("\n=== ENRICHMENT_STATS ===")
    row = conn.execute("SELECT * FROM enrichment_stats WHERE id = 1").fetchone()
    print(dict(row) if row else "(sem registro)")


def executar_reset(conn):
    """Executa o reset completo do enriquecimento."""
    print("\n=== EXECUTANDO RESET ===")
    conn.execute("UPDATE movies SET estilo = NULL")
    n_progresso = conn.execute("DELETE FROM enrichment_progress").rowcount
    conn.execute("DELETE FROM enrichment_stats")
    conn.execute(
        "INSERT INTO enrichment_stats "
        "(id, processados, com_busca_web, erros, tempo_total_segundos) "
        "VALUES (1, 0, 0, 0, 0)"
    )
    conn.commit()
    print(f"[OK] movies.estilo limpo (todos os filmes)")
    print(f"[OK] enrichment_progress limpo ({n_progresso} registros removidos)")
    print(f"[OK] enrichment_stats zerado")


def validar_reconciliacao(conn):
    """Executa as validações de reconciliação solicitadas."""
    print("\n=== VALIDAÇÕES PÓS-RESET ===")

    # 1. Filmes com estilo preenchido
    c1 = conn.execute(
        "SELECT COUNT(*) AS c FROM movies "
        "WHERE estilo IS NOT NULL AND TRIM(estilo) <> ''"
    ).fetchone()["c"]
    print(f"Filmes com estilo: {c1} (esperado: 0)")

    # 2. enrichment_progress done
    c2 = conn.execute(
        "SELECT COUNT(*) AS c FROM enrichment_progress WHERE status = 'done'"
    ).fetchone()["c"]
    print(f"enrichment_progress done: {c2} (esperado: 0)")

    # 3. done sem estilo
    c3 = conn.execute(
        """
        SELECT COUNT(*) AS c FROM enrichment_progress p
        JOIN movies m ON m.tmdb_id = p.tmdb_id
        WHERE p.status = 'done' AND (m.estilo IS NULL OR TRIM(m.estilo) = '')
        """
    ).fetchone()["c"]
    print(f"done sem estilo: {c3} (esperado: 0)")

    # 4. estilo sem done
    c4 = conn.execute(
        """
        SELECT COUNT(*) AS c FROM enrichment_progress p
        JOIN movies m ON m.tmdb_id = p.tmdb_id
        WHERE m.estilo IS NOT NULL AND TRIM(m.estilo) <> '' AND p.status != 'done'
        """
    ).fetchone()["c"]
    print(f"estilo sem done: {c4} (esperado: 0)")

    # 5. Stats zerados
    row = conn.execute("SELECT * FROM enrichment_stats WHERE id = 1").fetchone()
    stats = dict(row) if row else {}
    print(f"enrichment_stats: {stats}")

    pendentes = conn.execute(
        "SELECT COUNT(*) AS c FROM movies "
        "WHERE estilo IS NULL OR TRIM(estilo) = ''"
    ).fetchone()["c"]
    print(f"Filmes pendentes (candidatos ao novo enriquecimento): {pendentes}")

    ok = c1 == 0 and c2 == 0 and c3 == 0 and c4 == 0
    print(f"\n{'[OK] Reconciliação validada!' if ok else '[ERRO] Reconciliação falhou!'}")
    return ok


def main():
    parser = argparse.ArgumentParser(description="Reset explícito do enriquecimento")
    parser.add_argument("--confirm", action="store_true",
                        help="Confirma a execução do reset (exigido por segurança)")
    args = parser.parse_args()

    if not args.confirm:
        print("[ATENÇÃO] Este script limpa TODOS os estilos e o progresso de enriquecimento.")
        print("Para executar, use: python reset_enriquecimento.py --confirm")
        sys.exit(0)

    conn = _get_conn()
    try:
        verificar_estado_atual(conn)
        backup = fazer_backup()
        executar_reset(conn)
        ok = validar_reconciliacao(conn)
        sys.exit(0 if ok else 1)
    finally:
        conn.close()


if __name__ == "__main__":
    main()