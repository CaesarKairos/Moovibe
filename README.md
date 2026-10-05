# Moovibe

Moovibe recebe de uma a três músicas e encontra, dentro de uma biblioteca cinematográfica própria, o filme que mais compartilha sua atmosfera, sentimentos, temas, estética e ritmo. A IA analisa e explica a conexão; ela não define o universo de filmes disponíveis.

## Arquitetura

```text
música(s) → letras/contexto → perfil Gemini → embedding Gemini
                                         ↓
                                  Vectorize (top 100)
                                         ↓
                         D1 → score matemático → diversificação
                                         ↓
                        Gemini escolhe somente entre os finalistas
                                         ↓
                    adaptador de resposta → frontend / KV / share
```

- Cloudflare Pages hospeda o frontend existente e as Pages Functions.
- `functions/recommend.js` preserva o contrato da interface, letras, contexto, capas, previews, Hall da Fama e compartilhamento.
- O binding `MOOVIBE_DB` continua sendo **Cloudflare KV**. Ele guarda cache, histórico e shares; não é a biblioteca SQL.
- D1 (`MOOVIBE_LIBRARY`) é a fonte de verdade normalizada dos filmes, relações, enriquecimentos e checkpoints.
- Vectorize (`MOVIE_VECTORS`) contém somente o índice semântico; o `tmdb_id` em string identifica cada vetor.
- `moovibe-pipeline` usa Cron para agendar trabalho e Cloudflare Queue para executar jobs pequenos e retomáveis. Falhas após cinco tentativas seguem para `moovibe-pipeline-dlq`.
- TMDb fornece fatos. Gemini produz inferências estéticas estruturadas, embeddings e a curadoria final limitada ao candidate set.

O schema está em `migrations/0001_library.sql`. A coleta mantém sobreposições entre países, gêneros, décadas e ordenações. Descoberta e detalhes são separados: encontrar o mesmo `tmdb_id` em várias consultas cria várias memberships, mas apenas um job caro de detalhes.

## Desenvolvimento

Requer Node.js 20+ e Python apenas para as ferramentas locais legadas.

```bash
npm install
copy .dev.vars.example .dev.vars
npm test
npm run typecheck
npm run db:migrate:local
npm run worker:dev
npm run pages:dev
```

`.dev.vars` e `.env` nunca devem ser commitidos. O arquivo de exemplo contém somente placeholders.

## Cloudflare deployment / setup

1. Autentique e confira o que já existe:

```bash
npx wrangler login
npm run cloud:check
npm run pages:config:download
```

O último comando baixa a configuração do Pages remoto existente. Compare-a antes de substituir qualquer configuração local; não crie outro projeto Pages.

2. Crie somente os recursos nomeados que ainda não existirem e grave o UUID real do D1 no Wrangler do Worker:

```bash
npm run cloud:provision
```

O script não apaga recursos. Ele cria/verifica D1 `moovibe-library`, Vectorize `moovibe-movies-v1` (768 dimensões, cosine), Queue `moovibe-pipeline` e DLQ `moovibe-pipeline-dlq`.

3. Aplique o schema:

```bash
npm run db:migrate
```

4. Configure no Worker os secrets (cada comando solicitará o valor sem gravá-lo no Git):

```bash
npx wrangler secret put GEMINI_API_KEY --config workers/pipeline/wrangler.jsonc
npx wrangler secret put TMDB_API_KEY --config workers/pipeline/wrangler.jsonc
npx wrangler secret put ADMIN_TOKEN --config workers/pipeline/wrangler.jsonc
```

5. Configure no projeto Pages existente, pelo painel ou CLI, os secrets `GEMINI_API_KEY`, `TMDB_API_KEY` e `ADMIN_TOKEN`. Adicione ao Pages os bindings D1 `MOOVIBE_LIBRARY`, Vectorize `MOVIE_VECTORS` e preserve o KV existente `MOOVIBE_DB`. Defina também:

```text
EMBEDDING_MODEL=gemini-embedding-2
EMBEDDING_DIMENSIONS=768
RECOMMENDER_VERSION=catalog-v3-hybrid
```

Pages e Worker são serviços diferentes; secrets repetidos precisam ser configurados nos dois.

6. O SQLite local contém dados úteis e não deve ser apagado. Faça o bootstrap one-shot:

```bash
npm run sqlite:migrate -- --remote
```

O import é idempotente e preserva filmes, gêneros, países, língua, keywords, diretor, origens de descoberta e estilos legados válidos. Valide:

```bash
npx wrangler d1 execute MOOVIBE_LIBRARY --remote --config workers/pipeline/wrangler.jsonc --command "SELECT COUNT(*) AS movies, SUM(enrichment_status='complete') AS enriched FROM movies"
```

7. Implante o Worker e, depois de verificar os bindings do projeto Pages existente, o Pages:

```bash
npm run worker:deploy
npm run pages:deploy
```

## Operação e observabilidade

```bash
npm run worker:tail
curl -H "Authorization: Bearer $ADMIN_TOKEN" https://SEU_WORKER/admin/run
curl -H "Authorization: Bearer $ADMIN_TOKEN" https://SEU_DOMINIO/admin/status
```

Os logs são JSON e registram query, job, `tmdb_id`, modelo, erros e conclusão. `/admin/status` mostra contagens, backlog, erros recentes, progresso de queries e último Cron, sem retornar secrets. `/admin/run` apenas agenda trabalho e exige token.

## Segurança e consistência

- Secrets permanecem no servidor.
- Fatos exibidos vêm do D1/TMDb; enrichment é armazenado separadamente como inferência.
- O modelo generativo é descoberto via `models.list`, com preferência por Flash estável e retry limitado.
- Embeddings usam exclusivamente `gemini-embedding-2`, 768 dimensões. Falhas são adiadas; modelos diferentes nunca são misturados no índice.
- A resposta do curador é rejeitada se qualquer `tmdb_id` estiver fora dos candidatos. Nesse caso, o ranking determinístico fornece a resposta.
- Cache final inclui versão, idioma e todas as 1–3 músicas, com TTL de 24 horas.

## Legado local

O SQLite e os módulos Python permanecem temporariamente apenas como fonte auditável de bootstrap. Ollama, GUIs e o app terminal não participam da operação cloud. Remova-os somente após validar a migração remota e manter um backup do SQLite.
