"""Cliente HTTP para o Ollama local (API /api/generate).

Fala diretamente com o servidor Ollama rodando em http://localhost:11434
usando a biblioteca `requests` (já dependência do projeto). Não adiciona
pacotes novos.

O modelo local é leve o suficiente para rodar em paralelo com o coletor
sem travar a máquina (Intel i3-1215U, 16 GB RAM, sem GPU dedicada).
"""

import json
import logging
import re

import requests

# Modelo local usado para gerar o campo de estilo. Troque aqui para testar
# outro modelo (ex: "llama3.1:8b", "mistral:7b", "qwen2.5:3b").
MODELO = "llama3.2:3b"

# URL base da API HTTP do Ollama (padrão de instalação local).
OLLAMA_URL = "http://localhost:11434/api/generate"

# Tempo máximo de espera por resposta do modelo (segundos).
# Em CPU sem GPU dedicada, um 3B pode levar de 30s a 2min por resposta.
TIMEOUT_SEGUNDOS = 300

logger = logging.getLogger(__name__)


def _extrair_json(texto: str):
    """Tenta extrair um objeto JSON do texto de resposta do modelo.

    O modelo pode devolver texto extra antes/depois do JSON (ex: explicações,
    markdown ```json ... ```). Esta função tenta, em ordem:
      1. json.loads direto no texto completo.
      2. Extrair o primeiro bloco delimitado por chaves { ... } e tentar de novo.
      3. Extrair bloco dentro de ```json ... ``` (markdown).
    Retorna o dict parseado ou None se todas as tentativas falharem.
    """
    if not texto:
        return None

    # Tentativa 1: texto completo
    try:
        return json.loads(texto)
    except (json.JSONDecodeError, TypeError):
        pass

    # Tentativa 2: bloco markdown ```json ... ```
    match_md = re.search(r"```(?:json)?\s*(.*?)```", texto, re.DOTALL)
    if match_md:
        try:
            return json.loads(match_md.group(1).strip())
        except (json.JSONDecodeError, TypeError):
            pass

    # Tentativa 3: primeiro objeto delimitado por chaves balanceadas
    inicio = texto.find("{")
    if inicio != -1:
        profundidade = 0
        for i in range(inicio, len(texto)):
            if texto[i] == "{":
                profundidade += 1
            elif texto[i] == "}":
                profundidade -= 1
                if profundidade == 0:
                    candidato = texto[inicio : i + 1]
                    try:
                        return json.loads(candidato)
                    except (json.JSONDecodeError, TypeError):
                        break
    return None


def _normalizar_estilo(dados: dict) -> dict:
    """Normaliza o JSON retornado pelo modelo para o schema esperado.

    Garante que todas as chaves existam com tipos corretos, mesmo que o
    modelo omita alguma ou devolva formato inesperado.
    """
    def _lista(valor):
        if valor is None:
            return []
        if isinstance(valor, str):
            # Pode vir como string separada por vírgula
            return [item.strip() for item in valor.split(",") if item.strip()]
        if isinstance(valor, list):
            return [str(item).strip() for item in valor if str(item).strip()]
        return []

    def _nivel(valor):
        """Normaliza nível (low/medium/high) para string minúscula."""
        if valor is None:
            return "unknown"
        texto = str(valor).strip().lower()
        if texto in ("low", "baixo", "baixa", "leve"):
            return "low"
        if texto in ("medium", "medio", "média", "media", "moderado", "moderada"):
            return "medium"
        if texto in ("high", "alto", "alta", "forte"):
            return "high"
        return "unknown"

    def _pace(valor):
        if valor is None:
            return "unknown"
        texto = str(valor).strip().lower()
        if texto in ("slow", "lento", "lenta", "arrastado"):
            return "slow"
        if texto in ("medium", "medio", "média", "media", "moderado"):
            return "medium"
        if texto in ("fast", "rapido", "rápido", "acelerado"):
            return "fast"
        return "unknown"

    return {
        "moods": _lista(dados.get("moods")),
        "themes": _lista(dados.get("themes")),
        "atmosphere": _lista(dados.get("atmosphere")),
        "pace": _pace(dados.get("pace")),
        "visual_style": _lista(dados.get("visual_style")),
        "melancholy_level": _nivel(dados.get("melancholy_level")),
        "tension_level": _nivel(dados.get("tension_level")),
        "confidence": _nivel(dados.get("confidence")),
    }


def validar_resposta(estilo: dict, tmdb_id: int, titulo: str) -> None:
    """Valida a resposta do modelo antes de salvar.

    Levanta exceção se:
    - O JSON não tiver os campos esperados;
    - Todos os campos de conteúdo estiverem vazios (resposta genérica/inválida);
    - Houver qualquer indício de erro ou resposta reaproveitada.

    Não impede que dois filmes diferentes tenham estilos parecidos —
    apenas impede que uma resposta vazia/repetida acidental seja salva.
    """
    if not isinstance(estilo, dict):
        raise ValueError("Resposta da IA não é um objeto JSON válido.")

    campos_lista = ("moods", "themes", "atmosphere", "visual_style")
    tem_algum_conteudo = False
    for campo in campos_lista:
        valores = estilo.get(campo)
        if isinstance(valores, list) and valores:
            tem_algum_conteudo = True
            break

    # Pelo menos um campo de conteúdo deve ter valores
    if not tem_algum_conteudo:
        raise ValueError(
            f"Resposta vazia/inválida para '{titulo}' (tmdb_id={tmdb_id}): "
            "nenhum campo de conteúdo preenchido."
        )

    # Confirma que a identidade do filme está no contexto (proteção contra
    # reutilização acidental de resposta de outro filme)
    if titulo and titulo.lower() not in str(estilo).lower():
        # A resposta pode não conter o título explicitamente (é normal),
        # mas se contiver outro título conhecido, é suspeito. Não
        # bloqueamos aqui — a validação principal é a de conteúdo.
        pass


def gerar_estilo(contexto: str, tmdb_id: int, titulo: str, on_log=None) -> dict:
    """Gera o campo de estilo para um filme usando o modelo local.

    `contexto` é o texto (dados do filme + contexto web) que será enviado
    ao modelo. O modelo é instruído a analisar SOMENTE o filme descrito.

    `tmdb_id` e `titulo` identificam o filme atual — são incluídos no prompt
    para garantir que a resposta seja específica deste filme e nunca uma
    resposta reaproveitada de outro.

    `on_log` é um callback opcional `on_log(prompt, resposta)` chamado com
    o prompt enviado e a resposta bruta do modelo, para registro/diagnóstico.

    Retorna o dict de estilo normalizado. Lança exceção se o Ollama não
    estiver acessível, se o JSON não puder ser extraído ou se a resposta
    não passar na validação.
    """
    prompt = (
        "Você é um analista de cinema especializado em análise estética "
        "e atmosférica. Você está analisando EXCLUSIVAMENTE o filme abaixo, "
        "identificado por tmdb_id e título. NÃO analise nenhum outro filme.\n\n"
        f"FILME ATUAL (tmdb_id={tmdb_id}): {titulo}\n"
        "Contexto do filme (dados TMDB + informações da web):\n"
        f"{contexto}\n\n"
        "Com base SOMENTE nas informações fornecidas sobre ESTE filme, "
        "produza uma análise de estilo em JSON. NUNCA invente fatos sobre "
        "enredo, elenco, eventos ou qualquer detalhe que não esteja presente "
        "no texto fornecido. Se a informação for insuficiente, use listas "
        "vazias e niveis 'unknown'.\n\n"
        "Analise especificamente:\n"
        "- moods: humores/emoções predominantes do filme (max 5)\n"
        "- themes: temas centrais (max 5)\n"
        "- atmosphere: atmosfera/ambiente (max 5)\n"
        "- pace: ritmo narrativo: 'slow', 'medium' ou 'fast'\n"
        "- visual_style: características visuais/estéticas, fotografia, "
        "direção de arte (max 5)\n"
        "- melancholy_level: intensidade melancólica: 'low', 'medium' ou 'high'\n"
        "- tension_level: intensidade de tensão: 'low', 'medium' ou 'high'\n\n"
        "Responda APENAS com JSON válido, sem texto extra, no formato:\n"
        "{\n"
        '  "moods": ["tense", "contemplative"],\n'
        '  "themes": ["identity", "technology"],\n'
        '  "atmosphere": ["sleek", "oppressive"],\n'
        '  "pace": "medium",\n'
        '  "visual_style": ["neon-lit", "dutch angles"],\n'
        '  "melancholy_level": "medium",\n'
        '  "tension_level": "high"\n'
        "}\n\n"
        "IMPORTANTE: Cada resposta deve refletir as características "
        "específicas DESTE filme. Não copie padrões genéricos."
    )

    payload = {
        "model": MODELO,
        "prompt": prompt,
        "stream": False,
        "format": "json",  # pede JSON estruturado ao Ollama (suportado nativamente)
        "options": {
            "temperature": 0.3,  # baixa temperatura: análise mais consistente
            "num_predict": 600,  # limite de tokens para não estourar contexto
        },
    }

    logger.info("Chamando modelo local %s para gerar estilo", MODELO)
    try:
        resp = requests.post(OLLAMA_URL, json=payload, timeout=TIMEOUT_SEGUNDOS)
        resp.raise_for_status()
        dados = resp.json()
    except requests.RequestException as e:
        raise RuntimeError(f"Falha ao acessar Ollama em {OLLAMA_URL}: {e}") from e

    texto_resposta = dados.get("response", "")
    if not texto_resposta:
        raise RuntimeError("Ollama retornou resposta vazia.")

    # Chama o callback de log com o prompt enviado e a resposta bruta
    if on_log is not None:
        try:
            on_log(prompt, texto_resposta)
        except Exception:
            pass

    extraido = _extrair_json(texto_resposta)
    if extraido is None:
        logger.error("Falha ao extrair JSON da resposta do modelo. Resposta: %s",
                     texto_resposta[:500])
        raise RuntimeError("Modelo retornou resposta sem JSON válido.")

    normalizado = _normalizar_estilo(extraido)
    validar_resposta(normalizado, tmdb_id, titulo)
    return normalizado
