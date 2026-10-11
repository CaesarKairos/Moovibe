export type DiscoveryLane = 'historical' | 'recent';
export type PipelineControl = {
  historical_enabled: boolean;
  recent_enabled: boolean;
  updated_at: string | null;
  updated_by: string | null;
};

export const PIPELINE_CONTROL_KEY = 'pipeline_control';
const defaults: PipelineControl = {
  historical_enabled: true,
  recent_enabled: true,
  updated_at: null,
  updated_by: null
};

export async function readPipelineControl(db: D1Database): Promise<PipelineControl> {
  const row = await db.prepare(`SELECT value,updated_at FROM system_state WHERE key=?`).bind(PIPELINE_CONTROL_KEY).first<{ value: string; updated_at: string }>();
  if (!row) return { ...defaults };
  try {
    const value = JSON.parse(row.value);
    return {
      historical_enabled: value.historical_enabled !== false,
      recent_enabled: value.recent_enabled !== false,
      updated_at: value.updated_at || row.updated_at || null,
      updated_by: value.updated_by || null
    };
  } catch {
    return { ...defaults };
  }
}

export async function updatePipelineControl(db: D1Database, patch: Partial<Pick<PipelineControl, 'historical_enabled' | 'recent_enabled'>>, updatedBy = 'admin') {
  const current = await readPipelineControl(db);
  const next = { ...current, ...patch };
  if (next.historical_enabled === current.historical_enabled && next.recent_enabled === current.recent_enabled) return { changed: false, previous: current, control: current };
  const updated_at = new Date().toISOString(),
    control = { ...next, updated_at, updated_by: updatedBy };
  await db.prepare(`INSERT INTO system_state(key,value,updated_at) VALUES(?,?,CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP`).bind(PIPELINE_CONTROL_KEY, JSON.stringify(control)).run();
  return {
    changed: true,
    previous: current,
    control: await readPipelineControl(db)
  };
}

export const discoveryLaneFromParams = (params: unknown): DiscoveryLane => {
  try {
    const value = typeof params === 'string' ? JSON.parse(params) : params;
    return value && typeof value === 'object' && (value as any).lane === 'recent' ? 'recent' : 'historical';
  } catch {
    return 'historical';
  }
};

export const laneEnabled = (control: PipelineControl, lane: DiscoveryLane) => (lane === 'recent' ? control.recent_enabled : control.historical_enabled);

export async function queryDiscoveryLane(db: D1Database, queryId: string): Promise<DiscoveryLane | null> {
  const row = await db.prepare(`SELECT params_json FROM collection_queries WHERE query_id=? AND is_executable=1`).bind(queryId).first<{ params_json: string }>();
  return row ? discoveryLaneFromParams(row.params_json) : null;
}
