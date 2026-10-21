# Auditoria de capacidade gratuita — 21/10/2026

Base local: `242e665` (posterior ao commit solicitado). O arquivo wrangler.jsonc já tinha uma alteração do usuário: piloto de 3 para 500. Ela foi preservada e não faz parte deste commit. Nenhuma credencial foi lida, alterada ou publicada. Não houve deploy, push, migração remota, chamadas Groq/Gemini ou consultas ao Vectorize.

## Resultado e impedimento para concluir o catálogo integralmente no Free

A documentação específica do [Vectorize](https://developers.cloudflare.com/vectorize/platform/pricing/) publica 5 milhões de dimensões armazenadas e 30 milhões de dimensões consultadas por mês no Free. A página geral de Workers continha informação divergente sobre disponibilidade; use a página específica e confirme o plano efetivo no painel.

Com 768 dimensões, 5.000.000 / 768 permite **6.510 vetores**, considerando a conta inteira. 7.000 vetores representam 5.376.000 dimensões; 18.000 representam 13.824.000. Logo, a estimativa fornecida já ultrapassa o armazenamento Free publicado. Não é possível prometer concluir 18 mil vetores preservando 768 dimensões dentro dessa franquia. Não foi removido nenhum vetor nem alterado o plano. Confirme contagem real e eventuais franquias específicas da conta. Na ausência de franquia suficiente, adie novas vetorizações; não habilite cobrança para concluir o catálogo.

O aviso de 75% não pôde ser atribuído a um produto sem o alerta e os gráficos da conta. Nenhum número remoto foi inferido do SQLite antigo local.

## Problemas e correções

- O piloto protegia tentativas diárias, mas não reservava tokens nem coordenava minutos entre isolates. A nova tabela `groq_capacity` usa UPSERT condicional atômico para uma reserva global antes de cada HTTP, inclusive retries. O contador atômico anterior continua sendo a autoridade final do teto administrativo.
- Uma chamada é espaçada por pelo menos 60 segundos. Isso evita bursts de fronteira entre janelas e permite até 1.440 admissões/dia, acima do RPD Free. Uma requisição cuja reserva não cabe no minuto aguarda revisão de contexto/limites em vez de provocar 429. Não se corta uma sinopse silenciosamente.
- RPD/TPD configurados, margem, reservas em aberto e limites menores recebidos em cabeçalhos restringem admissões. Cabeçalhos de requests representam RPD; os de tokens representam TPM. TPM observado menor também aumenta o intervalo. Limites configurados nunca ultrapassam os máximos Free de referência. Outros consumidores da organização precisam ter seu orçamento descontado na configuração; nenhum Worker consegue prever chamadas feitas por sistemas externos.
- O limite de espera de 24 horas truncava Retry-After maior. Removido no cliente Groq e no circuito Groq. Circuitos concorrentes continuam preservando a maior espera. Nenhum retry imediato ignora uma ordem do provedor.
- Novos enriquecimentos do cron recebem atrasos graduais. Esperas curtas são reenviadas como mensagens novas com delay, após persistência do adiamento em D1, sem consumir retries de Queue. Esperas longas permanecem no outbox. Se o envio falhar, o job continua recuperável em D1. Entregas duplicadas continuam possíveis pela semântica da Queue, mas claims, locks e idempotência impedem duplicação do enriquecimento.
- Na introdução do controle durante um dia com tentativas anteriores sem telemetria, o gate aguarda a próxima data UTC. Não transforma consumo desconhecido em orçamento disponível. HTTPs com uso desconhecido e reservas sem desfecho após crash não recebem devolução de tokens.
- O prompt remove campos vazios, espaços supérfluos e duplicatas em listas JSON. Preserva a sinopse inteira e os campos cinematográficos. Instruções estáveis continuam antes dos fatos variáveis, sem inserir identificadores aleatórios no prefixo.
- `MOVIE_GENERATION_MAX_COMPLETION_TOKENS` aceita 512..2048. O padrão continua **2048**: ainda não há distribuição real de respostas/reasoning que justifique reduzir esse teto sem risco de truncamento. Não se alegou equivalência qualitativa baseada em mocks.
- Polling automático dos dois painéis passou de 15 para 60 segundos; a proteção de aba invisível permanece. Isso reduz em 75% a frequência das requisições automáticas, sem equivaler necessariamente a 75% menos leituras na conta inteira. O cache de produtividade de 90 segundos já existia.
- Um índice parcial em `enriched_at` permite contar conclusões do dia sem escanear o catálogo completo.

## Telemetria administrativa

`GET /admin/providers`, com `Authorization: Bearer <ADMIN_TOKEN>`, inclui `generation.capacity`. Endpoint já autenticado, sem devolver secrets. Não é necessário fazer uma chamada ao provedor para consultar o estado.

Uma linha por dia UTC contém reservas, admissões, quantidade de amostras, prompt/completion/total/cached tokens, soma dos quadrados, histograma e categorias de erro. Cada desfecho grava todos os agregados em **um UPDATE**; não existe linha por token ou métrica. Há uma escrita adicional por admissão e uma por desfecho além do piloto anterior. Negativas do gate não alteram a linha.

O endpoint mostra média, desvio padrão, p50/p90/p95 aproximados pelos limites superiores dos buckets, estimativa restante, filmes enriquecidos persistidos hoje e jobs ENRICH_MOVIE adiados. Sucesso HTTP e filme efetivamente persistido são contagens diferentes. `errors` diferencia 429 de requests/tokens por minuto/dia quando o corpo permite, além de credencial, JSON inválido, transiente e desconhecido. A amostragem só inclui usage completo com inteiros válidos; falhas também podem conter usage e são medidas.

`reserved_tokens` inclui o total bruto das chamadas medidas e reservas conservadoras ainda não reconciliadas. Não é uma leitura oficial do consumo faturável ou dos contadores do provedor. Cached tokens são medidos separadamente; não se presume cache futuro nem se subtrai cache do orçamento local. A [Groq documenta](https://console.groq.com/docs/prompt-caching) que tokens em cache não contam nos rate limits, mas não garante hits. Assim, o gate pode parar antes do limite efetivo, deliberadamente. Cabeçalhos e 429 continuam sendo a informação externa autoritativa.

`d1_account_usage` é null: não há telemetria oficial da conta disponível neste Worker. Não foi inventado um contador global com base nas queries locais. O endpoint existente mantém contador administrativo e cooldown; a nova capacidade é uma estimativa de planejamento, não promessa de filmes concluídos.

## Configuração e capacidade estimada

A [Groq](https://console.groq.com/docs/rate-limits) publica para gpt-oss-120b: 30 RPM, 1.000 RPD, 8.000 TPM e 200.000 TPD. Os limites são por organização e podem diferir. O painel Limits fornece os valores reais; o hover de TPM pode revelar ITPM/OTPM separados. Os cabeçalhos incluem limites, saldo e reset de requests/tokens. Há espera de Retry-After nos 429.

Variáveis opcionais (strings no ambiente):

| Variável | Referência padrão |
| --- | --- |
| MOVIE_GENERATION_PILOT_LIMIT | teto administrativo existente; exemplo 750 |
| GROQ_RPM / GROQ_RPD | 30 / 1000 |
| GROQ_TPM / GROQ_TPD | 8000 / 200000 |
| GROQ_ITPM / GROQ_OTPM | ausentes quando a conta não tiver limites separados |
| GROQ_SAFETY_MARGIN | 0.10; faixa 0..0.95 |
| MOVIE_GENERATION_MAX_COMPLETION_TOKENS | 2048 |

Use valores menores se o Limits da organização ou outros clientes exigirem. Não configurar o máximo publicado como se a conta estivesse confirmada. A margem padrão produz 27 RPM, 900 RPD, 7.200 TPM e 180.000 TPD. Reserva por chamada usa bytes UTF-8 do payload + teto de completion + margem de framing; é uma estimativa conservadora, não um tokenizer oficial. Textos excessivos são adiados sem gerar HTTP.

Para teto 750, sem falhas e sem reservas desconhecidas, a capacidade teórica é `min(750, 900, floor(180000 / média bruta))`, sujeita ao orçamento por requisição, às outras integrações e às cotas Cloudflare/Gemini. Exemplos:

| Média bruta medida | Enriquecimentos/dia aproximados |
| --- | --- |
| 240 tokens | 750 |
| 400 tokens | 450 |
| 600 tokens | 300 |
| 1000 tokens | 180 |

O gate precisa reservar a próxima resposta inteira antes de admiti-la; portanto pode sobrar um saldo final abaixo dessa projeção. Falhas, usage ausente, cache, tempo de execução e backlog modificam o resultado. Os 436 filmes anteriores não revelam a média de tokens nem permitem identificar a categoria dos 429. O teto local de 500 foi mantido; não foi elevado automaticamente.

## Cloudflare: conferir cada produto separadamente

- [D1](https://developers.cloudflare.com/d1/platform/pricing/): Free publica 5 milhões de linhas lidas/dia, 100 mil escritas/dia e 5 GB totais. Abrir D1 > banco > Metrics > Row Metrics; conferir rows read/written, storage e janela UTC. Índices e atualizações de relações também têm impacto; número de SQLs não equivale a linhas faturadas.
- [Workers](https://developers.cloudflare.com/workers/platform/limits/): conferir requests diários, CPU e erros/exceções por Worker, incluindo Pages Functions e consumers. Conferir o limite aplicável a cada tipo de invocação, não somar esse orçamento a D1 ou Queues.
- [Queues](https://developers.cloudflare.com/queues/platform/pricing/): Free publica 10 mil operações/dia e retenção de 24h. Uma entrega pequena normalmente envolve escrita, leitura e exclusão; retries e DLQ aumentam operações. Conferir backlog, operações, entregas, retries e DLQ. 750 enriquecimentos + 750 embeddings já representam aproximadamente 4.500 operações, antes de discovery, fetch e adiamentos. O limite de 100 recuperações por ciclo e jobs canônicos existentes foram preservados.
- Vectorize: conferir dimensões armazenadas na conta e consumo mensal de consultas/inserções. Uma inserção também participa do cálculo de dimensões consultadas. Não confundir franquia mensal com diária. Conferir outros índices e o plano efetivo.

Os índices existentes cobrem estados de pipeline, recuperação e joins por chave canônica. Discovery V2 já usa partições temporais, seed diferencial e budgets de 1 histórico + 1 recente por cron, evitando o produto país × gênero × década. `replaceRelations` ainda envolve várias escritas por filme; não se removeu integridade nem histórico para economizar. O resumo de produtividade ainda agrega o catálogo inteiro em cache; múltiplos isolates podem refazer a consulta. O estado persistente da capacidade não exige essa varredura.

Diagnóstico sem rede: `node scripts/free-quota-audit.mjs <snapshot-sqlite-local>`. Abre arquivo explicitamente em modo somente leitura, mostra disponibilidade de tabelas, contagens e EXPLAIN QUERY PLAN. A execução em `moovibe_library.db` confirmou um esquema legado sem os estados atuais e sem pipeline_jobs/groq_capacity; esse arquivo não representa produção. Os testes usam SQLite em memória e todas as migrations; a migration 0007 foi preparada, não aplicada remotamente.

## Integridade do catálogo e verificações manuais pendentes

O defeito de marcar filmes completos antes de salvar relações **já estava corrigido** em fetchMovie: detalhes, relações, só então collection_status=complete. O teste de falha parcial existente continua cobrindo esse comportamento. Não foi feita regeneração, backfill ou recuperação automática de jobs terminais. Locks, hashes, modelo Gemini, dimensão 768 e histórico permanecem.

Para explicar os 429 de 21/10, consultar no Groq Usage/Logs os horários, corpo completo do erro, tipo RPM/RPD/TPM/TPD e headers, se disponíveis. Sem esses registros não é possível atribuir retrospectivamente cada erro. A telemetria nova torna essa distinção possível nas execuções futuras.

Antes de ativar qualquer versão em produção, conferir manualmente: Groq Billing/plan Free e Limits reais da organização/modelo; Gemini projeto com billing desativado e quota gratuita efetiva de gemini-embedding-2; Cloudflare subscriptions/Workers plan e métricas de cada produto acima. Valores monetários em Usage podem ser estimativas equivalentes, não faturas; conferir invoices/transactions e plano separadamente. Não existe API de verificação de plano implementada aqui. Nenhum serviço pago, Batch, Flex ou alteração de billing foi habilitado.

## Validação

Testes determinísticos usam HTTP simulado e SQLite em memória: concorrência global, diário/minuto, orçamento zero, TPD, limites independentes, reset UTC, usage/cached tokens, uso desconhecido, falha de D1, espera longa, JSON inválido, bootstrap com consumo anterior e fixtures de filmes em português, japonês, francês e inglês, com sinopses curtas/longas/ausentes. As fixtures verificam preservação de fatos/schema e compactação; não constituem avaliação de qualidade cinematográfica de respostas reais. Os testes de pipeline continuam cobrindo locks, idempotência, recuperação explícita, embeddings, falhas de persistência e isolamento da Queue. Não houve teste de produção autorizado.

Resultado final: `npm run check` aprovado (TypeScript + 348 testes, 22 arquivos). `git diff --check` aprovado. O diagnóstico local foi executado sem rede e confirmou que o SQLite legado não permite auditar o estado remoto. Comparação de prompts foi estrutural e determinística; não houve validação empírica de qualidade com o modelo real.
