export interface GenerationRequest { system: string; prompt: string; schema: unknown; temperature?: number }
export interface GenerationResult { data: unknown; model: string; provider: string; usage?: { inputTokens?: number; outputTokens?: number } }
export interface GenerationProvider { readonly name: string; generateJson(input: GenerationRequest): Promise<GenerationResult> }
export const VIBE_DIMS = ['emotional_valence','energy','intimacy','surrealism','darkness','humor','romanticism','narrative_density','melancholy_level','tension_level'];
export const PACE_VALUES = ['very_slow','slow','medium','fast','very_fast'] as const;
export const ENRICHMENT_JSON_SCHEMA = {
  type: 'object',
  properties: {
    moods: { type: 'array', items: { type: 'string', minLength: 1, maxLength: 80 }, minItems: 1, maxItems: 24 },
    themes: { type: 'array', items: { type: 'string', minLength: 1, maxLength: 80 }, minItems: 1, maxItems: 24 },
    atmosphere: { type: 'array', items: { type: 'string', minLength: 1, maxLength: 80 }, minItems: 1, maxItems: 24 },
    visual_style: { type: 'array', items: { type: 'string', minLength: 1, maxLength: 80 }, minItems: 1, maxItems: 24 },
    pace: { type: 'string', enum: [...PACE_VALUES] },
    emotional_valence: { type: 'number', minimum: 0, maximum: 1 },
    energy: { type: 'number', minimum: 0, maximum: 1 },
    intimacy: { type: 'number', minimum: 0, maximum: 1 },
    surrealism: { type: 'number', minimum: 0, maximum: 1 },
    darkness: { type: 'number', minimum: 0, maximum: 1 },
    humor: { type: 'number', minimum: 0, maximum: 1 },
    romanticism: { type: 'number', minimum: 0, maximum: 1 },
    narrative_density: { type: 'number', minimum: 0, maximum: 1 },
    melancholy_level: { type: 'number', minimum: 0, maximum: 1 },
    tension_level: { type: 'number', minimum: 0, maximum: 1 },
    confidence: { type: 'number', minimum: 0, maximum: 1 }
  },
  required: ['moods','themes','atmosphere','visual_style','pace','emotional_valence','energy','intimacy','surrealism','darkness','humor','romanticism','narrative_density','melancholy_level','tension_level','confidence'],
  additionalProperties: false
};
const PACES = new Set<string>(PACE_VALUES as unknown as string[]);
const isNum01 = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;
const isStrArr = (v: unknown) => Array.isArray(v) && v.length > 0 && v.length <= 24 && v.every((s) => typeof s === 'string' && s.trim().length > 0 && s.trim().length <= 80);
export function validateEnrichment(data: any): { ok: boolean; error?: string } {
  if (!data || typeof data !== 'object') return { ok: false, error: 'enrichment must be an object' };
  for (const f of ['moods','themes','atmosphere','visual_style']) if (!isStrArr(data[f])) return { ok: false, error: 'invalid array: ' + f };
  if (!PACES.has(data.pace)) return { ok: false, error: 'invalid pace' };
  for (const d of [...VIBE_DIMS, 'confidence']) if (!isNum01(data[d])) return { ok: false, error: 'invalid dim: ' + d };
  return { ok: true };
}
export type CircuitStatus = { open: boolean; until: string | null; reason: string | null; unknown: boolean };
export async function circuitState(db: D1Database, key: string): Promise<CircuitStatus> {
  try {
    const row = await db.prepare(`SELECT value FROM system_state WHERE key=?`).bind('circuit:' + key).first<{ value: string }>();
    if (!row?.value) return { open: false, until: null, reason: null, unknown: false };
    const v = JSON.parse(row.value);
    if (v.until && new Date(v.until).getTime() > Date.now()) return { open: true, until: v.until, reason: v.reason || null, unknown: false };
    return { open: false, until: null, reason: v.reason || null, unknown: false };
  } catch { return { open: true, until: null, reason: 'circuit state unreadable (D1); fail-closed', unknown: true }; }
}
export async function openCircuit(db: D1Database, key: string, delaySeconds: number, reason: string) {
  const until = new Date(Date.now() + Math.max(60, Math.min(key === 'generation-groq' ? 86400 : 43200, delaySeconds)) * 1000).toISOString();
  if (key === 'generation-groq') {
    // Concurrent token/minute failures must never shorten a daily cooldown.
    await db.prepare(`INSERT INTO system_state(key,value,updated_at) VALUES(?,?,CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP
      WHERE CASE WHEN json_valid(system_state.value) THEN COALESCE(json_extract(system_state.value,'$.until'),'')<json_extract(excluded.value,'$.until') ELSE 1 END`)
      .bind('circuit:' + key, JSON.stringify({ until, reason })).run();
    return;
  }
  try {
    const cur = await db.prepare(`SELECT value FROM system_state WHERE key=?`).bind('circuit:' + key).first<{ value: string }>();
    if (cur?.value) {
      try {
        const v = JSON.parse(cur.value);
        if (v.until && new Date(v.until).getTime() >= new Date(until).getTime() - 1000 && v.reason === reason) return;
      } catch { /* overwrite corrupt state */ }
    }
  } catch { /* still attempt the write */ }
  await db.prepare(`INSERT INTO system_state(key,value,updated_at) VALUES(?,?,CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP`).bind('circuit:' + key, JSON.stringify({ until, reason })).run();
}
export async function closeCircuit(db: D1Database, key: string) {
  try { await db.prepare(`DELETE FROM system_state WHERE key=?`).bind('circuit:' + key).run(); } catch { /* noop */ }
}
