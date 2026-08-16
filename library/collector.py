"""Orquestrador da coleta: consulta TMDB, grava no SQLite e reporta progresso."""

import queue
import threading
import time

from . import db
from .queries import gerar_consultas
from .tmdb_client import TMDBClient, normalizar_filme


class Coletor:
    """
    Orquestra a coleta de filmes do TMDB para o SQLite.

    Roda em uma thread separada (iniciada pela GUI) e comunica o progresso
    através de uma fila thread-safe. Suporta pausar, parar e retomar
    (via tabela collection_progress no banco).
    """

    def __init__(self, fila_eventos: queue.Queue, detalhes_por_filme: bool = True):
        self.fila = fila_eventos
        self.client = TMDBClient()
        self.detalhes_por_filme = detalhes_por_filme
        self._pause_event = threading.Event()
        self._pause_event.set()  # começa "não pausado"
        self._stop_event = threading.Event()
        self._thread = None
        self._stats = {
            "novos": 0,
            "atualizados": 0,
            "duplicados": 0,
            "erros": 0,
            "paginas": 0,
        }
        self._stats_lock = threading.Lock()
        self._tempo_inicio = None
        self._total_consultas = 0
        self._consultas_concluidas = 0

    # ==========================================
    # CONTROLE DE EXECUÇÃO
    # ==========================================
    def iniciar(self):
        """Inicia a coleta em uma thread separada."""
        if self._thread and self._thread.is_alive():
            return
        self._stop_event.clear()
        self._pause_event.set()
        self._stats = {"novos": 0, "atualizados": 0, "duplicados": 0, "erros": 0, "paginas": 0}
        self._tempo_inicio = time.time()
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()

    def pausar(self):
        """Pausa a coleta (a thread atual termina a página em andamento)."""
        self._pause_event.clear()
        self._emitir_log("[CONTROLE] Coleta pausada.")

    def retomar(self):
        """Retoma a coleta pausada."""
        self._pause_event.set()
        self._emitir_log("[CONTROLE] Coleta retomada.")

    def parar(self):
        """Sinaliza para parar a coleta após a página atual."""
        self._stop_event.set()
        self._pause_event.set()  # garante que a thread não fique presa no pause
        self._emitir_log("[CONTROLE] Parada solicitada.")

    def esta_rodando(self):
        return self._thread is not None and self._thread.is_alive()

    # ==========================================
    # HELPERS DE EMISSÃO DE EVENTOS
    # ==========================================
    def _emitir(self, tipo: str, **dados):
        """Coloca um evento na fila para a GUI consumir."""
        try:
            self.fila.put({"tipo": tipo, **dados})
        except Exception:
            pass

    def _emitir_log(self, mensagem: str):
        self._emitir("log", mensagem=mensagem)

    def _emitir_stats(self, conn=None):
        with self._stats_lock:
            stats = dict(self._stats)
        tempo = 0
        if self._tempo_inicio:
            tempo = time.time() - self._tempo_inicio
        if conn is None:
            conn = db.get_connection()
            fechar = True
        else:
            fechar = False
        try:
            total_filmes = db.count_movies(conn)
        finally:
            if fechar:
                conn.close()
        self._emitir(
            "stats",
            **stats,
            total_filmes=total_filmes,
            tempo_execucao=tempo,
            consultas_concluidas=self._consultas_concluidas,
            total_consultas=self._total_consultas,
        )

    def _emitir_progresso(self, label: str, pagina: int, total_paginas: int):
        self._emitir("progresso", consulta=label, pagina=pagina, total_paginas=total_paginas)

    # ==========================================
    # LOOP PRINCIPAL
    # ==========================================
    def _run(self):
        conn = db.get_connection()
        try:
            db.init_db()

            # Registra todas as consultas geradas (sem apagar as já existentes)
            consultas = gerar_consultas()
            self._total_consultas = len(consultas)
            for consulta in consultas:
                existente = db.get_progress(conn, consulta["query_id"])
                if existente is None:
                    db.upsert_progress(
                        conn,
                        query_id=consulta["query_id"],
                        label=consulta["label"],
                        status="pending",
                    )

            # Carrega pendentes (status != 'done')
            pendentes = db.get_pending_queries(conn)
            self._emitir_log(f"[INICIO] {len(pendentes)} consultas pendentes de "
                             f"{self._total_consultas} total.")
            self._emitir_stats(conn)

            for registro in pendentes:
                if self._stop_event.is_set():
                    self._emitir_log("[FIM] Coleta interrompida pelo usuário.")
                    break

                self._pause_event.wait()  # bloqueia se pausado

                consulta = next(
                    (c for c in consultas if c["query_id"] == registro["query_id"]), None
                )
                if consulta is None:
                    # Consulta registrada mas não está mais na lista gerada
                    consulta = {
                        "query_id": registro["query_id"],
                        "label": registro["label"],
                        "params": {},
                    }
                    self._emitir_log(f"[AVISO] Consulta desconhecida no código: "
                                     f"{registro['label']}. Usando params vazios.")

                self._processar_consulta(conn, consulta, registro)

                self._consulta_concluida(conn, consulta["query_id"])

            # Concluído
            total_filmes = db.count_movies(conn)
            self._emitir_log(f"[FIM] Coleta concluída. Total de filmes no banco: {total_filmes}.")
            self._emitir("fim", motivo="concluido")
            self._emitir_stats(conn)

        except Exception as e:
            self._emitir_log(f"[ERRO FATAL] {e}")
            self._emitir("fim", motivo="erro", mensagem=str(e))
        finally:
            conn.close()

    def _consulta_concluida(self, conn, query_id: str):
        registro = db.get_progress(conn, query_id)
        label = registro["label"] if registro else query_id
        db.upsert_progress(conn, query_id=query_id, label=label, status="done")
        self._consultas_concluidas += 1
        self._emitir_log(f"[CHECKPOINT] Consulta concluída: {label}")
        self._emitir_stats(conn)

    def _processar_consulta(self, conn, consulta: dict, registro):
        """Processa uma consulta inteira (todas as páginas) com checkpoint."""
        query_id = consulta["query_id"]
        label = consulta["label"]
        params = consulta["params"]

        # Retoma da última página salva (checkpoint)
        pagina_inicial = max(1, registro["last_page"] + 1)
        total_paginas = max(1, registro["total_pages"])

        self._emitir_log(f"[CONSULTA] {label} (a partir da página {pagina_inicial})")
        self._emitir_progresso(label, pagina_inicial, total_paginas)

        # Marca como "em andamento"
        db.upsert_progress(
            conn,
            query_id=query_id,
            label=label,
            last_page=registro["last_page"],
            total_pages=total_paginas,
            status="running",
        )

        pagina = pagina_inicial
        while True:
            if self._stop_event.is_set():
                self._emitir_log(f"[PARADA] Consulta '{label}' pausada na página {pagina}.")
                db.upsert_progress(
                    conn,
                    query_id=query_id,
                    label=label,
                    last_page=pagina - 1,
                    total_pages=total_paginas,
                    status="running",
                    error_message="interrompido pelo usuário",
                )
                conn.commit()
                return

            self._pause_event.wait()  # bloqueia se pausado

            try:
                params_pagina = dict(params)
                params_pagina["page"] = pagina
                pagina_dados = self.client.discover_page(params_pagina)
            except Exception as e:
                with self._stats_lock:
                    self._stats["erros"] += 1
                self._emitir_log(f"[ERRO] Consulta '{label}', página {pagina}: {e}")
                db.upsert_progress(
                    conn,
                    query_id=query_id,
                    label=label,
                    last_page=pagina - 1,
                    total_pages=total_paginas,
                    status="error",
                    error_message=str(e),
                )
                conn.commit()
                return

            if not pagina_dados:
                self._emitir_log(f"[ERRO] Resposta vazia na consulta '{label}', página {pagina}.")
                with self._stats_lock:
                    self._stats["erros"] += 1
                return

            total_paginas = max(1, pagina_dados.get("total_pages") or 1)
            resultados = pagina_dados.get("results") or []

            with self._stats_lock:
                self._stats["paginas"] += 1

            # Processa cada filme da página
            for item in resultados:
                if self._stop_event.is_set():
                    break
                self._pause_event.wait()
                self._salvar_filme(conn, item, label)

            conn.commit()

            self._emitir_progresso(label, pagina, total_paginas)
            self._emitir_stats(conn)

            # Atualiza checkpoint após cada página
            db.upsert_progress(
                conn,
                query_id=query_id,
                label=label,
                last_page=pagina,
                total_pages=total_paginas,
                status="running",
            )

            if pagina >= total_paginas:
                break
            pagina += 1

        self._emitir_log(f"[CONCLUIDA] Consulta '{label}' finalizada "
                         f"({pagina} páginas, {len(resultados)} filmes na última).")

    def _salvar_filme(self, conn, item: dict, origem: str):
        """Normaliza, busca complementos e faz UPSERT de um único filme."""
        try:
            # Complementos opcionais (diretor, keywords, runtime, etc.)
            detalhes = None
            creditos = None
            keywords_resp = None

            if self.detalhes_por_filme:
                try:
                    detalhes = self.client.get_movie_details(item["id"])
                except Exception:
                    pass
                try:
                    creditos = self.client.get_movie_credits(item["id"])
                except Exception:
                    pass
                try:
                    keywords_resp = self.client.get_movie_keywords(item["id"])
                except Exception:
                    pass

            filme = normalizar_filme(item, detalhes=detalhes, creditos=creditos,
                                     keywords=keywords_resp)
            resultado = db.upsert_movie(conn, filme, origem)

            with self._stats_lock:
                if resultado == "new":
                    self._stats["novos"] += 1
                elif resultado == "updated":
                    self._stats["atualizados"] += 1
                else:
                    self._stats["duplicados"] += 1
        except Exception as e:
            with self._stats_lock:
                self._stats["erros"] += 1
            self._emitir_log(f"[ERRO] Falha ao salvar filme ID {item.get('id')}: {e}")