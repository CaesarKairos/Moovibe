<p align="center">
  <img src="https://img.shields.io/badge/Status-Online-brightgreen?style=flat-square" alt="Status">
  <img src="https://img.shields.io/badge/Python-3.11+-blue?style=flat-square&logo=python&logoColor=white" alt="Python">
  <img src="https://img.shields.io/badge/JavaScript-ESM-yellow?style=flat-square&logo=javascript&logoColor=black" alt="JavaScript">
  <img src="https://img.shields.io/badge/Cloudflare-Pages-F38020?style=flat-square&logo=cloudflare&logoColor=white" alt="Cloudflare Pages">
  <img src="https://img.shields.io/badge/IA-OpenRouter-8A2BE2?style=flat-square" alt="OpenRouter">
  <img src="https://img.shields.io/badge/License-MIT-green?style=flat-square" alt="MIT License">
</p>

# 🎬 Moovibe

**Moovibe** é uma ferramenta que conecta música e cinema através de inteligência artificial. Você digita o nome de uma música (e opcionalmente o artista), e o Moovibe analisa a letra, o contexto e a "vibe" da canção para recomendar um filme que compartilhe da mesma atmosfera emocional.

> 🚀 **Teste agora mesmo sem instalar nada:** [https://moovibe.pages.dev/](https://moovibe.pages.dev/)

---

## ✨ Como funciona

1. Você informa o nome de uma música 🎵
2. O sistema busca a letra (via [LRCLIB](https://lrclib.net)) e o contexto/significado (via [Genius](https://genius.com/))
3. Se as APIs não encontrarem resultados, o DuckDuckGo é usado como fallback 🔄
4. A letra e o contexto são enviados para uma IA ([OpenRouter](https://openrouter.ai/)) que sugere um filme com base na **vibe** da música
5. O sistema busca pôster, sinopse, diretor e imagens do filme no [TMDb](https://www.themoviedb.org/)
6. Tudo é exibido em uma interface bonita e cinematográfica 🎥

---

## 🧠 Arquitetura

O Moovibe possui duas formas de execução:

| Forma | Descrição |
|-------|-----------|
| **Terminal (Python)** | Versão original, execução local via `app.py` |
| **Cloudflare Pages (Fullstack)** | Versão moderna com frontend + API unificados no mesmo domínio |

### Cloudflare Pages (recomendado)

```
📁 Moovibe/
├── index.html              # Frontend (SPA)
├── css/style.css           # Estilos
├── js/script.js            # Lógica do frontend
├── functions/
│   ├── _lib/
│   │   └── lrclib.js       # Módulo compartilhado LRCLIB
│   ├── recommend.js        # API principal (Pages Function)
│   ├── lrclib-search.js    # Autocomplete de música (/lrclib-search)
│   └── share/
│       └── [slug].js        # Open Graph dinâmico (/share/{slug})
├── _redirects              # SPA fallback (Cloudflare Pages)
├── robots.txt              # SEO
├── sitemap.xml             # SEO
├── images/
│   └── og-image.png        # Imagem padrão Open Graph (1200x630)
├── .env.example            # Exemplo de variáveis de ambiente
└── app.py                  # Versão Python (terminal)
```

O frontend faz uma requisição `POST /recommend` para a Pages Function, que orquestra todas as APIs e retorna um JSON com os dados do filme recomendado.

**Funcionalidades:**
- 🔍 **Autocomplete de música**: ao digitar no campo de busca, sugestões do LRCLIB aparecem em tempo real (debounce, navegação por teclado).
- 🔗 **Links compartilháveis**: cada recomendação gera uma URL `/share/{slug}` com preview rico (Open Graph dinâmico).
- 🌐 **SEO básico**: meta tags, canonical, sitemap, robots.txt e URLs reais por view (`/about`, `/how-it-works`, `/hall-of-fame`) com suporte a voltar/avançar do navegador.
- 🛡️ **Pipeline resiliente**: retry automático para respostas de segurança do OpenRouter, com detecção precisa de "User Safety" sem falsos positivos.

---

## 🐍 Execução local (Terminal — Python)

> ⚠️ Esta versão roda **apenas no terminal**, sem interface gráfica.

### 📋 Pré-requisitos

- **Python 3.11** (recomendado)
- `pip` (gerenciador de pacotes do Python)

### 🔧 Passo a passo

#### 1. Clone o repositório

```bash
git clone https://github.com/CaesarKairos/Moovibe.git
cd Moovibe
```

#### 2. Crie um ambiente virtual (recomendado)

```bash
python -m venv .venv
```

Ative o ambiente:

- **Windows (cmd):**
  ```bash
  .venv\Scripts\activate
  ```
- **Windows (PowerShell):**
  ```bash
  .venv\Scripts\Activate.ps1
  ```
- **Linux / macOS:**
  ```bash
  source .venv/bin/activate
  ```

#### 3. Instale as dependências

```bash
pip install -r requirements.txt
```

Caso não exista um `requirements.txt`, instale manualmente:

```bash
pip install requests python-dotenv lyricsgenius duckduckgo_search
```

#### 4. Configure as variáveis de ambiente

Copie o arquivo de exemplo e edite com suas chaves:

```bash
cp .env.example .env
```

Abra o arquivo `.env` e preencha com suas credenciais:

```env
OPENROUTER_API_KEY=sk-or-v1-sua-chave-aqu
TMDB_API_KEY=sua-chave-tmdb-aqui
GENIUS_API_KEY=sua-chave-genius-aqui
```

> 🔑 **Onde obter as chaves:**
> - **OpenRouter:** [https://openrouter.ai/keys](https://openrouter.ai/keys) (necessário para a IA)
> - **TMDb:** [https://www.themoviedb.org/settings/api](https://www.themoviedb.org/settings/api) (para pôsteres e dados dos filmes)
> - **Genius:** [https://genius.com/api-clients](https://genius.com/api-clients) (para contexto das músicas — opcional)

#### 5. Execute a aplicação

```bash
python app.py
```

Digite o nome de uma música e o artista quando solicitado. O resultado será exibido no terminal.

---

## 🛠️ Tecnologias utilizadas

| Tecnologia | Finalidade |
|------------|------------|
| [Cloudflare Pages](https://pages.cloudflare.com/) | Hospedagem fullstack (frontend + API) |
| [OpenRouter](https://openrouter.ai/) | IA para recomendação de filmes |
| [TMDb](https://www.themoviedb.org/) | Dados de filmes (pôster, sinopse, diretor) |
| [LRCLIB](https://lrclib.net/) | Letras de músicas (fonte principal) |
| [Genius](https://genius.com/) | Contexto e significado das músicas |
| [DuckDuckGo](https://duckduckgo.com/) | Fallback de contexto na web |
| [Apple Music / iTunes](https://www.apple.com/itunes/) | Capa do álbum e prévia de áudio |
| [OpenRouter](https://openrouter.ai/) | IA para recomendação de filmes (com retry para respostas de segurança) |

---

## 📄 Licença

Este projeto está sob a licença MIT. Sinta-se à vontade para usar, modificar e compartilhar.