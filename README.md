<p align="center">
  <img src="https://img.shields.io/badge/Status-Online-brightgreen?style=flat-square" alt="Status">
  <img src="https://img.shields.io/badge/Python-3.11+-blue?style=flat-square&logo=python&logoColor=white" alt="Python">
  <img src="https://img.shields.io/badge/JavaScript-ESM-yellow?style=flat-square&logo=javascript&logoColor=black" alt="JavaScript">
  <img src="https://img.shields.io/badge/Cloudflare-Pages-F38020?style=flat-square&logo=cloudflare&logoColor=white" alt="Cloudflare Pages">
  <img src="https://img.shields.io/badge/IA-OpenRouter-8A2BE2?style=flat-square" alt="OpenRouter">
  <img src="https://img.shields.io/badge/License-MIT-green?style=flat-square" alt="MIT License">
</p>

# 🎬 Moovibe

**Moovibe** conecta música e cinema através de inteligência artificial. Você digita o nome de uma música (e opcionalmente o artista), e o Moovibe analisa a letra, o contexto e a "vibe" da canção para recomendar um filme que compartilhe da mesma atmosfera emocional.

> 🚀 **Teste agora mesmo sem instalar nada:** [https://moovibe.pages.dev/](https://moovibe.pages.dev/)

---

## ✨ Como funciona

1. Você informa o nome de uma música, podendo acrescentar até 2 músicas adicionais (no máximo 3 no total) 🎵
2. O sistema busca a letra (via [LRCLIB](https://lrclib.net)) e o contexto/significado (via [Genius](https://genius.com/) ou [Wikipedia](https://www.wikipedia.org/))
3. Se as APIs não encontrarem resultados, o [DuckDuckGo](https://duckduckgo.com/) e o [Brave Search](https://search.brave.com/) são usados como fallback 🔄
4. A letra e o contexto são enviados para uma IA ([OpenRouter](https://openrouter.ai/)) que sugere um filme com base na **vibe** da música
5. O sistema busca pôster, sinopse, diretor e imagens do filme no [TMDb](https://www.themoviedb.org/)
6. Tudo é exibido em uma interface bonita e cinematográfica 🎥

---

## 🏗️ Arquitetura

O Moovibe possui **duas formas de execução**:

| Forma | Descrição |
|-------|-----------|
| **Cloudflare Pages (recomendado)** | Frontend SPA + Pages Functions (API) no mesmo domínio |
| **Terminal (Python)** | Versão original, execução local via `app.py` (sem interface web) |

### Cloudflare Pages (produção)

```
📁 Moovibe/
├── index.html               # Frontend SPA (HTML)
├── css/
│   └── style.css            # Estilos (brutalismo/cinema)
├── js/
│   └── script.js            # Lógica SPA (navegação, autocomplete, DOM injection)
├── functions/
│   ├── _lib/
│   │   └── lrclib.js        # Módulo compartilhado LRCLIB (headers, throttle, URLs)
│   ├── recommend.js         # API principal POST /recommend + GET (history/share lookup)
│   ├── lrclib-search.js     # Autocomplete de música (GET /lrclib-search)
│   └── share/
│       └── [slug].js        # Open Graph dinâmico (GET /share/{slug})
├── _redirects               # SPA fallback (/* /index.html 200)
├── robots.txt               # SEO
├── sitemap.xml              # SEO
├── images/
│   ├── icon.svg             # Ícone do site
│   ├── og-image.png         # Imagem padrão Open Graph (1200x630)
│   ├── plus.svg             # Ícone "adicionar música"
│   └── x.svg                # Ícone "remover música"
├── env.example              # Template de variáveis de ambiente
├── requirements.txt         # Dependências Python (versão terminal)
├── app.py                   # Versão Python (terminal)
├── tests/
│   ├── test_style.py        # Teste de pipeline (CI — "Style" - Taylor Swift)
│   └── test_genius_layer.py # Teste isolado da camada Genius
└── README.md                # Documentação pública
```

O frontend envia uma requisição `POST /recommend` com `{ nome_musica, artista, lrclib_id, musicas_extras, lang }`. A Pages Function orquestra todo o pipeline (letra → contexto → IA → TMDb → citações → dados da música) e retorna um JSON consolidado.

**Funcionalidades:**
- 🔍 **Autocomplete de música**: ao digitar no campo de busca, sugestões do LRCLIB aparecem em tempo real (debounce 350ms, navegação por teclado, clique fora para fechar).
- 🎵 **Múltiplas músicas**: até 3 faixas por busca (botão "+" para adicionar), com capa e preview de áudio de cada uma.
- 🔗 **Links compartilháveis**: cada recomendação gera uma URL `/share/{slug}` com preview rico (Open Graph dinâmico).
- 📋 **Hall da Fama**: histórico das últimas recomendações (via Cloudflare KV), acessível em `/hall-of-fame`.
- 🌐 **SEO + URLs reais**: meta tags dinâmicas, sitemap, robots.txt, canonical e rotas reais (`/about`, `/how-it-works`, `/hall-of-fame`) com suporte a voltar/avançar do navegador.
- 🌍 **i18n**: interface em português (pt-BR) ou inglês, detectada automaticamente pelo idioma do navegador.
- 🛡️ **Pipeline resiliente**: retry automático para respostas de segurança do OpenRouter, com detecção precisa de "User Safety" sem falsos positivos. Cache de 30 dias no KV evita reprocessamento.

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

As dependências são: `requests`, `python-dotenv`, `lyricsgenius` e `duckduckgo_search` (importado apenas como complemento; o código usa a DuckDuckGo Instant Answer API diretamente via HTTP).

#### 4. Configure as variáveis de ambiente

Copie o arquivo de exemplo e edite com suas chaves:

```bash
cp env.example .env
```

> 💡 O arquivo template oficial é `env.example` (sem ponto inicial).

Abra o arquivo `.env` e preencha com suas credenciais:

```env
OPENROUTER_API_KEY=sk-or-v1-sua-chave-aqui
TMDB_API_KEY=sua-chave-tmdb-aqui
GENIUS_API_KEY=sua-chave-genius-aqui
```

> 🔑 **Onde obter as chaves:**
> - **OpenRouter:** [https://openrouter.ai/keys](https://openrouter.ai/keys) (necessário para a IA)
> - **TMDb:** [https://www.themoviedb.org/settings/api](https://www.themoviedb.org/settings/api) (para pôsteres e dados dos filmes)
> - **Genius:** [https://genius.com/api-clients](https://genius.com/api-clients) (para contexto das músicas — **opcional**)

#### 5. Execute a aplicação

```bash
python app.py
```

Digite o nome de uma música e o artista quando solicitado. O resultado será exibido no terminal.

---

## 🛠️ Tecnologias

| Tecnologia | Finalidade |
|------------|------------|
| [Cloudflare Pages](https://pages.cloudflare.com/) | Hospedagem fullstack (frontend + Pages Functions + KV) |
| [OpenRouter](https://openrouter.ai/) | IA para recomendação de filmes e geração de contexto |
| [TMDb](https://www.themoviedb.org/) | Dados de filmes (pôster, sinopse, diretor, stills, IMDb ID) |
| [LRCLIB](https://lrclib.net/) | Letras de músicas (fonte principal, sem API key) |
| [Genius](https://genius.com/) | Contexto e significado das músicas (scraping + API) |
| [DuckDuckGo](https://duckduckgo.com/) | Fallback de contexto (Instant Answer API) |
| [Brave Search](https://search.brave.com/) | Fallback de busca web (letras, contexto, citações) |
| [Wikipedia](https://www.wikipedia.org/) | Fallback de contexto e dados de filmes (PT/EN) |
| [Apple Music/iTunes](https://www.apple.com/itunes/) | Capa do álbum e prévia de áudio |
| [Deezer](https://www.deezer.com/) | Fallback de capa e preview de áudio |
| [MusicBrainz + Cover Art Archive](https://musicbrainz.org/) | Fallback de capa do álbum |

---

## 🧪 Testes

```bash
python -m venv .venv
source .venv/bin/activate  # ou .venv\Scripts\activate no Windows
pip install -r requirements.txt
python tests/test_style.py
```

O teste `test_style.py` valida o pipeline completo para a música **"Style" - Taylor Swift"** (letra → contexto → IA → validação de JSON).

O CI do GitHub Actions também executa este teste em cada *push* para a branch `main`.

---

## 📄 Licença

Este projeto está sob a licença MIT. Sinta-se à vontade para usar, modificar e compartilhar.
