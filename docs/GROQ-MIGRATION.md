# Enriquecimento cinematográfico com GroqCloud

O Worker usa exclusivamente `https://api.groq.com/openai/v1/chat/completions`
com `openai/gpt-oss-120b`. `XAI_API_KEY` continua sendo o secret do Cloudflare:
seu **valor deve ser uma chave GroqCloud**. Não é necessário criar outro secret.
O nome legado aparece apenas na configuração interna; valores não são registrados.
Uma chave Groq jamais é encaminhada à xAI. O cliente xAI permanece apenas para
compatibilidade histórica e testes isolados, sem importação pela factory ativa.
Provedores desconhecidos, `xai` e geração `gemini` são recusados; não existe fallback.

## Modelo, schema e limites

Configuração versionada em `workers/pipeline/wrangler.jsonc`:

```json
{
  "MOVIE_GENERATION_PROVIDER": "groq",
  "MOVIE_GENERATION_MODEL": "openai/gpt-oss-120b",
  "MOVIE_GENERATION_ENABLED": "true",
  "MOVIE_GENERATION_PILOT_LIMIT": "3"
}
```

A [documentação de Structured Outputs](https://console.groq.com/docs/structured-outputs)
confirma suporte estrito para esse modelo. O schema enviado usa o subconjunto
conservador documentado: objeto fechado, todos os campos obrigatórios, tipos,
arrays e enum de `pace`. Restrições de comprimento e limites numéricos são
omitidos somente no schema de transporte; `validateEnrichment()` e o schema
original mantêm todas as restrições de negócio (arrays não vazios, comprimentos,
dez dimensões entre 0 e 1 e `confidence`). Nenhum campo é eliminado.

O [guia de reasoning](https://console.groq.com/docs/reasoning) confirma `low`
para GPT-OSS. Usamos `reasoning_effort: "low"`, `include_reasoning: false`,
temperatura 0.2 e `max_completion_tokens: 2048` para limitar a resposta concisa
e seu raciocínio. Respostas truncadas ou inválidas falham na validação.
A compatibilidade foi verificada documentalmente e por testes HTTP simulados;
nenhuma aceitação ao vivo pela API foi testada nesta migração.

O pipeline mantém o documento semântico, os hashes, o índice Vectorize,
`gemini-embedding-2` e 768 dimensões. Filmes já enriquecidos são reutilizados,
inclusive os históricos Gemini/xAI; embeddings concluídos continuam idempotentes.
Locks por filme e gravação atômica com token no D1 foram preservados.
O recomendador público permanece inalterado.

## Piloto, cooldowns e observabilidade

- `gen_pilot_count:groq` separa o consumo do histórico `gen_pilot_count` da xAI.
  A admissão continua atômica: cada HTTP consome uma vaga, incluindo falhas e
  retries; requisições negadas antes da rede não consomem. Não há devolução.
- O teto é **três HTTPs por dia UTC**, não três sucessos. Renova-se na virada
  UTC; enquanto habilitado, pode executar até três novas tentativas a cada dia.
  O Cron limita novas gerações ao saldo observado; o gate atômico é a defesa
  final contra concorrência e mensagens previamente enfileiradas.
- `generation-groq` é independente de `generation-xai` e `embedding-gemini`.
  Circuito aberto causa adiamento durável em D1 com tentativas do job preservadas;
  a mensagem da Queue é reconhecida e o outbox existente retoma quando vencer.
  Adiamentos administrativos não consomem retries da Queue nem vão à DLQ.
- HTTP 429 não recebe retry interno curto. `Retry-After`, resets e saldos são
  interpretados conforme os [limites oficiais](https://console.groq.com/docs/rate-limits).
  Headers de requests representam RPD; de tokens representam TPM. RPM usa
  `Retry-After`/mensagem ou um minuto; RPD/TPD usa a espera informada e, sem
  informação diária suficiente, um dia. Cooldowns concorrentes só se estendem.
  Saldos zerados em HTTP 200 também abrem cooldown sem invalidar o resultado.
- HTTP 401/403, credencial inválida em 400 e erros de configuração são terminais
  e abrem circuito para revisão administrativa. Outros 400/422 não viram UNKNOWN.
  408/5xx permitem no máximo um retry interno limitado, se não houver espera
  indicada; cada retry revalida o circuito e consome outra vaga. Timeouts/leitura
  falha são classificados, contabilizados e usam o retry durável do job.
- `GET /admin/providers` mostra Groq, modelo, habilitação, limite, contadores
  próprios e cooldown; mostra Gemini/768 separadamente. O campo
  `authentication: not_verified_by_status_endpoint` deixa explícito que consultar
  o estado não comprova validade da credencial. Não executa uma chamada de teste.
- `ai_trace` registra `provider: groq` e o modelo. Erros/retries de enriquecimento
  identificam Groq; proveniência persistida também usa `provider: groq`.

## Publicar pelo PowerShell

Na raiz do repositório, com Wrangler autenticado e os secrets existentes:

```powershell
npm run check
if ($LASTEXITCODE -ne 0) { throw 'Falha na validação' }
git diff --check
if ($LASTEXITCODE -ne 0) { throw 'Diff inválido' }
npm run worker:deploy
```

Não recriar nem renomear `XAI_API_KEY` se ele já contém uma chave Groq válida.
Nenhuma migração D1 adicional é necessária. O deploy habilita o piloto;
não recupera automaticamente os jobs terminais antigos.
Para interromper novas gerações, publicar com `MOVIE_GENERATION_ENABLED=false`.

## Recuperação explícita e limitada

Falhas antigas de credencial xAI, circuito, quota e geração continuam elegíveis
ao endpoint existente. Primeiro inspecionar o dry-run; executar o lote real
apenas quando desejar recuperar esse trabalho. Jobs `done` e etapas concluídas
são preservados. Jobs `queued` em adiamento continuam retomáveis pelo outbox
após `available_at`; essa migração não antecipa seus prazos automaticamente.

```powershell
$workerUrl = 'https://moovibe-pipeline.SEUSUBDOMINIO.workers.dev'
$headers = @{ Authorization = "Bearer $env:MOOVIBE_ADMIN_TOKEN" }
Invoke-RestMethod -Uri "$workerUrl/admin/providers" -Headers $headers
Invoke-RestMethod -Method Post -Uri "$workerUrl/admin/recover-generation" `
  -Headers $headers -ContentType 'application/json' -Body '{"limit":3,"dry_run":true}'
# Opcional, após analisar o dry-run: altera jobs e envia mensagens à Queue.
Invoke-RestMethod -Method Post -Uri "$workerUrl/admin/recover-generation" `
  -Headers $headers -ContentType 'application/json' -Body '{"limit":3,"dry_run":false}'
```

O contador global continua valendo para o lote recuperado. Se o piloto do dia
já foi consumido, a recuperação não libera chamadas extras. Não apagar contadores
ou circuitos para contornar a proteção. Nada acima foi executado remotamente
durante a preparação desta migração.
