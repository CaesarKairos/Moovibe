# Moovibe operations

Private administration is served dynamically by Pages Functions and requires two independent secrets: a non-public path value and the existing admin credential. The credential is exchanged server-side for a signed, 12-hour, `HttpOnly`, `Secure`, `SameSite=Strict` cookie. Never commit either value.

Detailed AI traces are emitted as sanitized structured `ai_trace` events to Cloudflare Workers Logs. Their retention follows the limited retention of the Cloudflare plan; prompts and responses are deliberately not copied to D1. The permanent administrative history uses only compact rows in `recommendation_events`.

The Analytics Engine binding `MOOVIBE_ANALYTICS` receives privacy-preserving aggregate events independently of AI logging and degrades gracefully when unavailable. No telemetry stores raw IP addresses or browser fingerprints. The project does not require R2 or an object-storage subscription.

Apply the D1 migrations before deploying Pages. The migrations add the persistent song library, lyric/profile cache, and the low-volume recommendation ledger. They do not alter migrations `0001` or `0002`.

The dashboard is read-only. Pipeline mutation endpoints remain separate Worker tools protected by `ADMIN_TOKEN`.

## Gemini Control Center

The `09 / CENTRAL DE IA` dashboard section reads the last persisted health snapshot during normal polling; opening the tab and its 15-second refresh never probe Gemini. **VERIFICAR PAGES** and **VERIFICAR WORKER** are independent explicit actions. Each tests generation and embedding only in its selected runtime, has its own 60-second cooldown, and does not block a check of the other runtime. Results become visibly stale after 15 minutes and the compact snapshot/history is retained in KV for 30 days.

Configure these values without committing credentials:

- Pages secret: `GEMINI_API_KEY`.
- Worker secret: `GEMINI_API_KEY`.
- Worker secret: `ADMIN_TOKEN`.
- Pages secret: `PIPELINE_ADMIN_TOKEN`, with the same value as the Worker's `ADMIN_TOKEN`.
- Pages variable: `PIPELINE_WORKER_URL`, containing the Pipeline Worker HTTPS origin.
- Optional public labels: `GEMINI_PROJECT_LABEL` in each deployment.

Candidate keys can be tested from the dashboard after the administrator re-enters the Admin Key. They are held only for that request, are not logged or persisted, and are cleared from the form after the response. Rotation deliberately remains manual because automating Pages secret changes would require broad Cloudflare project-write credentials in the application.

```powershell
npx wrangler pages secret put GEMINI_API_KEY --project-name moovibe
npx wrangler secret put GEMINI_API_KEY --config workers/pipeline/wrangler.jsonc
```

After a manual change, use the corresponding runtime's verification button. A successful minimal check does not prove that long production workloads will fit within provider quotas. Network, timeout, Worker URL, and Pages-to-Worker authentication failures are reported as communication/configuration failures, never as proof that the Gemini credential itself is invalid.

The dashboard has one navigation/render controller and one active-tab polling timer. Navigation aborts obsolete requests and ignores late responses by generation number. Polling patches only the live region when data changes, preserving an open drawer, focus, scroll position, selected productivity period, search, filters, and pagination. No `MutationObserver` is used to repair replaced markup.

## Recommendation diversity

Apply migration `0006_recommendation_diversity.sql` before deploying the matching Pages code. It adds a nullable `music_key` to the existing `recommendation_events` ledger and one composite history index; it performs no backfill and does not alter old rows.

Each successful new recommendation still writes one `recommendation_events` row. There is no additional history-row write. The row now carries a SHA-256 key derived from sorted canonical song identities. Indexed aggregate queries return only the 10 most recently seen distinct primary TMDb IDs for the combination and the 20 most recently seen distinct primary IDs globally.

The combination-specific window is a strong primary exclusion while at least three eligible catalog candidates remain. Global recency applies a deterministic penalty of at most `0.025` after the hybrid score, without changing the numeric/semantic/concept/quality weights. If the specific window exhausts the slate, the oldest exclusions are relaxed first and the immediately previous primary remains prohibited whenever three candidates can still be formed.

History reads and writes are best-effort: a D1 quota or availability failure is emitted as `recommendation_history_degraded`, while the recommendation continues without claiming that diversity was enforced. Candidate logs also include history availability, excluded and penalized counts, profile/embedding cache hits, whether restrictions were relaxed, and confirmation of a new curation.

Two simultaneous requests can read the same pre-write history and may still choose the same film. D1 persistence substantially reduces repetition across requests, instances, deploys, and days, but this design intentionally avoids locks and extra coordination writes.

Final recommendation responses are no longer cached or replayed. Lyrics, acoustic features, profiles, individual and multi-song combination embeddings, TMDb hydration, posters, and stills remain cached. Share payloads remain immutable reads, and new share slugs include the recommendation request identifier so later interpretations cannot overwrite an earlier share.

## Control Room pipeline productivity

The Overview derives discovery, completed detail sheets, enrichment, and vectorization counts directly from `movies.created_at`, `details_fetched_at`, `enriched_at`, and `embedded_at`. “Today” uses the calendar day in `America/Sao_Paulo`; the 24-hour and 7-day choices are moving windows. JavaScript calculates timezone-aware UTC boundaries and D1 receives semi-open `>= ? AND < ?` comparisons.

One read-only aggregate query produces all three windows and the seven daily chart buckets. Its in-memory result is shared by concurrent requests and cached for 90 seconds, so the 15-second dashboard polling does not repeatedly scan `movies`. No KV/D1 cache writes, triggers, timestamp indexes, jobs, external APIs, Gemini calls, or Vectorize operations are involved. `EXPLAIN QUERY PLAN` reports a single `SCAN movies`; adding four timestamp indexes would increase every pipeline write and would not help this multi-column aggregate enough to justify a migration.

Zero is displayed as a valid measurement. A query failure is reported as unavailable; if a previously generated snapshot exists, it is explicitly marked as stale cached data. These timestamps describe the current completion state, not an immutable event ledger: reprocessing can move a film into a later day and alter earlier chart counts.

## Pipeline discovery control

The Pipeline tab can pause recent and historical TMDb discovery independently, or both together. The state is stored as the `pipeline_control` JSON value in the existing D1 `system_state` table. Missing or malformed state defaults both lanes to enabled, preserving the previous behavior. An idempotent request that already matches the stored state performs no write.

The Cron reads this control after scheduling the existing movie backlog. Paused lanes do not run their due-query lookup or enqueue new `DISCOVER_QUERY` messages; enrichment and embedding retain the existing `PIPELINE_BUDGET=20`. `/admin/run` uses the same scheduler and therefore cannot bypass the pause. `/admin/seed` only synchronizes query definitions.

A discovery message already in the Queue is checked before its job claim. If its lane is paused, its `pipeline_jobs` row becomes `paused` without incrementing attempts, the Queue message is acknowledged, and the corresponding `collection_queries` row remains pending with its `next_page` unchanged. On resume, the ordinary Cron changes that row back to queued and sends one message within the original lane budget. This avoids retries, DLQ traffic, duplicates, and bursts. A job that observes a pause between TMDb pages finishes its current page and persists the following `next_page` before stopping.

The authenticated Worker endpoint is `GET|POST /admin/pipeline-control`; Pages proxies it only through the authenticated Control Room route with Origin and CSRF checks on mutations. Payloads accept only boolean `historical_enabled` and `recent_enabled` fields. Changes emit structured logs containing previous, requested, and confirmed state but no credentials or authorization headers.

Backlog figures are read from current movie lifecycle states. Collection, enrichment, and embedding waiting counts are mutually exclusive stages; errors are displayed separately and are not added to those stages. The aggregate is cached in the Worker isolate for 60 seconds, while the one-row operational control is always reread. No additional Worker, Queue, Cron, migration, or per-film write is introduced.

The Pages-to-Worker control request reports sanitized failure classes instead of collapsing every problem into “unavailable”: authentication mismatch, missing route/deploy skew, timeout, invalid response, D1 failure, network failure, or missing Pages configuration. `PIPELINE_ADMIN_TOKEN` on Pages must contain the same value as `ADMIN_TOKEN` on the Pipeline Worker; the normal Control Room login only proves the Pages `ADMIN_TOKEN`, not this server-to-server pairing. Never print either value to compare them.

Operational health is evidence-based. The panel displays the latest `movies.created_at`, `details_fetched_at`, `enriched_at`, and `embedded_at`, the latest completed/started job, queued/running/error counts, and the persisted successful `last_cron_at`. “Recent” means within 45 minutes—three expected 15-minute Cron intervals. An empty eligible backlog is shown as idle; a non-empty backlog without recent completion is shown as lacking recent progress. An administrative endpoint failure does not hide D1 job data or imply that Queue/Cron processing stopped.

The scheduler reserves its existing total budget of 20 across collection recovery (4), enrichment (8), and embedding (8). This repairs known `discovered` movies whose original `INDEX_MOVIE` message was lost and prevents any one lifecycle stage from indefinitely monopolizing the cycle. A recovery-row failure is logged with its exact stage and does not suppress otherwise eligible backlog work. `last_cron_at` remains a completion marker; `cron_started`, `cron_stage_failed`, and `cron_failed` logs distinguish attempts and failures without adding recurring D1 writes.
