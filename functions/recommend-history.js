/**
 * Moovibe - History/Storage helper
 * Reads/writes previous recommendations so the Hall of Fame can be rendered.
 *
 * Default implementation uses an in-memory array. On Cloudflare Pages KV,
 * swap the implementation to read/write MOOVIBE_DB while keeping the same
 * function signatures below.
 */

let memoryStore = [];

function listItems() {
  return memoryStore.slice().reverse();
}

function addItem(payload) {
  memoryStore.push(payload);
  if (memoryStore.length > 500) {
    memoryStore = memoryStore.slice(memoryStore.length - 500);
  }
}

export async function storeRecommendation(payload) {
  addItem(payload);
}

export async function listRecommendations() {
  return listItems();
}