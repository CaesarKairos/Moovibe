"""Interface gráfica CustomTkinter para o coletor de filmes do Moovibe."""

import queue
import time

import customtkinter as ctk

from .collector import Coletor

# Tema escuro consistente com a identidade do Moovibe
ctk.set_appearance_mode("dark")
ctk.set_default_color_theme("blue")


class ColetorGUI(ctk.CTk):
    """Janela principal com controles de Iniciar/Pausar/Parar e feedback em tempo real."""

    def __init__(self):
        super().__init__()
        self.title("Moovibe — Coletor de Biblioteca")
        self.geometry("720x560")
        self.minsize(640, 480)

        self.fila_eventos = queue.Queue()
        self.coletor = Coletor(self.fila_eventos)
        self._pausado = False
        self._tempo_inicio = None

        self.protocol("WM_DELETE_WINDOW", self.on_close)

        self._construir_interface()
        self._atualizar_estado_botoes()
        self._processar_eventos()
        self._atualizar_tempo()

    # ==========================================
    # CONSTRUÇÃO DA INTERFACE
    # ==========================================
    def _construir_interface(self):
        # Frame superior: controles
        frame_controles = ctk.CTkFrame(self)
        frame_controles.pack(fill="x", padx=10, pady=(10, 5))

        self.btn_iniciar = ctk.CTkButton(
            frame_controles, text="▶ Iniciar", command=self._iniciar, width=100
        )
        self.btn_iniciar.pack(side="left", padx=5, pady=5)

        self.btn_pausar = ctk.CTkButton(
            frame_controles, text="⏸ Pausar", command=self._pausar, width=100
        )
        self.btn_pausar.pack(side="left", padx=5, pady=5)

        self.btn_parar = ctk.CTkButton(
            frame_controles, text="⏹ Parar", command=self._parar, width=100
        )
        self.btn_parar.pack(side="left", padx=5, pady=5)

        # Frame: consulta atual
        frame_consulta = ctk.CTkFrame(self)
        frame_consulta.pack(fill="x", padx=10, pady=5)

        ctk.CTkLabel(frame_consulta, text="Consulta atual:", font=("Segoe UI", 12, "bold")).pack(
            side="left", padx=5
        )
        self.lbl_consulta = ctk.CTkLabel(
            frame_consulta, text="—", anchor="w", font=("Segoe UI", 12)
        )
        self.lbl_consulta.pack(side="left", padx=5, fill="x", expand=True)

        # Barra de progresso
        self.progresso = ctk.CTkProgressBar(self)
        self.progresso.pack(fill="x", padx=10, pady=5)
        self.progresso.set(0)

        # Frame: contadores
        frame_stats = ctk.CTkFrame(self)
        frame_stats.pack(fill="x", padx=10, pady=5)

        self.lbl_novos = ctk.CTkLabel(frame_stats, text="Novos: 0", font=("Segoe UI", 12))
        self.lbl_novos.pack(side="left", padx=10)

        self.lbl_atualizados = ctk.CTkLabel(frame_stats, text="Atualizados: 0", font=("Segoe UI", 12))
        self.lbl_atualizados.pack(side="left", padx=10)

        self.lbl_duplicados = ctk.CTkLabel(frame_stats, text="Duplicados: 0", font=("Segoe UI", 12))
        self.lbl_duplicados.pack(side="left", padx=10)

        self.lbl_erros = ctk.CTkLabel(frame_stats, text="Erros: 0", font=("Segoe UI", 12))
        self.lbl_erros.pack(side="left", padx=10)

        # Frame: totais
        frame_totais = ctk.CTkFrame(self)
        frame_totais.pack(fill="x", padx=10, pady=5)

        self.lbl_total_filmes = ctk.CTkLabel(
            frame_totais, text="Filmes no banco: 0", font=("Segoe UI", 12, "bold")
        )
        self.lbl_total_filmes.pack(side="left", padx=10)

        self.lbl_tempo = ctk.CTkLabel(frame_totais, text="Tempo: 00:00:00", font=("Segoe UI", 12))
        self.lbl_tempo.pack(side="right", padx=10)

        self.lbl_consultas = ctk.CTkLabel(
            frame_totais, text="Consultas: 0/0", font=("Segoe UI", 12)
        )
        self.lbl_consultas.pack(side="right", padx=10)

        # Área de log rolável
        frame_log = ctk.CTkFrame(self)
        frame_log.pack(fill="both", expand=True, padx=10, pady=(5, 10))

        ctk.CTkLabel(frame_log, text="Log de eventos:", font=("Segoe UI", 12, "bold")).pack(
            anchor="w", padx=5, pady=(5, 0)
        )

        self.txt_log = ctk.CTkTextbox(frame_log, wrap="word", font=("Consolas", 11))
        self.txt_log.pack(fill="both", expand=True, padx=5, pady=5)
        self.txt_log.configure(state="disabled")

    # ==========================================
    # AÇÕES DOS BOTÕES
    # ==========================================
    def _iniciar(self):
        if self.coletor.esta_rodando():
            return
        self._tempo_inicio = time.time()
        self.coletor.iniciar()
        self._atualizar_estado_botoes()

    def _pausar(self):
        if self._pausado:
            self.coletor.retomar()
            self._pausado = False
            self.btn_pausar.configure(text="⏸ Pausar")
        else:
            self.coletor.pausar()
            self._pausado = True
            self.btn_pausar.configure(text="▶ Retomar")

    def _parar(self):
        self.coletor.parar()
        self._pausado = False
        self.btn_pausar.configure(text="⏸ Pausar")
        self._atualizar_estado_botoes()

    def _atualizar_estado_botoes(self):
        rodando = self.coletor.esta_rodando()
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

        elif tipo == "progresso":
            consulta = evento.get("consulta", "—")
            pagina = evento.get("pagina", 0)
            total = evento.get("total_paginas", 0)
            self.lbl_consulta.configure(text=f"{consulta} — página {pagina}/{total}")
            if total > 0:
                self.progresso.set(pagina / total)

        elif tipo == "stats":
            self.lbl_novos.configure(text=f"Novos: {evento.get('novos', 0)}")
            self.lbl_atualizados.configure(text=f"Atualizados: {evento.get('atualizados', 0)}")
            self.lbl_duplicados.configure(text=f"Duplicados: {evento.get('duplicados', 0)}")
            self.lbl_erros.configure(text=f"Erros: {evento.get('erros', 0)}")
            self.lbl_total_filmes.configure(text=f"Filmes no banco: {evento.get('total_filmes', 0)}")
            self.lbl_consultas.configure(
                text=f"Consultas: {evento.get('consultas_concluidas', 0)}/"
                     f"{evento.get('total_consultas', 0)}"
            )

        elif tipo == "fim":
            motivo = evento.get("motivo", "")
            if motivo == "concluido":
                self._adicionar_log("[GUI] Coleta concluída com sucesso.")
            else:
                self._adicionar_log(f"[GUI] Coleta encerrada: {evento.get('mensagem', motivo)}")
            self._atualizar_estado_botoes()

    def _adicionar_log(self, mensagem: str):
        """Adiciona uma linha ao log rolável."""
        self.txt_log.configure(state="normal")
        self.txt_log.insert("end", f"{time.strftime('%H:%M:%S')}  {mensagem}\n")
        self.txt_log.see("end")
        self.txt_log.configure(state="disabled")

    # ==========================================
    # ATUALIZAÇÃO DE TEMPO
    # ==========================================
    def _atualizar_tempo(self):
        if self._tempo_inicio and self.coletor.esta_rodando():
            decorrido = int(time.time() - self._tempo_inicio)
            horas = decorrido // 3600
            minutos = (decorrido % 3600) // 60
            segundos = decorrido % 60
            self.lbl_tempo.configure(text=f"Tempo: {horas:02d}:{minutos:02d}:{segundos:02d}")
        self.after(1000, self._atualizar_tempo)

    # ==========================================
    # FECHAMENTO
    # ==========================================
    def on_close(self):
        """Ao fechar a janela, sinaliza parada e encerra."""
        self.coletor.parar()
        self.destroy()