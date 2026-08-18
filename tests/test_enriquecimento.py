"""Testes do sistema de enriquecimento corrigido.

Cobre:
1. Isolamento entre filmes (A não recebe dados de B, respostas não se misturam).
2. Iteração por múltiplos lotes (mais de 21 filmes, provando que o segundo
   lote é processado).
3. Checkpoint: erro não vira done; running marca antes de processar.
4. Validação de resposta antes de salvar.
"""
import json
import os
import queue
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

# Garante que a raiz do projeto está no path
RAIZ = Path(__file__).resolve().parent.parent
if str(RAIZ) not in sys.path:
    sys.path.insert(0, str(RAIZ))

import sqlite3

from enrichment import db as enrichment_db
from enrichment.enricher import Enricher
from enrichment.ollama_client import validar_resposta


class BaseTestEnriquecimento(unittest.TestCase):
    """Base comum: cria um banco temporário isolado para cada teste."""

    def setUp(self):
        # Banco temporário isolado
        self._tmpdir = tempfile.TemporaryDirectory()
        self._db_path = os.path.join(self._tmpdir.name, "test_moovibe.db")
        os.environ["MOOVIBE_DB_PATH"] = self._db_path
        self._conexoes = []

        conn = sqlite3.connect(self._db_path)
        conn.executescript(
            """
            CREATE TABLE movies (
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
                updated_at TEXT,
                estilo TEXT
            );

            CREATE TABLE IF NOT EXISTS enrichment_progress (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                tmdb_id INTEGER NOT NULL UNIQUE,
                status TEXT DEFAULT 'pending',
                error_message TEXT,
                created_at TEXT,
                updated_at TEXT
            );

            CREATE TABLE IF NOT EXISTS enrichment_stats (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                processados INTEGER DEFAULT 0,
                com_busca_web INTEGER DEFAULT 0,
                erros INTEGER DEFAULT 0,
                tempo_total_segundos REAL DEFAULT 0
            );
            """
        )
        conn.commit()
        conn.close()

        # Inicializa as tabelas de enriquecimento no banco temporário
        enrichment_db.init_db()

    def tearDown(self):
        # Fecha conexões SQLite remanescentes antes de remover o diretório
        for conn in self._conexoes:
            try:
                conn.close()
            except Exception:
                pass
        self._conexoes.clear()
        import gc
        gc.collect()
        try:
            self._tmpdir.cleanup()
        except Exception:
            # No Windows, arquivos SQLite em modo WAL podem segurar por um instante;
            # não deixamos o teste falhar por causa disso.
            pass
        os.environ.pop("MOOVIBE_DB_PATH", None)

    def inserir_filme(self, tmdb_id, titulo, ano=2000, overview="Uma sinopse generica com bastante texto para teste de enriquecimento.", generos=None, keywords=None, diretor="Diretor Teste"):
        """Insere um filme no banco temporário."""
        if generos is None:
            generos = ["Drama"]
        if keywords is None:
            keywords = ["drama", "familia", "amor", "superacao", "viagem", "amizade", "sonho"]
        conn = sqlite3.connect(self._db_path)
        conn.execute(
            """
            INSERT INTO movies (
                tmdb_id, title, original_title, overview, release_date, release_year,
                original_language, origin_country, genres, runtime, vote_average,
                vote_count, popularity, director, keywords, poster_path, backdrop_path,
                tagline, status, homepage, imdb_id, adult, video, collected_from,
                created_at, updated_at, estilo
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
            """,
            (
                tmdb_id, titulo, titulo, overview, f"{ano}-01-01", ano,
                "en", "US", json.dumps(generos, ensure_ascii=False), 100,
                7.5, 100, 50.0, diretor,
                json.dumps(keywords, ensure_ascii=False), None, None,
                "", "", None, None, 0, 0, f'["Teste"]',
                "2025-01-01 00:00:00", "2025-01-01 00:00:00",
            ),
        )
        conn.commit()
        conn.close()

    def obter_filme(self, tmdb_id):
        conn = sqlite3.connect(self._db_path)
        conn.row_factory = sqlite3.Row
        row = conn.execute(
            "SELECT tmdb_id, title, release_year, overview, genres, keywords, director, estilo "
            "FROM movies WHERE tmdb_id = ?", (tmdb_id,)
        ).fetchone()
        conn.close()
        return dict(row) if row else None

    def obter_progresso(self, tmdb_id):
        conn = sqlite3.connect(self._db_path)
        conn.row_factory = sqlite3.Row
        row = conn.execute(
            "SELECT status, error_message FROM enrichment_progress WHERE tmdb_id = ?",
            (tmdb_id,)
        ).fetchone()
        conn.close()
        return dict(row) if row else None

    def obter_stats(self):
        conn = sqlite3.connect(self._db_path)
        conn.row_factory = sqlite3.Row
        row = conn.execute("SELECT * FROM enrichment_stats WHERE id = 1").fetchone()
        conn.close()
        return dict(row) if row else None


class TestIsolamentoEntreFilmes(BaseTestEnriquecimento):
    """Garante que um filme não recebe dados/respostas de outro."""

    def test_dois_filmes_diferentes_nao_se_misturam(self):
        """Processa dois filmes diferentes em sequência; cada resposta vai para o tmdb_id correto."""
        self.inserir_filme(100, "Filme A de Terror", ano=1990,
                           overview="Terror psicologico sobre uma casa assombrada e uma familia em pânico.",
                           generos=["Terror"], keywords=["terror", "casa assombrada", "familia", "medo", "suspense", "noite", "fantasma"])
        self.inserir_filme(200, "Filme B de Comedia", ano=2010,
                           overview="Comedia leve sobre um grupo de amigos que viaja para a praia e vive aventuras.",
                           generos=["Comédia"], keywords=["comedia", "amigos", "praia", "aventura", "humor", "viagem", "alegria"])

        fila = queue.Queue()
        enricher = Enricher(fila)

        # Mock da busca web: retorna contexto específico do filme atual
        def _fake_busca(titulo, ano=None):
            if "Terror" in titulo:
                return {"contexto": "Críticas destacam a atmosfera opressiva, escuridão e medo constante.", "avisos": []}
            if "Comedia" in titulo:
                return {"contexto": "Críticas destacam humor leve, cenários ensolarados e alegria contagiante.", "avisos": []}
            return {"contexto": "", "avisos": []}

        # Mock da IA: gera resposta com base no título recebido no prompt
        def _fake_ia(contexto, tmdb_id, titulo, on_log=None):
            # A resposta depende do título — se houver reutilização, os testes falham
            if "Terror" in titulo:
                resposta = {"moods": ["scared", "anxious"], "themes": ["fear", "haunting"],
                            "atmosphere": ["dark", "oppressive"], "pace": "slow",
                            "visual_style": ["shadowy", "gothic"], "melancholy_level": "high",
                            "tension_level": "high"}
            elif "Comedia" in titulo:
                resposta = {"moods": ["happy", "lighthearted"], "themes": ["friendship", "vacation"],
                            "atmosphere": ["sunny", "playful"], "pace": "fast",
                            "visual_style": ["bright", "colorful"], "melancholy_level": "low",
                            "tension_level": "low"}
            else:
                resposta = {"moods": ["neutral"], "themes": ["unknown"],
                            "atmosphere": ["plain"], "pace": "medium",
                            "visual_style": ["neutral"], "melancholy_level": "low",
                            "tension_level": "low"}
            if on_log:
                on_log("prompt", json.dumps(resposta))
            return resposta

        with patch("enrichment.enricher.buscar_contexto_web", side_effect=_fake_busca), \
             patch("enrichment.enricher.gerar_estilo", side_effect=_fake_ia):
            # Processa os dois filmes em sequência direta
            conn = enrichment_db.get_connection()
            try:
                for tid in (100, 200):
                    filme = enrichment_db.get_pendentes(conn, limite=10)
                    filme = next(f for f in filme if f["tmdb_id"] == tid)
                    enricher._processar_filme(conn, filme)
                conn.commit()
            finally:
                conn.close()

        filme_a = self.obter_filme(100)
        filme_b = self.obter_filme(200)

        self.assertIsNotNone(filme_a["estilo"])
        self.assertIsNotNone(filme_b["estilo"])

        estilo_a = json.loads(filme_a["estilo"])
        estilo_b = json.loads(filme_b["estilo"])

        # A resposta de A é específica do filme A
        self.assertIn("scared", estilo_a["moods"])
        self.assertIn("dark", estilo_a["atmosphere"])
        # A resposta de B é específica do filme B
        self.assertIn("happy", estilo_b["moods"])
        self.assertIn("sunny", estilo_b["atmosphere"])

        # As respostas NÃO são iguais (não houve reutilização acidental)
        self.assertNotEqual(estilo_a, estilo_b)

        # Cada resposta foi gravada no tmdb_id correto
        self.assertEqual(filme_a["title"], "Filme A de Terror")
        self.assertEqual(filme_b["title"], "Filme B de Comedia")

        # Checkpoint done depois do estilo salvo
        prog_a = self.obter_progresso(100)
        prog_b = self.obter_progresso(200)
        self.assertEqual(prog_a["status"], "done")
        self.assertEqual(prog_b["status"], "done")


class TestMultiplosLotes(BaseTestEnriquecimento):
    """Garante que a iteração processa mais de um lote (bug dos 20 filmes / lote único)."""

    def test_21_filmes_processados_em_dois_lotes(self):
        """Com LOTE_PADRAO=10, 21 filmes exigem 3 lotes — todos devem processar."""
        for i in range(1, 22):  # 21 filmes
            self.inserir_filme(i, f"Filme {i}", ano=2000 + i, overview=f"Sinopse do filme {i} com detalhes suficientes.")

        fila = queue.Queue()
        enricher = Enricher(fila)

        calls = {"n": 0}

        def _fake_busca(titulo, ano=None):
            return {"contexto": f"Contexto web específico de {titulo}", "avisos": []}

        def _fake_ia(contexto, tmdb_id, titulo, on_log=None):
            calls["n"] += 1
            return {"moods": [f"mood_{titulo.replace(' ', '_')}"], "themes": ["tema"],
                    "atmosphere": ["atmosfera"], "pace": "medium",
                    "visual_style": ["estilo"], "melancholy_level": "low",
                    "tension_level": "low"}

        with patch("enrichment.enricher.buscar_contexto_web", side_effect=_fake_busca), \
             patch("enrichment.enricher.gerar_estilo", side_effect=_fake_ia):
            enricher._run()
            enricher.persistir()

        # Todos os 21 foram chamados na IA
        self.assertEqual(calls["n"], 21)

        # Todos os filmes têm estilo salvo
        conn = sqlite3.connect(self._db_path)
        n_estilo = conn.execute(
            "SELECT COUNT(*) AS c FROM movies WHERE estilo IS NOT NULL AND TRIM(estilo) <> ''"
        ).fetchone()[0]
        conn.close()
        self.assertEqual(n_estilo, 21)

        # Todos estão done no progresso
        conn = sqlite3.connect(self._db_path)
        n_done = conn.execute(
            "SELECT COUNT(*) AS c FROM enrichment_progress WHERE status = 'done'"
        ).fetchone()[0]
        conn.close()
        self.assertEqual(n_done, 21)

        # Stats processados = 21
        stats = self.obter_stats()
        self.assertEqual(stats["processados"], 21)

    def test_lotes_continuam_ate_o_fim_100_filmes(self):
        """100 filmes exigem 10 lotes de 10 — todos devem processar."""
        for i in range(1, 101):
            self.inserir_filme(i, f"Filme {i}", ano=1990 + i, overview=f"Sinopse do filme {i} com detalhes suficientes para o contexto.")

        fila = queue.Queue()
        enricher = Enricher(fila)

        calls = {"n": 0}

        def _fake_busca(titulo, ano=None):
            return {"contexto": f"Contexto web específico de {titulo}", "avisos": []}

        def _fake_ia(contexto, tmdb_id, titulo, on_log=None):
            calls["n"] += 1
            return {"moods": [f"mood_{tmdb_id}"], "themes": ["tema"],
                    "atmosphere": ["atmosfera"], "pace": "medium",
                    "visual_style": ["estilo"], "melancholy_level": "low",
                    "tension_level": "low"}

        with patch("enrichment.enricher.buscar_contexto_web", side_effect=_fake_busca), \
             patch("enrichment.enricher.gerar_estilo", side_effect=_fake_ia):
            enricher._run()
            enricher.persistir()

        self.assertEqual(calls["n"], 100)

        conn = sqlite3.connect(self._db_path)
        n_estilo = conn.execute(
            "SELECT COUNT(*) AS c FROM movies WHERE estilo IS NOT NULL AND TRIM(estilo) <> ''"
        ).fetchone()[0]
        n_done = conn.execute(
            "SELECT COUNT(*) AS c FROM enrichment_progress WHERE status = 'done'"
        ).fetchone()[0]
        conn.close()
        self.assertEqual(n_estilo, 100)
        self.assertEqual(n_done, 100)


class TestCheckpointEErros(BaseTestEnriquecimento):
    """Garante que falhas não viram done e que o checkpoint permite retomada."""

    def test_erro_na_ia_nao_marca_done(self):
        """Se a IA falhar, o filme fica com status error e SEM estilo."""
        self.inserir_filme(1, "Filme Falha")

        fila = queue.Queue()
        enricher = Enricher(fila)

        def _fake_busca(titulo, ano=None):
            return {"contexto": "Contexto web", "avisos": []}

        def _fake_ia_falha(contexto, tmdb_id, titulo, on_log=None):
            raise RuntimeError("Falha simulada do Ollama")

        with patch("enrichment.enricher.buscar_contexto_web", side_effect=_fake_busca), \
             patch("enrichment.enricher.gerar_estilo", side_effect=_fake_ia_falha):
            conn = enrichment_db.get_connection()
            try:
                filme = enrichment_db.get_pendentes(conn, limite=10)[0]
                enricher._processar_filme(conn, filme)
                conn.commit()
            finally:
                conn.close()
            enricher.persistir()

        # Sem estilo salvo
        filme = self.obter_filme(1)
        self.assertIsNone(filme["estilo"])

        # Checkpoint com erro
        prog = self.obter_progresso(1)
        self.assertEqual(prog["status"], "error")
        self.assertIn("Falha simulada", prog["error_message"])

        # Stats de erro incrementado
        stats = self.obter_stats()
        self.assertEqual(stats["erros"], 1)
        self.assertEqual(stats["processados"], 0)

    def test_running_antes_de_processar(self):
        """O filme fica running durante o processamento antes de virar done."""
        self.inserir_filme(1, "Filme Running")

        fila = queue.Queue()
        enricher = Enricher(fila)

        def _fake_busca(titulo, ano=None):
            return {"contexto": "Contexto web", "avisos": []}

        def _fake_ia(contexto, tmdb_id, titulo, on_log=None):
            # Verifica que o checkpoint está running durante o processamento
            prog = self.obter_progresso(tmdb_id)
            assert prog["status"] == "running", f"Esperava running, got {prog}"
            return {"moods": ["tense"], "themes": ["tema"],
                    "atmosphere": ["atmosfera"], "pace": "medium",
                    "visual_style": ["estilo"], "melancholy_level": "low",
                    "tension_level": "low"}

        with patch("enrichment.enricher.buscar_contexto_web", side_effect=_fake_busca), \
             patch("enrichment.enricher.gerar_estilo", side_effect=_fake_ia):
            conn = enrichment_db.get_connection()
            try:
                filme = enrichment_db.get_pendentes(conn, limite=10)[0]
                enricher._processar_filme(conn, filme)
                conn.commit()
            finally:
                conn.close()

        # Depois do processamento, está done
        prog = self.obter_progresso(1)
        self.assertEqual(prog["status"], "done")


class TestValidacaoResposta(BaseTestEnriquecimento):
    """Testa a validação de resposta da IA antes de salvar."""

    def test_resposta_vazia_rejeitada(self):
        """Uma resposta sem conteúdo não deve ser aceita."""
        with self.assertRaises(ValueError):
            validar_resposta(
                {"moods": [], "themes": [], "atmosphere": [], "pace": "medium",
                 "visual_style": [], "melancholy_level": "low", "tension_level": "low"},
                tmdb_id=1, titulo="Filme Teste"
            )

    def test_resposta_valida_aceita(self):
        """Uma resposta com conteúdo é aceita."""
        # Não deve lançar exceção
        validar_resposta(
            {"moods": ["tense"], "themes": ["tema"], "atmosphere": ["dark"],
             "pace": "medium", "visual_style": ["estilo"],
             "melancholy_level": "low", "tension_level": "low"},
            tmdb_id=1, titulo="Filme Teste"
        )


if __name__ == "__main__":
    unittest.main()