# Moovibe operations

Private administration is served dynamically by Pages Functions and requires two independent secrets: a non-public path value and the existing admin credential. The credential is exchanged server-side for a signed, 12-hour, `HttpOnly`, `Secure`, `SameSite=Strict` cookie. Never commit either value.

Detailed AI traces are emitted as sanitized structured `ai_trace` events to Cloudflare Workers Logs. Their retention follows the limited retention of the Cloudflare plan; prompts and responses are deliberately not copied to D1. The permanent administrative history uses only compact rows in `recommendation_events`.

The Analytics Engine binding `MOOVIBE_ANALYTICS` receives privacy-preserving aggregate events independently of AI logging and degrades gracefully when unavailable. No telemetry stores raw IP addresses or browser fingerprints. The project does not require R2 or an object-storage subscription.

Apply the D1 migrations before deploying Pages. The migrations add the persistent song library, lyric/profile cache, and the low-volume recommendation ledger. They do not alter migrations `0001` or `0002`.

The dashboard is read-only. Pipeline mutation endpoints remain separate Worker tools protected by `ADMIN_TOKEN`.
