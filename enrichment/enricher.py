"""Orquestrador do enriquecimento de estilo: seleciona filmes, busca contexto
web quando necessário, chama o modelo local e salva o resultado no banco.

Roda em uma thread separada (iniciada pela GUI) e comunica o progresso
através de uma fila thread-safe. Suporta pausar, parar e retomar
(processa apenas filmes onde `estilo IS NULL`).
"""

import json
import queue
import threading
import time

from . import db
from .ollama_client import gerar_estilo
from .web_search import buscar_contexto_web

# Limiar para decidir se um filme tem "pouca informação" e merece busca web.
# Um filme com menos de 3 keywords e/ou overview curto (menos de 200 chars).
MIN_KEYWORDS_PARA_BUSCA = 3
MIN_OVERVIEW_PARA_BUSCA = 200

# Tamanho do lote de filmes carregados por vez do banco.
# Pequeno para não segurar transação longa enquanto o coletor escreve.
LOTE_PADRAO = 10


class Enricher:
    """Orquestra a geração do campo de estilo para filmes sem estilo."""

    def __init__(self, fila_eventos: queue.Queue):
        self.fila = fila_eventos
        self._pause_event = threading.Event()
        self._pause_event.set()  # começa "não pausado"
        self._stop_event = threading.Event()
        self._thread = None
        self._stats_lock = threading.Lock()

        # Carrega totais acumulados de sessões anteriores (tabela enrichment_stats)
        conn = db.get_connection()
        try:
            db.init_db()
            acumulado = db.get_enrichment_stats(conn)
        finally:
            conn.close()

        self._tempo_base_acumulado = float(acumulado["tempo_total_segundos"] or 0)
        self._stats = {
            "processados": 0,
            "com_busca_web": 0,
            "erros": 0,
        }
        self._stats_acumulados = {
            "processados": int(acumulado["processados"] or 0),
            "com_busca_web": int(acumulado["com_busca_web"] or 0),
            "erros": int(acumulado["erros"] or 0),
        }
        self._tempo_inicio = None
        self._filme_atual = None

    # ==========================================
    # CONTROLE DE EXECUÇÃO
    # ==========================================
    def iniciar(self):
        """Inicia o enriquecimento em uma thread separada."""
        if self._thread and self._thread.is_alive():
            return
        self._stop_event.clear()
        self._pause_event.set()

        # Recarrega totais acumulados do banco (pode ter persistido ao parar)
        conn = db.get_connection()
        try:
            acumulado = db.get_enrichment_stats(conn)
        finally:
            conn.close()
        self._tempo_base_acumulado = float(acumulado["tempo_total_segundos"] or 0)
        self._stats_acumulados = {
            "processados": int(acumulado["processados"] or 0),
            "com_busca_web": int(acumulado["com_busca_web"] or 0),
            "erros": int(acumulado["erros"] or 0),
        }

        self._stats = {"processados": 0, "com_busca_web": 0, "erros": 0}
        self._tempo_inicio = time.time()
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()

    def pausar(self):
        """Pausa o enriquecimento (a thread atual termina o filme em andamento)."""
        self._pause_event.clear()
        self._emitir_log("[CONTROLE] Enriquecimento pausado.")

    def retomar(self):
        """Retoma o enriquecimento pausado."""
        self._pause_event.set()
        self._emitir_log("[CONTROLE] Enriquecimento retomado.")

    def parar(self):
        """Sinaliza para parar após o filme atual."""
        self._stop_event.set()
        self._pause_event.set()  # garante que a thread não fique presa no pause
        self._emitir_log("[CONTROLE] Parada solicitada.")
        self._persistir_stats()

    def esta_rodando(self):
        return self._thread is not None and self._thread.is_alive()

    def persistir(self):
        """Persiste os totais acumulados da sessão atual na tabela enrichment_stats."""
        self._persistir_stats()

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

    def _emitir_atividade(self, mensagem: str):
        """Evento granular de atividade, roteado para o painel de detalhes na GUI."""
        self._emitir("atividade", mensagem=mensagem)

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
            pendentes = db.count_pendentes(conn)
            processados_no_banco = db.count_processados(conn)
        finally:
            if fechar:
                conn.close()
        self._emitir(
            "stats",
            **stats,
            pendentes=pendentes,
            processados_no_banco=processados_no_banco,
            tempo_execucao=tempo,
            processados_acumulados=self._stats_acumulados["processados"],
            com_busca_web_acumulados=self._stats_acumulados["com_busca_web"],
            erros_acumulados=self._stats_acumulados["erros"],
            tempo_base_acumulado=self._tempo_base_acumulado,
        )

    def _persistir_stats(self, conn=None):
        """Salva os totais acumulados na tabela enrichment_stats."""
        with self._stats_lock:
            stats = dict(self._stats)
        tempo = 0
        if self._tempo_inicio:
            tempo = time.time() - self._tempo_inicio

        processados = self._stats_acumulados["processados"] + stats.get("processados", 0)
        com_busca_web = self._stats_acumulados["com_busca_web"] + stats.get("com_busca_web", 0)
        erros = self._stats_acumulados["erros"] + stats.get("erros", 0)
        tempo_total = self._tempo_base_acumulado + tempo

        if conn is None:
            conn = db.get_connection()
            fechar = True
        else:
            fechar = False
        try:
            db.save_enrichment_stats(conn, processados, com_busca_web, erros, tempo_total)
        finally:
            if fechar:
                conn.close()

    # ==========================================
    # LOOP PRINCIPAL
    # ==========================================
    def _run(self):
        conn = db.get_connection()
        try:
            db.init_db()

            pendentes_total = db.count_pendentes(conn)
            self._emitir_log(f"[INICIO] {pendentes_total} filmes pendentes de enriquecimento.")
            self._emitir_stats(conn)

            while True:
                if self._stop_event.is_set():
                    self._emitir_log("[FIM] Enriquecimento interrompido pelo usuário.")
                    break

                self._pause_event.wait()  # bloqueia se pausado

                filmes = db.get_pendentes(conn, limite=LOTE_PADRAO)
                if not filmes:
                    break

                for filme in filmes:
                    if self._stop_event.is_set():
                        break
                    self._pause_event.wait()
                    self._processar_filme(conn, filme)

                conn.commit()

            # Concluído
            pendentes = db.count_pendentes(conn)
            self._emitir_log(f"[FIM] Enriquecimento concluído. "
                             f"Filmes ainda sem estilo: {pendentes}.")
            self._emitir("fim", motivo="concluido")
            self._emitir_stats(conn)

        except Exception as e:
            self._emitir_log(f"[ERRO FATAL] {e}")
            self._emitir("fim", motivo="erro", mensagem=str(e))
        finally:
            conn.close()

    # ==========================================
    # PROCESSAMENTO DE UM FILME
    # ==========================================
    def _processar_filme(self, conn, filme):
        """Gera e salva o estilo de um único filme."""
        tmdb_id = filme["tmdb_id"]
        titulo = filme["title"] or f"ID {tmdb_id}"
        ano = filme["release_year"]
        self._filme_atual = titulo
        self._emitir("filme_atual", titulo=titulo)

        try:
            # Decide se precisa de busca web (pouca informação)
            precisa_busca = self._precisa_busca_web(filme)

            contexto = self._montar_contexto(filme)
            contexto_web = ""

            if precisa_busca:
                self._emitir_atividade(f"Buscando contexto na web para '{titulo}'")
                resultado_busca = buscar_contexto_web(titulo, ano)
                contexto_web = resultado_busca.get("contexto", "")
                # Emite os motivos reais de falha (rate limit, timeout, etc.)
                # no log de atividade detalhado para diagnóstico
                for aviso in resultado_busca.get("avisos", []):
                    self._emitir_atividade(f"[AVISO] {aviso}")
                if contexto_web:
                    contexto += "\n\n--- Contexto adicional da web (resenhas/criticas) ---\n"
                    contexto += contexto_web
                    with self._stats_lock:
                        self._stats["com_busca_web"] += 1
                else:
                    self._emitir_atividade(
                        f"Busca web para '{titulo}' não retornou conteúdo aproveitável"
                    )

            self._emitir_atividade(f"Chamando modelo local para '{titulo}'")

            def _log_ia(prompt, resposta):
                """Registra o prompt enviado e a resposta bruta do modelo."""
                self._emitir_atividade(
                    f"[IA] Prompt enviado para '{titulo}': {prompt[:300]}"
                )
                self._emitir_atividade(
                    f"[IA] Resposta do modelo para '{titulo}': {resposta[:500]}"
                )

            estilo = gerar_estilo(contexto, on_log=_log_ia)

            # Confidence é calculado em Python puro (regra objetiva), não pelo
            # modelo — ele não calibra isso direito.
            estilo["confidence"] = self._calcular_confidence(filme, contexto_web)

            db.salvar_estilo(conn, tmdb_id, estilo)
            db.registrar_checkpoint(conn, tmdb_id, "done")

            with self._stats_lock:
                self._stats["processados"] += 1

            confianca = estilo.get("confidence", "unknown")
            self._emitir_log(f"Filme '{titulo}' processado, confiança: {confianca}")
            self._emitir_atividade(f"Estilo salvo para '{titulo}'")
            self._emitir_stats(conn)

        except Exception as e:
            with self._stats_lock:
                self._stats["erros"] += 1
            db.registrar_checkpoint(conn, tmdb_id, "error", str(e))
            self._emitir_log(f"[ERRO] Falha ao processar '{titulo}': {e}")
            self._emitir_atividade(f"Erro ao processar '{titulo}': {e}")
            self._emitir_stats(conn)

    def _precisa_busca_web(self, filme) -> bool:
        """Decide se o filme tem pouca informação e merece busca web.

        Critério: menos de 3 keywords e/ou overview curto (menos de 200 chars).
        """
        keywords = self._parse_lista(filme["keywords"])
        overview = filme["overview"] or ""

        if len(keywords) < MIN_KEYWORDS_PARA_BUSCA:
            return True
        if len(overview) < MIN_OVERVIEW_PARA_BUSCA:
            return True
        return False

    def _calcular_confidence(self, filme, contexto_web: str) -> str:
        """Calcula o nível de confiança em Python puro, com regra objetiva.

        - high: 8+ keywords E overview com 200+ caracteres
        - medium: 3-7 keywords OU overview com 100-199 caracteres
        - low: menos que isso

        Se a busca web trouxe contexto extra, conta a favor de subir o nível.
        """
        keywords = self._parse_lista(filme["keywords"])
        overview = filme["overview"] or ""
        n_keywords = len(keywords)
        len_overview = len(overview)

        if n_keywords >= 8 and len_overview >= 200:
            nivel = "high"
        elif (3 <= n_keywords <= 7) or (100 <= len_overview <= 199):
            nivel = "medium"
        else:
            nivel = "low"

        # Busca web com contexto extra sobe o nível
        if contexto_web:
            if nivel == "low":
                nivel = "medium"
            elif nivel == "medium":
                nivel = "high"

        return nivel

    def _montar_contexto(self, filme) -> str:
        """Monta o texto de contexto do filme para enviar ao modelo."""
        titulo = filme["title"] or ""
        ano = filme["release_year"]
        overview = filme["overview"] or ""
        generos = self._parse_lista(filme["genres"])
        keywords = self._parse_lista(filme["keywords"])
        diretor = filme["director"] or ""

        linhas = [f"Título: {titulo}"]
        if ano:
            linhas.append(f"Ano: {ano}")
        if diretor:
            linhas.append(f"Diretor: {diretor}")
        if generos:
            linhas.append(f"Gêneros: {', '.join(generos)}")
        if keywords:
            linhas.append(f"Palavras-chave: {', '.join(keywords)}")
        if overview:
            linhas.append(f"Sinopse: {overview}")

        return "\n".join(linhas)

    @staticmethod
    def _parse_lista(valor) -> list:
        """Converte JSON string de lista (ex: '["drama", "crime"]') em lista Python."""
        if not valor:
            return []
        if isinstance(valor, list):
            return valor
        try:
            dados = json.loads(valor)
            if isinstance(dados, list):
                return dados
            return []
        except (json.JSONDecodeError, TypeError):
            return []