# Top 50 Global

O endpoint público `GET /top-global` lê apenas o último snapshot publicado no KV. A identidade da faixa no ranking é o ID do Spotify. O D1 mantém as posições, os movimentos e as associações quando uma faixa sai da lista.

## Acesso à fonte

- A [playlist oficial](https://open.spotify.com/playlist/37i9dQZEVXbMDoHDwVN2tF) é a referência padrão. O botão **Testar acesso Spotify** no painel autenticado consulta os endpoints oficiais com as credenciais existentes, retornando somente status e presença de um item.
- Se autorizado a publicar uma exportação do [Spotify Charts](https://charts.spotify.com/charts/view/regional-global-daily/latest), importe as primeiras 50 posições do ranking diário global e use `source: "charts"`. O site atribui essa fonte ao snapshot.
- Kworb exibe publicamente o ranking, mas a permissão de extração automatizada e redistribuição não foi confirmada. Clientes comunitários que interceptam chamadas internas do Spotify Charts não substituem uma autorização de acesso.

## Importação

No painel autenticado, abra **TOP 50 GLOBAL**, informe a data de referência e as 50 posições ordenadas e confirme a autorização para armazenar e publicar os dados. Exemplo de estrutura com uma posição ilustrativa:

```json
{
  "source": "playlist",
  "reference_date": "2026-01-01",
  "tracks": [
    {
      "position": 1,
      "spotify_id": "0000000000000000000001",
      "title": "Nome da faixa",
      "artist": "Nome do artista",
      "lrclib_id": "123"
    }
  ]
}
```

O `lrclib_id` é opcional e deve representar a mesma gravação. A geração verifica a identidade no LRCLIB e passa ao Gemini somente os dados da fonte independente. Capas do Spotify são opcionais e devem ter permissão de exibição.

A importação e a geração são ações separadas. O processamento é manual e limitado a uma tentativa por dia UTC na configuração de produção. Cada tentativa processa uma faixa, e o orçamento é registrado antes de chamar os provedores. Não há cron de ranking sem uma fonte autorizada nem reserva de cota compartilhada com o pipeline. A configuração `TOP_GLOBAL_DAILY_ATTEMPTS=0` desabilita as chamadas deste recurso.

Antes de publicar o Pages, aplique as migrations pendentes ao D1. Se o D1 recusar uma importação ou publicação, o snapshot público anterior permanece no KV.
