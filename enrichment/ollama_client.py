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


def gerar_estilo(contexto: str, on_log=None) -> dict:
    """Gera o campo de estilo para um filme usando o modelo local.

    `contexto` é o texto (dados do filme + eventual contexto web) que será
    enviado ao modelo. O modelo é instruído a usar SOMENTE as informações
    fornecidas — nunca inventar fatos sobre enredo, elenco ou eventos.

    `on_log` é um callback opcional `on_log(prompt, resposta)` chamado com
    o prompt enviado e a resposta bruta do modelo, para registro/diagnóstico.

    Retorna o dict de estilo normalizado. Lança exceção se o Ollama não
    estiver acessível ou se o JSON não puder ser extraído de jeito nenhum.
    """
    prompt = (
        "Você é um analista de cinema. Com base SOMENTE nas informações "
        "fornecidas abaixo sobre um filme, produza uma análise de estilo em "
        "JSON. NUNCA invente fatos sobre enredo, elenco, eventos ou qualquer "
        "detalhe que não esteja presente no texto fornecido. Se a informação "
        "for insuficiente, use listas vazias e niveis 'unknown'.\n\n"
        "Responda APENAS com JSON válido, sem texto extra, no formato:\n"
        "{\n"
        '  "moods": ["melancholic", "tense"],\n'
        '  "themes": ["memory", "loss"],\n'
        '  "atmosphere": ["quiet", "claustrophobic"],\n'
        '  "pace": "slow",\n'
        '  "visual_style": ["muted colors", "handheld camera"],\n'
        '  "melancholy_level": "high",\n'
        '  "tension_level": "medium"\n'
        "}\n\n"
        "Campos:\n"
        "- moods: lista curta de humores/emoções predominantes (max 5)\n"
        "- themes: lista curta de temas centrais (max 5)\n"
        "- atmosphere: lista curta de palavras de atmosfera/ambiente (max 5)\n"
        "- pace: ritmo narrativo: 'slow', 'medium' ou 'fast'\n"
        "- visual_style: lista curta de características visuais/estéticas (max 5)\n"
        "- melancholy_level: 'low', 'medium' ou 'high'\n"
        "- tension_level: 'low', 'medium' ou 'high'\n\n"
        "Informações do filme:\n"
        f"{contexto}"
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

    return _normalizar_estilo(extraido)
