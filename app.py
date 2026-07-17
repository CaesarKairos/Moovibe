import os
import json
import requests
import urllib.parse
from dotenv import load_dotenv

# Carrega as variaveis de ambiente do seu arquivo .env
load_dotenv()

OPENROUTER_API_KEY = os.getenv("OPENROUTER_API_KEY")
TMDB_API_KEY = os.getenv("TMDB_API_KEY")

# Evita que editores linkifiquem as URLs e quebrem o código Python
URL_LRCLIB = "https://" + "lrclib.net/api/search"
URL_OPENROUTER = "https://" + "openrouter.ai/api/v1/chat/completions"
URL_TMDB_BUSCA = "https://" + "api.themoviedb.org/3/search/movie"
URL_TMDB_BASE = "https://" + "api.themoviedb.org/3/movie"

# ==========================================
# 1. BUSCA DE LETRAS (LRCLIB API - Gratis)
# ==========================================
def buscar_letra_musica(nome_musica, artista):
    """Busca a letra da musica de forma gratuita usando a API do LRCLIB."""
    params = {
        "track_name": nome_musica,
        "artist_name": artista
    }
    try:
        resposta = requests.get(URL_LRCLIB, params=params, timeout=10)
        if resposta.status_code == 200 and resposta.json():
            return resposta.json()[0].get("plainLyrics", "")
    except Exception:
        pass
    return None

# ==========================================
# 2. INTELIGENCIA ARTIFICIAL (OpenRouter)
# ==========================================
def obter_recomendacao_ia(nome_musica, artista, letra):
    """Manda a musica, artista e a letra para a IA e recebe a indicacao de filme."""
    headers = {
        "Authorization": f"Bearer {OPENROUTER_API_KEY}",
        "Content-Type": "application/json"
    }

    if letra:
        contexto_letra = f"\nUse a letra da musica para capturar a essencia poetica profunda:\n{letra}"
    else:
        contexto_letra = "\n(Nao encontramos a letra no banco de dados, baseie-se no tema geral da musica)."

    prompt_sistema = (
        "Voce e um curador de cinema genial. O usuario vai te passar uma musica e voce deve sugerir "
        "EXATAMENTE UM filme que compartilhe exatamente da mesma atmosfera emocional, paleta de cores "
        "subtendida, ritmo psicologico ou alma lirica dessa musica. "
        "Nao se limite a conexoes obvias. Pense na vibe.\n\n"
        "Sua resposta DEVE ser estritamente um formato JSON valido (sem qualquer tipo de formatacao markdown, "
        "apenas as chaves brutas). O JSON deve conter as seguintes chaves exatas:\n"
        "{\n"
        '  "filme_sugerido": "Nome exato do filme (de preferencia o titulo original em ingles ou o mais conhecido)",\n'
        '  "justificativa_vibe": "Uma explicacao poetica, profunda e envolvente (em portugues, ate 4 frases) conectando sentimentos da musica/letra com o filme."\n'
        "}"
    )

    dados_requisicao = {
        "model": "openrouter/free",
        "messages": [
            {"role": "system", "content": prompt_sistema},
            {"role": "user", "content": f"Musica: '{nome_musica}' do artista '{artista}'.{contexto_letra}"}
        ]
    }

    try:
        resposta = requests.post(URL_OPENROUTER, headers=headers, json=dados_requisicao, timeout=20)
        resposta.raise_for_status()
        retorno = response_json = resposta.json()
        texto_ia = response_json['choices'][0]['message']['content'].strip()
        
        # Remove eventuais poluicoes de markdown que algumas IAs geram
        texto_ia = texto_ia.replace("```json", "").replace("```", "").strip()
            
        return json.loads(texto_ia)
    except Exception as e:
        print(f"Erro ao conversar com a IA ou decodificar o JSON: {e}")
        return None

# ==========================================
# 3. DADOS COMPLEMENTARES DO FILME (TMDb)
# ==========================================
def obter_detalhes_filme_tmdb(nome_filme):
    """Busca poster, sinopse, diretor, ID do IMDb e cenas de fundo no TMDb."""
    if not TMDB_API_KEY:
        return None

    params_busca = {
        "api_key": TMDB_API_KEY,
        "query": nome_filme,
        "language": "pt-BR"
    }

    try:
        resp_busca = requests.get(URL_TMDB_BUSCA, params=params_busca, timeout=10)
        if resp_busca.status_code != 200 or not resp_busca.json().get("results"):
            return None
        
        filme_basico = resp_busca.json()["results"][0]
        filme_id = filme_basico["id"]

        url_detalhes = f"{URL_TMDB_BASE}/{filme_id}"
        params_detalhes = {"api_key": TMDB_API_KEY, "language": "pt-BR"}
        resp_detalhes = requests.get(url_detalhes, params=params_detalhes, timeout=10).json()

        url_creditos = f"{URL_TMDB_BASE}/{filme_id}/credits"
        resp_creditos = requests.get(url_creditos, params={"api_key": TMDB_API_KEY}, timeout=10).json()
        
        diretor = "Nao encontrado"
        for pessoa in resp_creditos.get("crew", []):
            if pessoa.get("job") == "Director":
                diretor = pessoa.get("name")
                break

        url_imagens = f"{URL_TMDB_BASE}/{filme_id}/images"
        resp_imagens = requests.get(url_imagens, params={"api_key": TMDB_API_KEY}, timeout=10).json()
        
        cenas = []
        for backdrop in resp_imagens.get("backdrops", [])[:3]:
            cenas.append(f"https://image.tmdb.org/t/p/w780{backdrop['file_path']}")

        dados_filme = {
            "id_tmdb": filme_id,
            "titulo_pt": filme_basico.get("title"),
            "titulo_original": filme_basico.get("original_title"),
            "ano": filme_basico.get("release_date", "----")[:4],
            "sinopse": filme_basico.get("overview", "Sem sinopse disponivel."),
            "poster": f"https://image.tmdb.org/t/p/w500{filme_basico.get('poster_path')}" if filme_basico.get('poster_path') else None,
            "diretor": diretor,
            "imdb_id": resp_detalhes.get("imdb_id"),
            "cenas": cenas
        }
        return dados_filme

    except Exception as e:
        print(f"Erro ao consultar o TMDb: {e}")
        return None

# ==========================================
# 4. ORQUESTRACAO & ENTRADA (Main)
# ==========================================
def main():
    print()
    print("==================================================")
    print("Moovibe")
    print("==================================================")

    if not OPENROUTER_API_KEY:
        print("[ERRO] OPENROUTER_API_KEY nao encontrada no seu arquivo .env!")
        return
    if not TMDB_API_KEY:
        print("[AVISO] TMDB_API_KEY nao configurada. O app funcionara apenas com recomendacoes de texto.")

    while True:
        print()
        nome_musica = input("Digite o nome da musica (or 'sair'): ").strip()
        if nome_musica.lower() == 'sair':
            print()
            print("Até a próxima! Bom filme!")
            break
            
        if not nome_musica:
            continue

        artista = input("Digite o nome do artista/banda: ").strip()
        if not artista:
            print("Por favor, digite o artista também para termos precisao.")
            continue

        print()
        print("Buscando letra no banco de dados...")
        letra = buscar_letra_musica(nome_musica, artista)
        if letra:
            print("Letra encontrada e carregada com sucesso.")
        else:
            print("Letra nao encontrada. Prosseguindo apenas com a energia da musica.")

        print("Analisando a vibe profunda...")
        recomendacao_ia = obter_recomendacao_ia(nome_musica, artista, letra)

        if not recomendacao_ia:
            print("Falha ao obter recomendacao da IA. Tente novamente.")
            continue

        nome_filme_ia = recomendacao_ia["filme_sugerido"]
        justificativa = recomendacao_ia["justificativa_vibe"]

        print(f"Consultando TMDb para coletar as midias de '{nome_filme_ia}'...")
        dados_filme = obter_detalhes_filme_tmdb(nome_filme_ia)

        print()
        print("==================================================")
        print("FILME RECOMENDADO:")
        print("==================================================")
        
        if dados_filme:
            print(f"Titulo: {dados_filme['titulo_pt']} ({dados_filme['titulo_original']})")
            print(f"Ano de Lancamento: {dados_filme['ano']}")
            print(f"Direcao: {dados_filme['diretor']}")
            print()
            print(f"Sinopse:\n{dados_filme['sinopse']}")
            print()
            print(f"Link do Poster: {dados_filme['poster']}")
            if dados_filme['cenas']:
                print()
                print("Cenas do Filme (Backdrops):")
                for i, cena in enumerate(dados_filme['cenas'], 1):
                    print(f"   Cena {i}: {cena}")
        else:
            print(f"Filme sugerido pela IA: {nome_filme_ia}")

        print()
        print("--------------------------------------------------")
        print("POR QUE COMBINA? (VIBE COMPARISON):")
        print("--------------------------------------------------")
        print(justificativa)
        print("--------------------------------------------------")

        print("LINKS IMPORTANTES:")
        print("--------------------------------------------------")
        
        if dados_filme and dados_filme.get("imdb_id"):
            print(f"IMDb: https://www.imdb.com/title/{dados_filme['imdb_id']}/")
        else:
            term_imdb = urllib.parse.quote(nome_filme_ia)
            print(f"IMDb (Busca): https://www.imdb.com/find?q={term_imdb}")

        if dados_filme:
            print(f"Letterboxd: https://letterboxd.com/tmdb/{dados_filme['id_tmdb']}")
        else:
            term_lb = urllib.parse.quote(nome_filme_ia)
            print(f"Letterboxd (Busca): https://letterboxd.com/search/{term_lb}/")

        tiktok_query = urllib.parse.quote(f"{nome_filme_ia} edit")
        print(f"TikTok (Navegador): https://www.tiktok.com/search?q={tiktok_query}")
        print(f"TikTok (Abrir direto no App): tiktok://search?keyword={tiktok_query}")
        print("==================================================")

if __name__ == "__main__":
    main()