# AGENTS.md

Rules for anyone (person or AI) changing `simpletab-ballots`.

1. **Inbox and validator only.** This service never decides tournament outcomes, adjudicator allocations, draws, breaks, or results. Only the tournament host decides.
2. **One source of rules.** Wire schemas, error codes, HTTP status mappings, canonical JSON, and link/proof crypto live in `@simpletab/core`. Import them from `@simpletab/core`; never duplicate them here.
3. **No secrets in code or logs.** Never commit secrets, API tokens, or keys. Store only SHA-256 hashes of tournament keys and permit verifiers (never plaintext tournament keys or link secrets).
4. **Respect the D1 free-tier write budget.** Never add secondary indexes to `submissions`, never write to D1 on `GET /v1/status`, and keep usage counter flushes batched in memory (at most once per minute per tournament per isolate).
5. **Code conventions.** Explicit TypeScript types, no `any`, 2-space indentation, double quotes, semicolons.
6. **Git.** Do not commit or push unless explicitly asked.
