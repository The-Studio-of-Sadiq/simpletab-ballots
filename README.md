# simpletab-ballots

`simpletab-ballots` is SimpleTab's shared online inbox and validator, running on Cloudflare Workers, D1, and R2. It collects participant submissions (ballots, feedback, check-ins) through private links, validates proofs and deadlines against host-uploaded round permits, serves submission status checks, and exposes host sync and admin endpoints. It never decides tournament outcomes.

## Dependency on `@simpletab/core`

During initial development, `package.json` references the sibling workspace package directly:

```json
"@simpletab/core": "file:../simpletab/packages/core"
```

Once `@simpletab/core` is published as a pre-release on npm, this `file:` reference will be replaced with a pinned npm version.

## Local development

```bash
npm install
npm run d1:migrate:local
npm run dev
```

Verification commands:

```bash
npm run app:build
npm run app:size
npm run typecheck
npm test
npm run i18n:check
npx wrangler deploy --dry-run --outdir dist
```

## Participant phone web app (`app/`)

The participant portal is a framework-free TypeScript PWA built with `esbuild` into `app/dist/` and wired as Workers Static Assets in `wrangler.toml` (`[assets]`, `run_worker_first = ["/v1/*", "/admin/*"]`).

- **Build & size check:** `npm run app:build` bundles `app/src/main.ts` and `app/src/sw.ts` into `app/dist/`; `npm run app:size` verifies total gzipped JS stays under 100 KB.
- **Local dev:** `npm run app:dev` builds and serves `app/dist/` locally on `http://127.0.0.1:8788`.
- **i18n:** `app/locales/{en,bn,TEMPLATE}/app.json` use ICU MessageFormat (`intl-messageformat`); `npm run i18n:check` verifies key parity and ICU syntax.
- **CDN manifest contract:** `app/src/manifest.ts` defines `TournamentManifest`, `RoundManifestEntry`, `FormsFile`, and `MotionsFile` produced by the host publisher.

## Admin access (Cloudflare Access)

All `/admin/*` endpoints require Cloudflare Access to be configured in front of the Worker. Cloudflare Access injects the `Cf-Access-Authenticated-User-Email` header after authentication, and the Worker verifies that the header is present and matches a row in the `admins` table.

## Design decisions

### Request idempotency (`X-Request-Id`)

Host `POST` routes (`/v1/host/permits`, `/v1/host/ack`, `/v1/host/head`, `/v1/host/close`) accept an `X-Request-Id` header. Responses are cached in a bounded per-isolate in-memory LRU cache (max 512 entries, 15-minute TTL) keyed by `(slug, method, path, requestId)`. In addition, the underlying SQL operations (`permits` upsert, monotonic `acked_through` update, `heads` conflict check, and `close` status update) are naturally idempotent across isolates. This avoids adding an extra D1 idempotency table and keeps zero extra D1 writes beyond Appendix D's budget.

### Rate-limiting bindings

`wrangler.toml` configures two Workers Rate Limiting bindings:

- `RL_LINK`: 10 requests per 60 seconds (keyed per tournament slug + lookup ID on `/v1/submit` and `/v1/status`).
- `RL_IP`: 20 requests per 60 seconds (keyed per client IP on failed `/v1/submit` requests).

Rate limit checks are best-effort and fail open if a binding throws.

### D1 write budget per route

Row write counts include D1 index row updates (as specified in design section 13):

| Route | D1 rows written | Notes |
|---|---|---|
| `POST /v1/submit` | 2 (0 on duplicate) | 1 `submissions` row + 1 `submission_id` unique index row; no `(slug, rowid)` index |
| `GET /v1/status` | 0 | Read-only; updates only in-memory request counters |
| `POST /v1/host/ack` | 1 (0 if not greater) | Updates `tournaments.acked_through` |
| `POST /v1/host/permits` | 1 per round | Upserts 1 row in `permits` |
| `POST /v1/host/head` | 1 (0 on idempotent repeat) | Inserts 1 row in `heads` |
| `POST /v1/host/close` | 1 (0 if already closed) | Sets `tournaments.status = 'closed'` |
| `POST /v1/host/key-request` | 1 | Inserts 1 row in `key_requests` |
| `POST /v1/register` | 0 (stubbed 404) | Deferred to M10 (2 writes when implemented) |
| Usage flush | 1 per tournament per isolate-minute | Additive `UPSERT` (`requests = requests + ?`), flushed at most once every 60 s |

Note: `tournaments` includes `host_rank INTEGER` (per design section 4 step 8) alongside `host_number` and `host_id` so rank tie-breaking requires zero extra rows or indexes. Updating host metadata on a host-number/host-id change writes 1 row (`tournaments`).
