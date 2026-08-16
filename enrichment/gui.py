"""Interface gráfica CustomTkinter para o enriquecimento de estilo dos filmes.

Parecida com a GUI do coletor, mas específica da etapa de enriquecimento:
geração do campo de estilo via modelo local Ollama, com busca web opcional
para filmes com pouca informação.
"""

import queue
import time

import customtkinter as ctk

from . import db
from .enricher import Enricher

# Tema escuro consistente com a identidade do Moovibe
ctk.set_appearance_mode("dark")
ctk.set_default_color_theme("blue")

# Limite de linhas mantidas em cada painel de texto (evita estouro de memória)
LIMITE_LINHAS_LOG = 800
LIMITE_LINHAS_ATIVIDADE = 800


class EnrichmentGUI(ctk.CTk):
    """Janela principal com controles de Iniciar/Pausar/Parar e feedback."""

    def __init__(self):
        super().__init__()
        self.title("Moovibe — Enriquecimento de Estilo")
        self.geometry("1200x760")
        self.minsize(1000, 600)

        self.fila_eventos = queue.Queue()
        self.enricher = Enricher(self.fila_eventos)
        self._pausado = False
        self._tempo_inicio = None

        # Stats acumulados de sessões anteriores (tabela enrichment_stats)
        conn = db.get_connection()
        try:
            db.init_db()
            acumulado = db.get_enrichment_stats(conn)
            self._pendentes_base = db.count_pendentes(conn)
        finally:
            conn.close()
        self._processados_base = int(acumulado["processados"] or 0)
        self._com_busca_web_base = int(acumulado["com_busca_web"] or 0)
        self._erros_base = int(acumulado["erros"] or 0)
        self._tempo_base_acumulado = float(acumulado["tempo_total_segundos"] or 0)

        self.protocol("WM_DELETE_WINDOW", self.on_close)

        self._construir_interface()
        self._carregar_paineis_iniciais()
        self._atualizar_estado_botoes()
        self._processar_eventos()
        self._atualizar_tempo()
        self._atualizar_progresso_geral()

    # ==========================================
    # CONSTRUÇÃO DA INTERFACE
    # ==========================================
    def _construir_interface(self):
        # Frame superior: controles
        frame_controles = ctk.CTkFrame(self)
        frame_controles.pack(fill="x", padx=10, pady=(10, 5))

        self.btn_iniciar = ctk.CTkButton(
            frame_controles, text="Iniciar", command=self._iniciar, width=100
        )
        self.btn_iniciar.pack(side="left", padx=5, pady=5)

        self.btn_pausar = ctk.CTkButton(
            frame_controles, text="Pausar", command=self._pausar, width=100
        )
        self.btn_pausar.pack(side="left", padx=5, pady=5)

        self.btn_parar = ctk.CTkButton(
            frame_controles, text="Parar", command=self._parar, width=100
        )
        self.btn_parar.pack(side="left", padx=5, pady=5)

        # Frame: filme atual
        frame_filme = ctk.CTkFrame(self)
        frame_filme.pack(fill="x", padx=10, pady=5)

        ctk.CTkLabel(frame_filme, text="Filme atual:", font=("Segoe UI", 12, "bold")).pack(
            side="left", padx=5
        )
        self.lbl_filme_atual = ctk.CTkLabel(
            frame_filme, text="—", anchor="w", font=("Segoe UI", 12)
        )
        self.lbl_filme_atual.pack(side="left", padx=5, fill="x", expand=True)

        # Frame: progresso geral
        frame_geral = ctk.CTkFrame(self)
        frame_geral.pack(fill="x", padx=10, pady=5)

        ctk.CTkLabel(frame_geral, text="Progresso geral:", font=("Segoe UI", 12, "bold")).pack(
            side="left", padx=5
        )
        self.progresso_geral = ctk.CTkProgressBar(frame_geral)
        self.progresso_geral.pack(side="left", padx=5, fill="x", expand=True)
        self.progresso_geral.set(0)

        self.lbl_progresso_geral = ctk.CTkLabel(
            frame_geral, text="0/0 filmes — 0,0%", font=("Segoe UI", 11)
        )
        self.lbl_progresso_geral.pack(side="left", padx=10)

        self.lbl_tempo_restante = ctk.CTkLabel(
            frame_geral, text="", font=("Segoe UI", 11)
        )
        self.lbl_tempo_restante.pack(side="right", padx=10)

        # Frame: contadores
        frame_stats = ctk.CTkFrame(self)
        frame_stats.pack(fill="x", padx=10, pady=5)

        self.lbl_processados = ctk.CTkLabel(
            frame_stats, text="Processados: 0", font=("Segoe UI", 12)
        )
        self.lbl_processados.pack(side="left", padx=10)

        self.lbl_busca_web = ctk.CTkLabel(
            frame_stats, text="Com busca web: 0", font=("Segoe UI", 12)
        )
        self.lbl_busca_web.pack(side="left", padx=10)

        self.lbl_erros = ctk.CTkLabel(frame_stats, text="Erros: 0", font=("Segoe UI", 12))
        self.lbl_erros.pack(side="left", padx=10)

        # Frame: totais
        frame_totais = ctk.CTkFrame(self)
        frame_totais.pack(fill="x", padx=10, pady=5)

        self.lbl_pendentes = ctk.CTkLabel(
            frame_totais, text="Filmes pendentes: 0", font=("Segoe UI", 12, "bold")
        )
        self.lbl_pendentes.pack(side="left", padx=10)

        self.lbl_tempo = ctk.CTkLabel(frame_totais, text="Tempo: 00:00:00", font=("Segoe UI", 12))
        self.lbl_tempo.pack(side="right", padx=10)

        # ==========================================
        # Área inferior: painéis laterais
        # ==========================================
        frame_inferior = ctk.CTkFrame(self)
        frame_inferior.pack(fill="both", expand=True, padx=10, pady=(5, 10))

        frame_inferior.grid_columnconfigure(0, weight=1)
        frame_inferior.grid_columnconfigure(1, weight=1)
        frame_inferior.grid_rowconfigure(0, weight=1)

        # Painel esquerdo: log de eventos (enxuto)
        frame_logs = ctk.CTkFrame(frame_inferior)
        frame_logs.grid(row=0, column=0, sticky="nsew", padx=(0, 5))

        frame_logs.grid_columnconfigure(0, weight=1)
        frame_logs.grid_rowconfigure(1, weight=1)

        ctk.CTkLabel(frame_logs, text="Log de eventos:", font=("Segoe UI", 12, "bold")).grid(
            row=0, column=0, sticky="w", padx=5, pady=(5, 0)
        )
        self.txt_log = ctk.CTkTextbox(frame_logs, wrap="word", font=("Consolas", 11))
        self.txt_log.grid(row=1, column=0, sticky="nsew", padx=5, pady=2)
        self.txt_log.configure(state="disabled")

        # Painel direito: atividade detalhada
        frame_atividade = ctk.CTkFrame(frame_inferior)
        frame_atividade.grid(row=0, column=1, sticky="nsew", padx=(5, 0))

        frame_atividade.grid_columnconfigure(0, weight=1)
        frame_atividade.grid_rowconfigure(1, weight=1)

        ctk.CTkLabel(
            frame_atividade, text="Atividade detalhada:", font=("Segoe UI", 12, "bold")
        ).grid(row=0, column=0, sticky="w", padx=5, pady=(5, 0))
        self.txt_atividade = ctk.CTkTextbox(frame_atividade, wrap="word", font=("Consolas", 10))
        self.txt_atividade.grid(row=1, column=0, sticky="nsew", padx=5, pady=2)
        self.txt_atividade.configure(state="disabled")

    # ==========================================
    # CARGA INICIAL DOS PAINÉIS
    # ==========================================
    def _carregar_paineis_iniciais(self):
        """Carrega contadores acumulados e pendentes ao abrir a GUI."""
        self.lbl_processados.configure(text=f"Processados: {self._processados_base}")
        self.lbl_busca_web.configure(text=f"Com busca web: {self._com_busca_web_base}")
        self.lbl_erros.configure(text=f"Erros: {self._erros_base}")
        self.lbl_pendentes.configure(text=f"Filmes pendentes: {self._pendentes_base}")

    # ==========================================
    # AÇÕES DOS BOTÕES
    # ==========================================
    def _iniciar(self):
        if self.enricher.esta_rodando():
            return
        self._tempo_inicio = time.time()
        self.enricher.iniciar()
        self._atualizar_estado_botoes()

    def _pausar(self):
        if self._pausado:
            self.enricher.retomar()
            self._pausado = False
            self.btn_pausar.configure(text="Pausar")
        else:
            self.enricher.pausar()
            # Persiste stats ao pausar (impede perda em fechamento abrupto)
            self.enricher.persistir()
            self._pausado = True
            self.btn_pausar.configure(text="Retomar")

    def _parar(self):
        self.enricher.parar()
        self._pausado = False
        self.btn_pausar.configure(text="Pausar")
        self._atualizar_estado_botoes()

    def _atualizar_estado_botoes(self):
        rodando = self.enricher.esta_rodando()
        self.btn_iniciar.configure(state="normal" if not rodando else "disabled")
        self.btn_pausar.configure(state="normal" if rodando else "disabled")
        self.btn_parar.configure(state="normal" if rodando else "disabled")

    # ==========================================
    # PROCESSAMENTO DE EVENTOS DA FILA
    # ==========================================
    def _processar_eventos(self):
        """Consome eventos da fila e atualiza a GUI (chamado via after())."""
        try:
            while True:
                evento = self.fila_eventos.get_nowait()
                self._tratar_evento(evento)
        except queue.Empty:
            pass

        # Agenda a próxima verificação (não bloqueia a GUI)
        self.after(100, self._processar_eventos)

    def _tratar_evento(self, evento):
        tipo = evento.get("tipo")

        if tipo == "log":
            self._adicionar_log(evento.get("mensagem", ""))

        elif tipo == "atividade":
            self._adicionar_atividade(evento.get("mensagem", ""))

        elif tipo == "filme_atual":
            self.lbl_filme_atual.configure(text=evento.get("titulo", "—"))

        elif tipo == "stats":
            # Contadores acumulados (base de sessões anteriores + sessão atual)
            processados = evento.get("processados_acumulados", 0) + evento.get("processados", 0)
            busca_web = evento.get("com_busca_web_acumulados", 0) + evento.get("com_busca_web", 0)
            erros = evento.get("erros_acumulados", 0) + evento.get("erros", 0)

            # Mantém a base de tempo sincronizada com o que está persistido
            tempo_base_evento = evento.get("tempo_base_acumulado")
            if tempo_base_evento is not None:
                self._tempo_base_acumulado = float(tempo_base_evento)

            self.lbl_processados.configure(text=f"Processados: {processados}")
            self.lbl_busca_web.configure(text=f"Com busca web: {busca_web}")
            self.lbl_erros.configure(text=f"Erros: {erros}")
            self.lbl_pendentes.configure(text=f"Filmes pendentes: {evento.get('pendentes', 0)}")

            # Total de filmes com estilo = processados na sessão + acumulados + já no banco
            processados_total = (
                evento.get("processados", 0)
                + evento.get("processados_acumulados", 0)
                + evento.get("processados_no_banco", 0)
            )
            pendentes = evento.get("pendentes", 0)
            self._atualizar_progresso_geral(processados_total, pendentes)

        elif tipo == "fim":
            motivo = evento.get("motivo", "")
            if motivo == "concluido":
                self._adicionar_log("[GUI] Enriquecimento concluído com sucesso.")
            else:
                self._adicionar_log(f"[GUI] Enriquecimento encerrado: {evento.get('mensagem', motivo)}")
            self._atualizar_estado_botoes()

    # ==========================================
    # PROGRESSO GERAL
    # ==========================================
    def _atualizar_progresso_geral(self, processados: int = 0, pendentes: int = 0):
        """Atualiza a barra e o texto do progresso geral.

        A barra representa filmes processados / (processados + pendentes),
        ou seja, a fração do total de filmes que já tem estilo.
        """
        total = processados + pendentes
        if total <= 0:
            self.progresso_geral.set(0)
            self.lbl_progresso_geral.configure(text="0/0 filmes — 0,0%")
            self.lbl_tempo_restante.configure(text="")
            return

        fracao = processados / total
        self.progresso_geral.set(fracao)
        pct = fracao * 100
        # Usa vírgula como separador decimal (pt-BR)
        pct_txt = f"{pct:.1f}".replace(".", ",")
        self.lbl_progresso_geral.configure(
            text=f"{processados}/{total} filmes — {pct_txt}%"
        )

        # Estimativa de tempo restante (baseada no tempo médio por filme)
        try:
            tempo_base = self._tempo_base_acumulado
            tempo_sessao = 0
            if self._tempo_inicio and self.enricher.esta_rodando():
                tempo_sessao = time.time() - self._tempo_inicio
            if processados > 0:
                tempo_total = tempo_base + tempo_sessao
                media_por_filme = tempo_total / processados
                restante_seg = media_por_filme * pendentes
                # Não mostra se o valor for absurdo (poucos filmes processados)
                if restante_seg < 7 * 24 * 3600:
                    h = int(restante_seg // 3600)
                    m = int((restante_seg % 3600) // 60)
                    self.lbl_tempo_restante.configure(
                        text=f"Restante (estimado): {h:02d}:{m:02d}"
                    )
                else:
                    self.lbl_tempo_restante.configure(text="")
            else:
                self.lbl_tempo_restante.configure(text="")
        except Exception:
            self.lbl_tempo_restante.configure(text="")

    # ==========================================
    # PAINÉIS DE TEXTO
    # ==========================================
    def _adicionar_log(self, mensagem: str):
        """Adiciona uma linha ao log de eventos (alto nível), limitando linhas."""
        self.txt_log.configure(state="normal")
        self.txt_log.insert("end", f"{time.strftime('%H:%M:%S')}  {mensagem}\n")
        # Limita o número de linhas mantidas (evita estouro de memória)
        linhas = int(self.txt_log.index("end-1c").split(".")[0])
        if linhas > LIMITE_LINHAS_LOG:
            self.txt_log.delete("1.0", f"{linhas - LIMITE_LINHAS_LOG}.0")
        self.txt_log.see("end")
        self.txt_log.configure(state="disabled")

    def _adicionar_atividade(self, mensagem: str):
        """Adiciona uma linha ao painel de atividade detalhada, limitando linhas."""
        self.txt_atividade.configure(state="normal")
        self.txt_atividade.insert("end", f"{time.strftime('%H:%M:%S')}  {mensagem}\n")
        linhas = int(self.txt_atividade.index("end-1c").split(".")[0])
        if linhas > LIMITE_LINHAS_ATIVIDADE:
            self.txt_atividade.delete("1.0", f"{linhas - LIMITE_LINHAS_ATIVIDADE}.0")
        self.txt_atividade.see("end")
        self.txt_atividade.configure(state="disabled")

    # ==========================================
    # ATUALIZAÇÃO DE TEMPO
    # ==========================================
    def _atualizar_tempo(self):
        """Atualiza o tempo decorrido (acumulado de sessões + sessão atual)."""
        tempo_total = self._tempo_base_acumulado
        if self._tempo_inicio and self.enricher.esta_rodando():
            tempo_total += time.time() - self._tempo_inicio

        horas = int(tempo_total // 3600)
        minutos = int((tempo_total % 3600) // 60)
        segundos = int(tempo_total % 60)
        self.lbl_tempo.configure(text=f"Tempo: {horas:02d}:{minutos:02d}:{segundos:02d}")
        self.after(1000, self._atualizar_tempo)

    # ==========================================
    # FECHAMENTO
    # ==========================================
    def on_close(self):
        """Ao fechar a janela, sinaliza parada, persiste stats e encerra."""
        self.enricher.persistir()
        self.enricher.parar()
        self.destroy()
