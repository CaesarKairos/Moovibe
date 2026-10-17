# Migracao Grok (xAI) — enriquecimento cinematografico

## Modelo escolhido
`grok-4-3` (configuravel via `MOVIE_GENERATION_MODEL`, default em
`generation-factory.ts:DEFAULT_XAI_MODEL`).
Motivo: o ID anterior `grok-4-1-fast-non-reasoning` foi **aposentado em
15/05/2026** e redireciona para `grok-4-3` com preco do 4.3
(https://docs.x.ai/developers/migration/may-15-retirement). O guia oficial
recomenda `grok-4-3` para workloads non-reasoning. Endpoint e parametros
(`POST /v1/chat/completions` + `response_format json_schema strict`) sao os
mesmos.
Validar o ID exato no console xAI antes de ativar.

## Custo oficial (https://docs.x.ai/developers/pricing, out/2026)
- `grok-4-3`: US$ 1,25 / 1M input, US$ 2,50 / 1M output (short context).
- Por filme (~1.500 in + ~350 out tokens): ~US$ 0,00275.
- 100 filmes: ~US$ 0,28. 9.369 filmes: ~US$ 26.
- Sem presuncao de creditos gratuitos. Sem chamadas reais feitas.
- Protecao: teto de gasto no console xAI + `MOVIE_GENERATION_ENABLED=false`
  por default + `MOVIE_GENERATION_PILOT_LIMIT=25/dia` + circuit breaker local.

## Ativacao segura (deploy != ativacao; sem valores de secrets)
1. Deploy publica com `MOVIE_GENERATION_ENABLED=false`: **zero geracao xAI**
   (cron nao agenda, queue adia com cooldown longo, nada e perdido/marcado erro).
2. `wrangler secret put XAI_API_KEY --config workers/pipeline/wrangler.jsonc`
3. `wrangler deploy --config workers/pipeline/wrangler.jsonc`
4. Dry-run (nada muda): `POST $WORKER/admin/recover-generation -d '{"limit":25,"dry_run":true}'`
5. Verificar `/admin/providers` (`enabled:false`, modelo, piloto usado/dia).
6. Ativar geracao (var de ambiente no dashboard/worker):
   `MOVIE_GENERATION_ENABLED=true` (+ deploy/restart conforme ambiente).
7. Lote piloto real: `POST .../recover-generation -d '{"limit":25}'`
   (limitado tambem pelo contador diario global `MOVIE_GENERATION_PILOT_LIMIT`).
8. Expandir gradualmente (25 -> 50 -> 100) observando erros/quota.

## Rollback
`MOVIE_GENERATION_ENABLED=false` (para imediatamente, sem deploy de codigo)
ou `MOVIE_GENERATION_PROVIDER=gemini` + deploy. Embeddings intactos (768d).
Filmes Grok mantidos (proveniencia provider=xai). Nada e reprocessado.
