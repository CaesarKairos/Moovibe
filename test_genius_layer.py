#!/usr/bin/env python3
"""Teste isolado da camada Genius (descrição via /songs/{id})."""
import json
import os
import re
import sys
import requests
from dotenv import load_dotenv

load_dotenv()

GENIUS_API_KEY = os.getenv("GENIUS_API_KEY")
URL_GENIUS_BASE = "https://api.genius.com"
URL_GENIUS_SEARCH = URL_GENIUS_BASE + "/search"
URL_GENIUS_SONGS = URL_GENIUS_BASE + "/songs"

MOOVIBE_USER_AGENT = "Moovibe/1.0 (mailto:cesarbatistasantos08@gmail.com)"
GENIUS_MUSICA = "Bohemian Rhapsody"
GENIUS_ARTISTA = "Queen"


def extrair_texto_genius_dom(no):
    """Extrai texto puro da árvore DOM do Genius."""
    if no is None:
        return ""
    if isinstance(no, str):
        return no
    if isinstance(no, dict):
        children = no.get("children")
        if children:
            return "".join(extrair_texto_genius_dom(child) for child in children)
        if "text" in no:
            return str(no.get("text", ""))
        return ""
    if isinstance(no, list):
        return "".join(extrair_texto_genius_dom(item) for item in no)
    return ""


def test_genius_layer():
    if not GENIUS_API_KEY:
        print("ERRO: GENIUS_API_KEY não encontrada no .env")
        return 1

    print(f"GENIUS_API_KEY configurada: {'SIM' if GENIUS_API_KEY else 'NÃO'}")
    print(f"Tamanho da chave: {len(GENIUS_API_KEY)} chars")
    print(f"Procurando: {GENIUS_MUSICA} - {GENIUS_ARTISTA}\n")

    try:
        headers = {"Authorization": f"Bearer {GENIUS_API_KEY}", "User-Agent": MOOVIBE_USER_AGENT}
        query = requests.utils.quote(f"{GENIUS_MUSICA} {GENIUS_ARTISTA}")
        resp_busca = requests.get(f"{URL_GENIUS_SEARCH}?q={query}", headers=headers, timeout=10)
        print(f"[1] Busca status: {resp_busca.status_code}")
        if resp_busca.status_code != 200:
            print(f"    Erro: {resp_busca.text[:300]}")
            return 1

        dados_busca = resp_busca.json()
        hits = dados_busca.get("response", {}).get("hits", [])
        if not hits:
            print("    Nenhum hit encontrado na busca.")
            return 1

        result = hits[0].get("result", {})
        song_id = result.get("id")
        song_url = result.get("url")
        song_title = result.get("title")
        print(f"    Hit[0]: id={song_id}, title='{song_title}', url={song_url}")

        resp_song = requests.get(f"{URL_GENIUS_SONGS}/{song_id}", headers=headers, timeout=10)
        print(f"[2] /songs/{song_id} status: {resp_song.status_code}")
        if resp_song.status_code != 200:
            print(f"    Erro: {resp_song.text[:300]}")
            return 1

        dados_song = resp_song.json()
        desc_dom = dados_song.get("response", {}).get("song", {}).get("description", {}).get("dom")
        print("[3] Resultado bruto da API (response.song.description.dom):")
        print(json.dumps(desc_dom, indent=2, ensure_ascii=False)[:2000])
        print()

        if desc_dom is None:
            print("DIAGNÓSTICO: description.dom é None/ausente — Genius não tem descrição editorial para esta música.")
            return 1

        texto = extrair_texto_genius_dom(desc_dom)
        texto = re.sub(r'\s+', ' ', texto).strip()
        print(f"[4] Texto extraído ({len(texto)} chars):")
        print(f"    {texto[:500]}")

        if not texto or len(texto) < 30 or texto == "?":
            print("\nDIAGNÓSTICO: descrição vazia/placeholder — o filtro vai rejeitar e seguir para próxima camada.")
            return 1

        print("\nDIAGNÓSTICO: descrição real encontrada — a camada Genius está funcionando!")
        return 0
    except Exception as e:
        print(f"ERRO: {e}")
        return 1


if __name__ == "__main__":
    sys.exit(test_genius_layer())