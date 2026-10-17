# Migracao Grok (xAI) — enriquecimento cinematografico

## Modelo escolhido
`grok-4-1-fast-non-reasoning` (configuravel via `MOVIE_GENERATION_MODEL`).
Motivo: familia fast/non-reasoning otimizada para extracao semantica + JSON
Schema (structured outputs), baixa latencia e menor custo por filme que os
flagships `grok-4.7`/`grok-4.x` (US$ 2,00 in / US$ 6,00 out por 1M tokens).
Validar o ID exato no console xAI antes de ativar — aliases `latest` mudam.

## Custo estimado (tokens aproximados por filme)
- Entrada: ~1.500 tokens (contexto TMDb + Wikipedia + instrucoes).
- Saida: ~350 tokens (JSON do perfil).
- Conta (tabela publica xAI out/2026, modelo fast ~1/4 do flagship):
  in ~US$ 0,50/1M, out ~US$ 1,50/1M (estimativa conservadora — confirmar no console).
- Por filme: ~US$ 0,0013. 100 filmes: ~US$ 0,13. 9.369 filmes: ~US$ 12.
- Gemini embedding continua separado (mesmo espaco vetorial 768d).
- Protecao: sem budget nativo documentado — usar limite de gasto no console
  xAI + circuit breaker local + lotes pequenos (25).

## Ativacao (sem valores de secrets)
1. `wrangler secret put XAI_API_KEY --config workers/pipeline/wrangler.jsonc`
2. `wrangler deploy --config workers/pipeline/wrangler.jsonc`
3. `curl -X POST $WORKER/admin/recover-generation -H "Authorization: Bearer $ADMIN_TOKEN" -d '{"limit":25}'`
4. Monitorar `/admin/providers` (generation xai OPERACIONAL/LIMITADO).
5. Expandir limite gradualmente (25 -> 50 -> 100).

## Rollback
`MOVIE_GENERATION_PROVIDER=gemini` + deploy. Embeddings intactos (768d).
Filmes Grok mantidos (proveniencia provider=xai). Nada e reprocessado.
