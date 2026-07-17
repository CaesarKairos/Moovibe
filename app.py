import requests
import json
from dotenv import load_dotenv
import os

load_dotenv()

API_KEY = os.getenv("OPENROUTER_API_KEY") 

def obter_filme_da_musica(nome_musica):
    url = "https://openrouter.ai/api/v1/chat/completions"
    
    headers = {
        "Authorization": f"Bearer {API_KEY}",
        "Content-Type": "application/json"
    }
    
    # Aqui criamos a "personalidade" e as regras da IA
    prompt_sistema = (
        "Você é um especialista em cinema e música. O usuário vai te dar o nome de uma música "
        "e você deve recomendar APENAS um filme que tenha exatamente a mesma vibe, atmosfera ou "
        "temática dessa música. Responda em português de forma direta, amigável e descontraída. "
        "Indique o nome do filme, o ano de lançamento e explique brevemente por que ele combina com a música."
    )
    
    # Usamos o 'openrouter/free' que escolhe automaticamente uma IA gratuita disponível para nós!
    dados_requisicao = {
        "model": "openrouter/free", 
        "messages": [
            {"role": "system", "content": prompt_sistema},
            {"role": "user", "content": f"A música é: '{nome_musica}'."}
        ]
    }
    
    print("\nAnalisando a vibe da música e procurando o filme ideal...")
    
    try:
        # Faz a chamada para o OpenRouter
        resposta = requests.post(url, headers=headers, json=dados_requisicao)
        resposta.raise_for_status() # Verifica se deu erro na requisição (ex: chave inválida)
        
        # Extrai o texto da resposta da IA
        dados_retorno = resposta.json()
        resposta_ia = dados_retorno['choices'][0]['message']['content']
        return resposta_ia
        
    except requests.exceptions.HTTPError as err:
        return f"Erro na requisição. Verifique se copiou a API Key corretamente. Detalhes: {err}"
    except Exception as e:
        return f"Ops! Ocorreu um erro inesperado: {e}"

def main():
    
    # Validação simples para o desenvolvedor não esquecer de mudar a chave
    if API_KEY == "SUA_CHAVE_AQUI" or not API_KEY:
        print("\n[ERRO] Você esqueceu de colocar sua API Key do OpenRouter na variável 'API_KEY'!")
        return

    while True:
        # Pede a música no terminal
        musica = input("\nDigite o nome de uma música (ou 'sair' para fechar): ").strip()
        
        if musica.lower() == 'sair':
            print("\nAté a próxima! Bom filme!")
            break
            
        if not musica:
            print("Digite o nome de alguma música para que eu possa te ajudar!")
            continue
            
        # Busca a recomendação
        resultado = obter_filme_da_musica(musica)
        
        # Exibe o resultado de forma organizada
        print("\n" + "="*50)
        print("RECOMENDAÇÃO:")
        print("="*50)
        print(resultado)
        print("="*50)

if __name__ == "__main__":
    main()