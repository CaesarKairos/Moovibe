/**
 * Moovibe - Preview rico de links compartilhados (Open Graph dinâmico).
 *
 * Rota /share/{slug}: quando um crawler de rede social acessa o link,
 * esta function busca os dados da recomendação no KV e substitui as meta
 * tags OG/Twitter no index.html pelos dados reais do filme.
 */
const SITE_URL = 'https://moovibe.pages.dev';

// Usa códigos numéricos de entidade HTML (&#38; etc.) para que o formatter
// não converta de volta para caracteres literais, quebrando o escape.
function escaparHtml(texto) {
  if (typeof texto !== 'string') return '';
  return texto
    .replace(/&/g, '&#38;')
    .replace(/</g, '&#60;')
    .replace(/>/g, '&#62;')
    .replace(/"/g, '&#34;');
}

export async function onRequestGet(context) {
  const { request, env, params } = context;
  const slug = params && params.slug ? String(params.slug) : '';
  if (!slug) {
    // Sem slug, serve o index.html normal
    try {
      const resp = await env.ASSETS.fetch(request);
      return new Response(resp.body, {
        status: resp.status,
        headers: { 'Content-Type': 'text/html' },
      });
    } catch (err) {
      return new Response('Not found', { status: 404 });
    }
  }

  let shareData = null;
  try {
    const kv = env.MOOVIBE_DB;
    if (kv) {
      shareData = await kv.get('share:' + slug, 'json');
    }
  } catch (err) {
    console.error('[SHARE-OG] Falha ao ler KV:', err);
    shareData = null;
  }

  if (!shareData) {
    // Link não encontrado: serve o app normalmente (o JS mostra a mensagem de erro)
    try {
      const resp = await env.ASSETS.fetch(request);
      return new Response(resp.body, {
        status: resp.status,
        headers: { 'Content-Type': 'text/html' },
      });
    } catch (err) {
      return new Response('Not found', { status: 404 });
    }
  }

  // Busca o index.html estático via binding ASSETS
  const indexResp = await env.ASSETS.fetch(request);
  let html = await indexResp.text();

  // Dados da recomendação
  const movie = shareData.movie || {};
  const song = shareData.song || '';
  const artist = shareData.artist || '';
  const tituloFilme = movie.title || 'Moovibe';
  const anoFilme = movie.release_year || '';
  const poster = movie.poster_url || '';
  const ogImage = poster || `${SITE_URL}/images/og-image.png`;

  // Descrição: usa um resumo curto da sinopse ou da explicação da IA
  let descricao = movie.synopsis || '';
  if (!descricao || descricao === 'Sem sinopse disponivel.') {
    const ai = movie.ai_explanation || '';
    descricao = ai.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  }
  if (!descricao) {
    descricao = `O Moovibe conectou a música "${song}" de ${artist} ao filme ${tituloFilme}${anoFilme ? ` (${anoFilme})` : ''}.`;
  }
  descricao = descricao.substring(0, 300);

  const ogTitle = `${tituloFilme}${anoFilme ? ` (${anoFilme})` : ''} — Moovibe`;
  const shareUrl = `${SITE_URL}/share/${encodeURIComponent(slug)}`;

  // Substituição simples de string nas tags existentes (Tarefa 2)
  const substituicoes = [
    [/<title>[^<]*<\/title>/i, `<title>${ogTitle}</title>`],
    [/<meta property="og:title" content="[^"]*"/i, `<meta property="og:title" content="${escaparHtml(ogTitle)}"`],
    [/<meta property="og:description" content="[^"]*"/i, `<meta property="og:description" content="${escaparHtml(descricao)}"`],
    [/<meta property="og:url" content="[^"]*"/i, `<meta property="og:url" content="${shareUrl}"`],
    [/<meta property="og:image" content="[^"]*"/i, `<meta property="og:image" content="${escaparHtml(ogImage)}"`],
    [/<meta name="twitter:title" content="[^"]*"/i, `<meta name="twitter:title" content="${escaparHtml(ogTitle)}"`],
    [/<meta name="twitter:description" content="[^"]*"/i, `<meta name="twitter:description" content="${escaparHtml(descricao)}"`],
    [/<meta name="twitter:image" content="[^"]*"/i, `<meta name="twitter:image" content="${escaparHtml(ogImage)}"`],
    [/<link rel="canonical" href="[^"]*"/i, `<link rel="canonical" href="${shareUrl}"`],
  ];

  for (const [pattern, replacement] of substituicoes) {
    html = html.replace(pattern, replacement);
  }

  return new Response(html, {
    status: 200,
    headers: { 'Content-Type': 'text/html' },
  });
}