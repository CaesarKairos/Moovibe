> Historical description of migration 0008. Current implementation and validation: [Throughput and recovery, migration 0009](throughput-recovery-2026-10-26.md).

# Queue Free transport

Apply migration 0008 before deploying the Worker (`npm run db:migrate`). No plan change is required. This patch has not been deployed automatically.

D1 is the durable backlog. `available_at` controls intentional deferral; `queue_lease_until` controls transport ownership, independently of `updated_at` and execution attempts. A conditional five-minute publication lease prevents concurrent sends. Successful sends extend it to 25 hours (Free retention is 24 hours plus recovery grace). Publication tokens prevent a late producer from overwriting a consumer transition. Delivery clears the lease; retry/defer persists a future due time and acknowledges the old message. Running work retains the existing 30-minute execution lease recovery.

The D1/send boundary cannot be transactional: a crash after send but before confirmation can duplicate a message after five minutes. Execution claims remain conditional and business operations must remain idempotent. Confirmed publications are never resent every cron. Migration conservatively grants legacy queued rows 25 hours because their historical publication state is unknowable; nothing is dropped, but some stranded legacy work will wait that long.

All discovery, INDEX, FETCH, ENRICH, EMBED and administrative publications share an atomic local admission budget of 6,000 reserved operations/day, six per publication: normal write/read/delete plus allowance for redelivery, expiration and DLQ. At most 1,000 publications/day are admitted, including failed/ambiguous attempts. A multi-stage film uses multiple admissions. This is deliberately conservative, not an exact Cloudflare account counter or a guarantee against other applications consuming the remaining 4,000 operations. Batching does not reduce the reservation. No new secret or monitoring API permission is required.

10253 / FreeTierLimitExceeded opens one durable circuit until the next UTC day plus five minutes; other send failures open it for fifteen minutes. The first failure logs one aggregate diagnostic; subsequent publications do not call Queue.send. Jobs remain in D1 without execution attempts or terminal movie errors. At renewal the regular cron resumes within its normal fifteen-minute cadence.

`/admin/run` returns structured JSON (503 for limited/partial runs), not an uncaught send exception. `last_scheduler_result`, `cron_partial`, provider status and health expose transport state. `last_cron_at` means scheduling finished, not that movies completed. Observe `job_completed` and movie stage counts for actual progress. Recovery/seed errors make the scheduler result partial.

Use the Cloudflare account dashboard Queue operation metrics, backlog age, retries and DLQ depth to compare actual account usage with this local reservation. There is no account metrics binding in this repository: the Worker does not claim to observe other queues. Reduce the local budget if other workloads require more headroom. Do not drain or replay a DLQ in bulk outside this admission path. Unexpected consumer runtime failures can still use native retries/DLQ; the reservation is a safety allowance rather than exact billing.

References: https://developers.cloudflare.com/queues/platform/pricing/ and https://developers.cloudflare.com/queues/platform/limits/ .
