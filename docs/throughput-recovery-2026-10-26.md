> Atualiza??o posterior, por solicita??o do usu?rio: o wrangler agora configura `GROQ_CAPACITY_MODE=provider` e `QUEUE_LOCAL_ADMISSION_ENABLED=false`. Os gates estimados locais de RPM/TPM/TPD e opera??es da Queue est?o desativados; os contadores continuam como telemetria. Permanecem o teto de 800 tentativas, idempot?ncia, locks, leases e circuitos por resposta real 429/10253. A suspens?o autom?tica de descoberta por volume de backlog tamb?m fica desativada nesse modo. O servi?o Free passa a ser a autoridade de quota; a estimativa local n?o garante saldo global nem confirma o plano contratado. A descri??o abaixo registra a implementa??o anterior dos gates, ainda dispon?vel no modo local.

# Throughput e recuperação de falhas

## Evidência e limites do diagnóstico

Auditados os commits `93e479b`, `47a8b8f` e os caminhos `schedule`, `publishJob`, `recoverJobs`, `processJob`, `recoverGenerationBacklog`, Groq e Control Room.

Não foi possível identificar o gargalo **efetivo da produção**: a consulta remota somente de leitura foi recusada pela Cloudflare com `7403` (conta inválida ou sem autorização). Não houve tentativa de contornar essa recusa. O comando local `node scripts/free-quota-audit.mjs moovibe_library.db` encontrou esquema legado, sem `pipeline_jobs`, `queue_transport` ou `groq_capacity`. Nenhuma conclusão sobre consumo remoto foi inferida do número de filmes.

Problemas demonstráveis no código anterior:

- `spacing()` impunha 60 s inclusive quando RPM/TPM comportavam concorrência. O scheduler também adicionava atrasos de 60 s.
- Admissões negadas voltavam ao outbox D1 e só eram republicadas no cron de 15 minutos. Uma reserva grande por janela, com entregas agrupadas, podia resultar em cerca de quatro admissões/hora, antes de qualquer limite diário.
- Cada publicação reservava seis operações do teto local de 6.000: máximo teórico de 1.000 publicações/dia. Isso não era consumo medido da conta.
- A reserva de operações vinha antes do claim de publicação: dois produtores concorrentes podiam consumir orçamento para um único envio.
- `recoverGenerationBacklog` incrementava `requeued` independentemente do resultado de publicação.
- Leases de execução abandonados repetidamente não respeitavam o teto de tentativas na recuperação.

## Mudanças

A migration **0009** acrescenta reservas Groq individuais, histórico de tentativas, contadores agregados, conclusões únicas, estados de publicação e lotes de recuperação. Precisa ser aplicada antes do Worker novo; não foi aplicada remotamente. Leases legados são preservados: não existe evidência suficiente para declarar mensagens antigas perdidas.

Admissão Groq é um `INSERT ... SELECT` condicional com trigger na mesma transação, incluindo a janela móvel de 60 s e o orçamento diário. As chamadas concorrentes disputam o mesmo orçamento D1. A janela atravessa a meia-noite. O teto administrativo é de no máximo 800 tentativas, inclusive quando uma variável solicita mais. Configuração permite apenas reduzir os máximos Free de referência. A margem padrão continua 10%.

O planejamento usa média medida mais dois desvios padrão, com piso de 2.304 tokens. A autorização efetiva continua reservando bytes UTF-8 do corpo + máximo de completion + framing; médias nunca autorizam uma chamada que não caiba nessa reserva conservadora. O `usage` real reconcilia o dia uma única vez, atomicamente com a telemetria. A janela do minuto conserva a reserva até expirar. Uso desconhecido mantém a reserva. Não se reduziu completion nem se truncou contexto para produzir números melhores.

TPM e RPD observados podem reduzir a configuração. Saldo diário observado fica em `server_daily_ceiling`, separado do limite permanente da organização: saldo zero hoje não limita todos os próximos dias a uma chamada. Cooldowns, Retry-After e limites menores persistem. Uma negativa local grava o motivo exato e a validade do diagnóstico, sem executar HTTP.

O cron passa a executar por minuto, mas só faz a varredura completa/descoberta a cada 15 minutos. Nos demais minutos repara o outbox e leases de execução. A recuperação evita publicar enriquecimentos com circuito aberto ou orçamento diário indisponível. Backlog durável de 200 jobs úteis suspende novas descobertas. Isso adiciona leituras locais ao D1: há até 1.440 invocações de cron/dia, não 1.440 varreduras completas do catálogo. O histórico de tentativas usa contadores transacionais agregados para evitar varrê-lo a cada abertura do painel.

Queue reserva três operações padrão por mensagem pequena, até 8.000/dia, mantendo 2.000 operações de margem da franquia de 10.000. Não equivale a medição global: retries inesperados, DLQ e outros produtores consomem a mesma conta. A proteção definitiva contra esgotamento continua sendo o serviço Free e o circuito `10253`; nenhum plano é alterado. Não existe garantia de saldo global se outros sistemas consumirem a franquia sem coordenação.

O claim precede a cobrança local. Antes de cruzar a fronteira de rede, o envio é marcado como ambíguo por retenção + 5 minutos, protegendo crashes após `send`. Confirmação muda para `awaiting_delivery`. Rejeição explícita `10253` libera o lease de publicação e bloqueia envios até a próxima meia-noite UTC + 5 minutos. Erro de rede ambíguo conserva a proteção por retenção. Um claim anterior à tentativa de rede expira em cinco minutos. Tokens de publicação impedem que uma entrega obsoleta libere o lease de uma mensagem nova. Claims de execução e locks por filme continuam obrigatórios.

Não há solução atômica entre D1 e Queue: uma falha na fronteira de rede pode representar envio aceito ou não aceito. Reenviar cedo essa mensagem ambígua sacrificaria a proteção contra duplicação. Esse caso permanece explicitamente visível no painel. Leases expirados voltam ao outbox. Jobs em cooldown não geram retries repetidos da Queue.

Não foram fundidas novas etapas. `INDEX_MOVIE` já executa enriquecimento e embedding na mesma mensagem, com checks de etapas concluídas; expandir isso sem medir CPU, subrequests e duração reais poderia degradar o plano Free. As etapas separadas e seus hashes foram preservados; um mutex de embedding por filme impede chamadas simult?neas de INDEX e EMBED para o mesmo documento.

## Recuperação e contabilidade

**RECUPERAR FALHAS** mostra agrupamento por etapa/código, erro original, datas, tentativas e últimos 20 registros históricos. O diagnóstico é read-only. O lote padrão é 25, máximo 50 no cliente e servidor, com confirmação explícita antes da escrita. Falhas de credencial/configuração e filmes já completos são inelegíveis. Recuperação revalida cada job e muda apenas jobs terminais elegíveis; nenhuma chamada publica milhares de mensagens, nem cria lotes seguintes automaticamente.

Um lote identifica seus jobs no D1 e mostra recuperados, jobs concluídos, novamente falhados e pendentes. O cron normal publica o trabalho respeitando os mesmos gates. Atualização de resultados é manual ou pelo polling do painel; não dispara recuperação. `recovered` significa intenção persistida; `completed` exige `status=done`. Conclusões de jobs são separadas de conclusões únicas de filmes, que exigem as três etapas completas. Repetir um POST ou receber mensagens duplicadas não cria filmes ou tentativas de execução adicionais.

Ao concluir embedding, o estado de coleta em erro é reparado somente se há `details_fetched_at`. A conclusão única preserva indicação de recuperação quando há falha anterior registrada. Erros de jobs antigos não fazem um filme integralmente concluído continuar contado como filme em erro.

Histórico anterior à migration não pode ser reconstruído: preservamos o erro terminal original e o contador de tentativas existente como snapshot legado. Contagens exatas de tentativas/falhas/sucessos passam a valer a partir da migration; não se inventa o desfecho de cada tentativa antiga. Reset de `attempts` reinicia apenas o orçamento do ciclo, não apaga o histórico.

O painel diferencia cron ativo de conclusão real, mostra filmes concluídos hoje (São Paulo), ritmo na última hora, projeção simples de 24 h, motivos de bloqueio, jobs prontos, leases, cooldowns, cotas, terminais, tokens medidos e operações locais estimadas. Consumidores ausentes não são presumidos: `consumer_status` continua desconhecido sem métricas da conta; jobs prontos sem execução são apenas evidência de ausência de progresso.

## Comparação quantitativa reproduzível

| Cenário sintético | Anterior | Novo |
| --- | ---: | ---: |
| 100 reservas simultâneas de 1.000 tokens, 7.200 TPM | 1 admitida | 7 admitidas |
| Mesmo cenário, dez janelas de um minuto | 10 | 70 |
| Espera de retomada de um job adiado pelo gate local | até 15 min | aproximadamente 1 min + execução |
| Teto teórico de publicações pelo orçamento local | 6.000 / 6 = 1.000 | floor(8.000 / 3) = 2.666 |
| Reserva local gasta por produtor que perdeu o claim | até 6 | 0 |

São ganhos de admissão/transporte, não benchmark de filmes reais. O teste mantém 70.000 tokens reservados ao admitir 70 chamadas: nenhum ganho resulta de ignorar o custo.

O limite inevitável continua `min(800, RPD efetivo, floor(TPD disponível / média real))`, com saldo suficiente para reservar a próxima chamada inteira, outras franquias e falhas. Com 180.000 TPD locais: média de 400 tokens permitiria aproximadamente 450 chamadas; 600 → 300; 1.000 → 180; 3.000 → 60. Para superar 400 enriquecimentos/dia, a média precisa ficar abaixo de aproximadamente 450 tokens, ou existir franquia gratuita efetiva diferente documentada na organização. Não se promete recuperar 400/dia alterando apenas RPM.

Referências verificadas: [Groq rate limits](https://console.groq.com/docs/rate-limits), [Queues pricing](https://developers.cloudflare.com/queues/platform/pricing/), [Queues limits](https://developers.cloudflare.com/queues/platform/limits/). Os cabeçalhos/contadores da organização e métricas da conta ainda precisam confirmar os limites e o gargalo remoto; os números publicados não comprovam o plano da conta.

## Validação e escopo

Testes com SQLite e HTTP simulado cobrem RPM/TPM concorrentes, RPD/TPD, rollover, cooldown/429, reconciliação idempotente, desconhecimento de usage, erro de D1, `10253`, reset da Queue, backlog de centenas, mensagens perdidas, leases expirados, tokens obsoletos, publicação ambígua, duplicatas, recuperação limitada, confirmação/autenticação, estado final do filme, preservação de erros, falha repetida com teto de retries e contagem de filmes únicos.

`npm run check` e `git diff --check` são as verificações finais. Também foi validada a sintaxe do script gerado do Control Room. Não houve deploy, push, migration remota, geração/embedding real, mudança de billing ou recuperação remota. A única tentativa de acesso remoto foi a consulta de leitura recusada com `7403`.
