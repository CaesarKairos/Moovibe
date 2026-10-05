# Moovibe operations

Private administration is served dynamically by Pages Functions and requires two independent secrets: a non-public path value and the existing admin credential. The credential is exchanged server-side for a signed, 12-hour, `HttpOnly`, `Secure`, `SameSite=Strict` cookie. Never commit either value.

The optional private R2 binding `AI_AUDIT_LOGS` stores sanitized AI traces. The Analytics Engine binding `MOOVIBE_ANALYTICS` receives privacy-preserving aggregate events; the application degrades gracefully when it is absent. Neither facility stores raw IP addresses or browser fingerprints.

After provisioning the named resources, apply the D1 migrations before deploying Pages. The migrations add the persistent song library, lyric/profile cache, and the low-volume recommendation ledger. They do not alter migrations `0001` or `0002`.

The dashboard is read-only. Pipeline mutation endpoints remain separate Worker tools protected by `ADMIN_TOKEN`.
