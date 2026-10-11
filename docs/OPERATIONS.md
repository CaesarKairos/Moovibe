# Moovibe operations

Private administration is served dynamically by Pages Functions and requires two independent secrets: a non-public path value and the existing admin credential. The credential is exchanged server-side for a signed, 12-hour, `HttpOnly`, `Secure`, `SameSite=Strict` cookie. Never commit either value.

Detailed AI traces are emitted as sanitized structured `ai_trace` events to Cloudflare Workers Logs. Their retention follows the limited retention of the Cloudflare plan; prompts and responses are deliberately not copied to D1. The permanent administrative history uses only compact rows in `recommendation_events`.

The Analytics Engine binding `MOOVIBE_ANALYTICS` receives privacy-preserving aggregate events independently of AI logging and degrades gracefully when unavailable. No telemetry stores raw IP addresses or browser fingerprints. The project does not require R2 or an object-storage subscription.

Apply the D1 migrations before deploying Pages. The migrations add the persistent song library, lyric/profile cache, and the low-volume recommendation ledger. They do not alter migrations `0001` or `0002`.

The dashboard is read-only. Pipeline mutation endpoints remain separate Worker tools protected by `ADMIN_TOKEN`.

## Gemini Control Center

The `09 / CENTRAL DE IA` dashboard section reads a cached health snapshot during normal polling. Only **VERIFICAR AGORA** makes four small Gemini calls: generation and embedding from Pages, plus generation and embedding from the Pipeline Worker. This action has a 60-second cooldown and the snapshot expires from KV after 15 minutes.

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

After a manual change, use **VERIFICAR AGORA** to confirm both capabilities in both runtimes. A successful minimal check does not prove that long production workloads will fit within provider quotas.
