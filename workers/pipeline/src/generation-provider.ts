export interface GenerationRequest { system: string; prompt: string; schema: unknown; temperature?: number }
export interface GenerationResult { data: unknown; model: string; provider: string; usage?: { inputTokens?: number; outputTokens?: number } }
export interface GenerationProvider { readonly name: string; generateJson(input: GenerationRequest): Promise<GenerationResult> }
export const VIBE_DIMS = ['emotional_valence','energy','intimacy','surrealism','darkness','humor','romanticism','narrative_density','melancholy_level','tension_level'];
const PACES = new Set(['very_slow','slow','medium','fast','very_fast']);
const isNum01 = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;
const isStrArr = (v: unknown) => Array.isArray(v) && v.length > 0 && v.length <= 24 && v.every((s) => typeof s === 'string' && s.trim().length > 0 && s.trim().length <= 80);
export function validateEnrichment(data: any): { ok: boolean; error?: string } {
  if (!data || typeof data !== 'object') return { ok: false, error: 'enrichment must be an object' };
  for (const f of ['moods','themes','atmosphere','visual_style']) if (!isStrArr(data[f])) return { ok: false, error: 'invalid array: ' + f };
  if (!PACES.has(data.pace)) return { ok: false, error: 'invalid pace' };
  for (const d of [...VIBE_DIMS, 'confidence']) if (!isNum01(data[d])) return { ok: false, error: 'invalid dim: ' + d };
  return { ok: true };
}
export async function circuitState(db: D1Database, key: string) {
  try {
    const row = await db.prepare(`SELECT value FROM system_state WHERE key=?`).bind('circuit:' + key).first<{ value: string }>();
    if (!row?.value) return { open: false, until: null as string | null, reason: null as string | null };
    const v = JSON.parse(row.value);
    if (v.until && new Date(v.until).getTime() > Date.now()) return { open: true, until: v.until, reason: v.reason || null };
    return { open: false, until: null, reason: v.reason || null };
  } catch { return { open: false, until: null, reason: null }; }
}
export async function openCircuit(db: D1Database, key: string, delaySeconds: number, reason: string) {
  const until = new Date(Date.now() + Math.max(60, Math.min(43200, delaySeconds)) * 1000).toISOString();
  await db.prepare(`INSERT INTO system_state(key,value,updated_at) VALUES(?,?,CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP`).bind('circuit:' + key, JSON.stringify({ until, reason })).run();
}
export async function closeCircuit(db: D1Database, key: string) {
  try { await db.prepare(`DELETE FROM system_state WHERE key=?`).bind('circuit:' + key).run(); } catch { /* noop */ }
}
