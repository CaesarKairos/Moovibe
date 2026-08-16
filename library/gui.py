"""Interface gráfica CustomTkinter para o coletor de filmes do Moovibe."""

import queue
import time
from tkinter import ttk

import customtkinter as ctk

from . import db
from .collector import Coletor
from .queries import PAISES

# Tema escuro consistente com a identidade do Moovibe
ctk.set_appearance_mode("dark")
ctk.set_default_color_theme("blue")

# Limite de linhas mantidas em cada painel de texto (evita estouro de memória)
LIMITE_LINHAS_LOG = 800
LIMITE_LINHAS_ATIVIDADE = 800


class ColetorGUI(ctk.CTk):
    """Janela principal com controles de Iniciar/Pausar/Parar e feedback em tempo real."""

    def __init__(self):
        super().__init__()
        self.title("Moovibe — Coletor de Biblioteca")
        self.geometry("1280x800")
        self.minsize(1000, 640)

        self.fila_eventos = queue.Queue()
        self.coletor = Coletor(self.fila_eventos)
        self._pausado = False
        self._tempo_inicio = None

        # Stats acumulados de sessões anteriores (tabela collector_stats)
        conn = db.get_connection()
        try:
            db.init_db()
            acumulado = db.get_collector_stats(conn)
        finally:
            conn.close()
        self._novos_base = int(acumulado["novos"] or 0)
        self._atualizados_base = int(acumulado["atualizados"] or 0)
        self._duplicados_base = int(acumulado["duplicados"] or 0)
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

        # Barra de progresso da página atual
        ctk.CTkLabel(frame_consulta, text="Página:", font=("Segoe UI", 11)).pack(side="left", padx=5)
        self.progresso = ctk.CTkProgressBar(frame_consulta, width=200)
        self.progresso.pack(side="left", padx=5)
        self.progresso.set(0)

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
            frame_geral, text="0/0 consultas — 0,0%", font=("Segoe UI", 11)
        )
        self.lbl_progresso_geral.pack(side="left", padx=10)

        self.lbl_tempo_restante = ctk.CTkLabel(
            frame_geral, text="", font=("Segoe UI", 11)
        )
        self.lbl_tempo_restante.pack(side="right", padx=10)

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

        # ==========================================
        # Área inferior: paineis laterais
        # ==========================================
        frame_inferior = ctk.CTkFrame(self)
        frame_inferior.pack(fill="both", expand=True, padx=10, pady=(5, 10))

        frame_inferior.grid_columnconfigure(0, weight=1)
        frame_inferior.grid_columnconfigure(1, weight=1)
        frame_inferior.grid_rowconfigure(0, weight=1)

        # Painel esquerdo: logs + atividade detalhada
        frame_logs = ctk.CTkFrame(frame_inferior)
        frame_logs.grid(row=0, column=0, sticky="nsew", padx=(0, 5))

        frame_logs.grid_columnconfigure(0, weight=1)
        frame_logs.grid_rowconfigure(1, weight=1)
        frame_logs.grid_rowconfigure(3, weight=1)

        ctk.CTkLabel(frame_logs, text="Log de eventos:", font=("Segoe UI", 12, "bold")).grid(
            row=0, column=0, sticky="w", padx=5, pady=(5, 0)
        )
        self.txt_log = ctk.CTkTextbox(frame_logs, wrap="word", font=("Consolas", 11))
        self.txt_log.grid(row=1, column=0, sticky="nsew", padx=5, pady=2)
        self.txt_log.configure(state="disabled")

        ctk.CTkLabel(frame_logs, text="Atividade detalhada:", font=("Segoe UI", 12, "bold")).grid(
            row=2, column=0, sticky="w", padx=5, pady=(5, 0)
        )
        self.txt_atividade = ctk.CTkTextbox(frame_logs, wrap="word", font=("Consolas", 10))
        self.txt_atividade.grid(row=3, column=0, sticky="nsew", padx=5, pady=2)
        self.txt_atividade.configure(state="disabled")

        # Painel direito: países e categorias
        frame_paises = ctk.CTkFrame(frame_inferior)
        frame_paises.grid(row=0, column=1, sticky="nsew", padx=(5, 0))

        frame_paises.grid_columnconfigure(0, weight=1)
        frame_paises.grid_rowconfigure(1, weight=1)

        ctk.CTkLabel(
            frame_paises, text="Países e categorias:", font=("Segoe UI", 12, "bold")
        ).grid(row=0, column=0, sticky="w", padx=5, pady=(5, 0))

        # Treeview com barra de rolagem (integração com CustomTkinter via tk)
        frame_tree = ctk.CTkFrame(frame_paises)
        frame_tree.grid(row=1, column=0, sticky="nsew", padx=5, pady=5)

        frame_tree.grid_columnconfigure(0, weight=1)
        frame_tree.grid_rowconfigure(0, weight=1)

        self.tree_paises = ttk.Treeview(
            frame_tree,
            columns=("status", "progresso"),
            show="tree headings",
        )
        self.tree_paises.heading("#0", text="País / Categoria")
        self.tree_paises.heading("status", text="Status")
        self.tree_paises.heading("progresso", text="Concluídas/Total")
        self.tree_paises.column("#0", width=320, minwidth=200)
        self.tree_paises.column("status", width=110, minwidth=80)
        self.tree_paises.column("progresso", width=140, minwidth=100)

        scrollbar_tree = ttk.Scrollbar(frame_tree, orient="vertical", command=self.tree_paises.yview)
        self.tree_paises.configure(yscrollcommand=scrollbar_tree.set)

        self.tree_paises.grid(row=0, column=0, sticky="nsew")
        scrollbar_tree.grid(row=0, column=1, sticky="ns")

        # Linha de detalhes dos filmes da categoria selecionada
        self.lbl_filmes_detalhe = ctk.CTkLabel(
            frame_paises,
            text="Clique em uma categoria concluída para ver os filmes coletados.",
            anchor="w",
            font=("Segoe UI", 10),
            wraplength=550,
        )
        self.lbl_filmes_detalhe.grid(row=2, column=0, sticky="ew", padx=5, pady=2)

        self.tree_paises.bind("<<TreeviewOpen>>", self._ao_expandir_categoria)
        self.tree_paises.bind("<Double-1>", self._ao_clicar_categoria)

    # ==========================================
    # CARGA INICIAL DOS PAINÉIS
    # ==========================================
    def _carregar_paineis_iniciais(self):
        """Carrega contadores acumulados e o painel de países ao abrir a GUI."""
        self.lbl_novos.configure(text=f"Novos: {self._novos_base}")
        self.lbl_atualizados.configure(text=f"Atualizados: {self._atualizados_base}")
        self.lbl_duplicados.configure(text=f"Duplicados: {self._duplicados_base}")
        self.lbl_erros.configure(text=f"Erros: {self._erros_base}")

        conn = db.get_connection()
        try:
            total_filmes = db.count_movies(conn)
            self.lbl_total_filmes.configure(text=f"Filmes no banco: {total_filmes}")

            # Consultas concluídas até o momento (sessões anteriores)
            consultas = conn.execute(
                "SELECT COUNT(*) AS c FROM collection_progress WHERE status = 'done'"
            ).fetchone()["c"]
            total = conn.execute(
                "SELECT COUNT(*) AS c FROM collection_progress"
            ).fetchone()["c"]
            self.lbl_consultas.configure(text=f"Consultas: {consultas}/{total}")

            self._carregar_paises(conn)
        finally:
            conn.close()

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
            self.btn_pausar.configure(text="Pausar")
        else:
            self.coletor.pausar()
            # Persiste stats ao pausar (impede perda em fechamento abrupto)
            self.coletor.persistir()
            self._pausado = True
            self.btn_pausar.configure(text="Retomar")

    def _parar(self):
        self.coletor.parar()
        self._pausado = False
        self.btn_pausar.configure(text="Pausar")
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

        elif tipo == "atividade":
            self._adicionar_atividade(evento.get("mensagem", ""))

        elif tipo == "progresso":
            consulta = evento.get("consulta", "—")
            pagina = evento.get("pagina", 0)
            total = evento.get("total_paginas", 0)
            self.lbl_consulta.configure(text=f"{consulta} — página {pagina}/{total}")
            if total > 0:
                self.progresso.set(pagina / total)

        elif tipo == "stats":
            # Contadores acumulados (base de sessões anteriores + sessão atual).
            # Os valores *_acumulados vêm do collector, que recarrega do banco
            # a cada iniciar() — evita dupla contagem ao reiniciar na mesma janela.
            novos = evento.get("novos_acumulados", 0) + evento.get("novos", 0)
            atualizados = evento.get("atualizados_acumulados", 0) + evento.get("atualizados", 0)
            duplicados = evento.get("duplicados_acumulados", 0) + evento.get("duplicados", 0)
            erros = evento.get("erros_acumulados", 0) + evento.get("erros", 0)

            # Mantém a base de tempo sincronizada com o que está persistido
            tempo_base_evento = evento.get("tempo_base_acumulado")
            if tempo_base_evento is not None:
                self._tempo_base_acumulado = float(tempo_base_evento)

            self.lbl_novos.configure(text=f"Novos: {novos}")
            self.lbl_atualizados.configure(text=f"Atualizados: {atualizados}")
            self.lbl_duplicados.configure(text=f"Duplicados: {duplicados}")
            self.lbl_erros.configure(text=f"Erros: {erros}")
            self.lbl_total_filmes.configure(text=f"Filmes no banco: {evento.get('total_filmes', 0)}")

            concluidas = evento.get("consultas_concluidas", 0)
            total = evento.get("total_consultas", 0)
            self.lbl_consultas.configure(text=f"Consultas: {concluidas}/{total}")
            self._atualizar_progresso_geral(concluidas, total)

        elif tipo == "paises_atualizar":
            self._atualizar_paineis_apos_consulta()

        elif tipo == "fim":
            motivo = evento.get("motivo", "")
            if motivo == "concluido":
                self._adicionar_log("[GUI] Coleta concluída com sucesso.")
            else:
                self._adicionar_log(f"[GUI] Coleta encerrada: {evento.get('mensagem', motivo)}")
            self._atualizar_estado_botoes()

    # ==========================================
    # PAINEL DE PAÍSES E CATEGORIAS
    # ==========================================
    def _carregar_paises(self, conn):
        """Popula o Treeview com todos os países e suas categorias (status do checkpoint)."""
        # Reconstrução simples: limpa e recarrega
        for item in self.tree_paises.get_children():
            self.tree_paises.delete(item)

        # Total de categorias por país
        consultas = db.get_all_queries(conn)
        por_pais = {}
        for reg in consultas:
            label = reg["label"] or reg["query_id"]
            query_id = reg["query_id"]
            status = reg["status"] or "pending"

            codigo_pais = None
            for codigo, nome in PAISES.items():
                if label.startswith(nome):
                    codigo_pais = codigo
                    break

            if codigo_pais is None:
                continue

            if codigo_pais not in por_pais:
                por_pais[codigo_pais] = {
                    "nome": PAISES[codigo_pais],
                    "categorias": [],
                    "concluidas": 0,
                    "total": 0,
                }
            por_pais[codigo_pais]["categorias"].append((query_id, label, status))
            por_pais[codigo_pais]["total"] += 1
            if status == "done":
                por_pais[codigo_pais]["concluidas"] += 1

        for codigo, dados in por_pais.items():
            concluidas = dados["concluidas"]
            total = dados["total"]
            if concluidas == total:
                status_pais = "Concluído"
            elif concluidas > 0 or any(s == "running" for _, _, s in dados["categorias"]):
                status_pais = "Em andamento"
            else:
                status_pais = "Pendente"

            id_pais = self.tree_paises.insert(
                "",
                "end",
                text=f"{dados['nome']} ({codigo})",
                values=(status_pais, f"{concluidas}/{total}"),
                open=False,
            )

            for query_id, label, status in sorted(
                dados["categorias"], key=lambda x: x[1]
            ):
                status_cat = {
                    "done": "Concluída",
                    "running": "Em andamento",
                    "error": "Erro",
                    "pending": "Pendente",
                }.get(status, status)
                self.tree_paises.insert(
                    id_pais,
                    "end",
                    text=label,
                    values=(status_cat, ""),
                )

    def _atualizar_paineis_apos_consulta(self):
        """Atualiza o painel de países de forma leve (não recarrega tudo)."""
        # Recarrega o Treeview apenas (fontes já são o checkpoint no banco)
        conn = db.get_connection()
        try:
            self._carregar_paises(conn)
        finally:
            conn.close()

    def _ao_expandir_categoria(self, _event):
        """Ao expandir, mostra os filmes coletados para a categoria (sob demanda)."""
        self._mostrar_filmes_categoria()

    def _ao_clicar_categoria(self, _event):
        """Ao clicar em uma categoria, mostra os filmes coletados (sob demanda)."""
        self._mostrar_filmes_categoria()

    def _mostrar_filmes_categoria(self):
        """Busca no banco, sob demanda, os filmes coletados pela categoria selecionada."""
        selecionado = self.tree_paises.selection()
        if not selecionado:
            return
        item = self.tree_paises.item(selecionado[0])
        label = item.get("text", "")
        if not label:
            return

        # Só busca se for uma categoria folha (sem filhos) e concluída
        filhos = self.tree_paises.get_children(selecionado[0])
        if filhos:
            return

        valores = item.get("values") or []
        status = valores[0] if valores else ""
        if status != "Concluída":
            self.lbl_filmes_detalhe.configure(
                text=f"Categoria '{label}': filmes disponíveis apenas para categorias concluídas."
            )
            return

        conn = db.get_connection()
        try:
            filmes = db.get_movies_by_source(conn, label, limite=100)
        finally:
            conn.close()

        if not filmes:
            self.lbl_filmes_detalhe.configure(
                text=f"Categoria '{label}': nenhum filme encontrado."
            )
            return

        total_exibidos = len(filmes)
        exibidos = filmes[:25]
        nomes = ", ".join(
            f"{f['title']} ({f['release_year']})" if f["release_year"] else f["title"]
            for f in exibidos
        )
        if total_exibidos > len(exibidos):
            nomes += f" ... e mais {total_exibidos - len(exibidos)} filmes."
        self.lbl_filmes_detalhe.configure(
            text=f"Categoria '{label}': {total_exibidos} filmes coletados (exibindo até 25). {nomes}"
        )

    # ==========================================
    # PROGRESSO GERAL
    # ==========================================
    def _atualizar_progresso_geral(self, concluidas: int = 0, total: int = 0):
        """Atualiza a barra e o texto do progresso geral; calcula tempo restante."""
        if total <= 0:
            self.progresso_geral.set(0)
            self.lbl_progresso_geral.configure(text="0/0 consultas — 0,0%")
            self.lbl_tempo_restante.configure(text="")
            return

        fracao = concluidas / total
        self.progresso_geral.set(fracao)
        pct = fracao * 100
        # Usa vírgula como separador decimal (pt-BR)
        pct_txt = f"{pct:.1f}".replace(".", ",")
        self.lbl_progresso_geral.configure(
            text=f"{concluidas}/{total} consultas — {pct_txt}%"
        )

        # Estimativa de tempo restante (opcional, baseada no tempo médio por consulta)
        try:
            tempo_base = self._tempo_base_acumulado
            tempo_sessao = 0
            if self._tempo_inicio and self.coletor.esta_rodando():
                tempo_sessao = time.time() - self._tempo_inicio
            if concluidas > 0:
                tempo_total = tempo_base + tempo_sessao
                media_por_consulta = tempo_total / concluidas
                restantes = total - concluidas
                restante_seg = media_por_consulta * restantes
                # Não mostra se o valor for absurdo (poucas consultas concluídas)
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
        if self._tempo_inicio and self.coletor.esta_rodando():
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
        self.coletor.persistir()
        self.coletor.parar()
        self.destroy()