/**
 * Moovibe - Módulo compartilhado de integração com o LRCLIB.
 *
 * O prefixo `_` no diretório faz o Cloudflare Pages ignorar este arquivo
 * como rota, então ele pode ser importado com segurança por outras functions.
 */

const LRCLIB_URL = 'https://lrclib.net/api';
const LRCLIB_GET_URL = `${LRCLIB_URL}/get`;
const LRCLIB_SEARCH_URL = `${LRCLIB_URL}/search`;

const LRCLIB_THROTTLE_MS = 250;
const MOOVIBE_VERSION = '1.0';
const MOOVIBE_USER_AGENT = `Moovibe/${MOOVIBE_VERSION} (mailto:cesarbatistasantos08@gmail.com)`;

let lrclibLastRequest = 0;

export function lrclibThrottle() {
  const now = Date.now();
  const wait = Math.max(0, LRCLIB_THROTTLE_MS - (now - lrclibLastRequest));
  lrclibLastRequest = now + wait;
  return wait > 0 ? new Promise(resolve => setTimeout(resolve, wait)) : Promise.resolve();
}

export function lrclibHeaders() {
  return {
    'User-Agent': MOOVIBE_USER_AGENT,
    'X-User-Agent': MOOVIBE_USER_AGENT,
  };
}

export { LRCLIB_URL, LRCLIB_GET_URL, LRCLIB_SEARCH_URL };