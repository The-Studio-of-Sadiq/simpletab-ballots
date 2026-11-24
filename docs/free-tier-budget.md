# Free-Tier Budget Verification (`npm run budget`)

This document describes how `simpletab-ballots` verifies its daily Cloudflare Workers + D1 free-tier budget against the real Worker and real D1 migrations in Miniflare.

## How to run

```bash
npm run budget
```

`npm run budget` executes `scripts/budget.mjs`, which runs the dedicated `"budget"` Vitest project (`test/budget/free-tier.budget.test.ts`) inside `@cloudflare/vitest-pool-workers` (excluded from normal `npm test` because the full replay takes ~3 minutes).

It exits non-zero if:
- any per-route D1 write count deviates from its zero-secondary-index baseline (catching any accidental secondary index on `submissions`, `tournaments`, `permits`, `heads`, or `usage`, or any write on `GET /v1/status`); or
- any enforced capacity scenario exceeds **90%** of Cloudflare's daily free limits (**100,000** Worker requests, **100,000** D1 rows written, **5,000,000** D1 rows read) or exceeds the **80,000** allocated tournament share-writes cap.

## What is measured

1. **Counting D1 proxy (`test/budget/counting-db.ts`)**: wraps `env.DB` passed to the real exported `handleRequest(request, wrappedEnv, ctx, clock)` handler and sums `meta.rows_written` and `meta.rows_read` from Miniflare's SQLite VFS across every `prepare().run/all/first/raw` and `batch()` call (including `ctx.waitUntil` usage flushes). Because D1's `.first()` and `.raw()` drop `meta` client-side, the proxy routes them through `.all()` to capture exact row counts.
2. **Per-route D1 write probe**: exercises each route in isolation against the applied migrations (`0001_init.sql`, `0002_archive.sql`, `0003_key_hash_index.sql`) after priming host identity.
3. **End-to-end tournament-day replays (`test/budget/replay.ts`)**:
   - **1 × WUDC-size day**: 4 rounds, 100 rooms, 400 teams, 500 adjudicators (`P = 900`), 3,600 check-ins, 400 BP consensus ballots, 3,200 feedback forms (7,200 real HMAC-SHA256 signed submissions), 2,200 phone status checks, 16 permit uploads (900 entries each), 134 head publishes, 1,200 host inbox pulls (every 30 s over 10 h simulated time), 600 acks on non-empty pulls, and ~600 one-minute usage flushes.
   - **1 × 100-team day**: 4 rounds, 25 rooms, 100 teams, 125 adjudicators (`P = 225`), 900 check-ins, 100 ballots, 800 feedback forms (1,800 real signed submissions), 552 status checks, 8 permit uploads, 30 head publishes, 1,200 host inbox pulls (30 s over 10 h), 500 acks, and ~600 usage flushes.
4. **Interleaved multi-tournament `rows_read` benchmark**: approves 3 WUDC tournaments and 15 100-team tournaments through the real admin endpoint (also verifying the 80,000 allocated share-writes cap), seeds one full round of interleaved submissions across all `N` tournaments, and runs real `GET /v1/host/inbox` polls at 30 s cadence for all `N` hosts so the `submissions` rowid-range scan and the host key lookup (one row through the `key_hash` index) are measured directly in Miniflare.

## Latest measured numbers

### Per-route D1 rows written

| Route | Design est. | Expected | Measured writes | Measured reads | Notes |
|---|---:|---:|---:|---:|---|
| `POST /v1/submit` (new) | 2 | 2 | 2 | 2 | 1 row + `UNIQUE(submission_id)` autoindex; no secondary indexes |
| `POST /v1/submit` (duplicate) | 0 | 0 | 0 | 2 | `ON CONFLICT DO NOTHING` |
| `GET /v1/status` | 0 | 0 | 0 | 2 | Read-only; in-memory request counter only |
| `GET /v1/host/inbox` | 0 | 0 | 0 | 2 | Read-only: `MAX(rowid)`, then a rowid-range scan filtered by `slug` in SQLite |
| `POST /v1/host/ack` | 1 | 1 | 1 | 2 | Updates `tournaments.acked_through` (non-PK column) |
| `POST /v1/host/permits` (update) | 1 | 1 | 1 | 2 | `ON CONFLICT DO UPDATE` on existing `(slug, round_id)` |
| `POST /v1/host/permits` (insert) | 1 | 2 | 2 | 1 | 1 row + `PK(slug, round_id)` autoindex (no `WITHOUT ROWID`) |
| `POST /v1/host/head` (insert) | 1 | 2 | 2 | 1 | 1 row + `PK(slug, seq)` autoindex (no `WITHOUT ROWID`) |
| Usage flush (steady-state) | 1 | 1 | 1 | 1 | `ON CONFLICT DO UPDATE` |
| Usage flush (first of day) | 1 | 2 | 2 | 0 | 1 row + `PK(slug, day)` autoindex once per tournament-day |

### Daily capacity scenarios

Free limits: **100,000** Worker requests, **100,000** D1 rows written, **5,000,000** D1 rows read (fail above **90%**); allocated share-writes cap **80,000**.

| Scenario | Requests | % Req | Rows Written | % Wr | Rows Read | % Rd | Share Wr | Status |
|---|---:|---:|---:|---:|---:|---:|---:|---|
| 1 × WUDC (replayed) | 11,350 | 11.3% | 15,890 | 15.9% | 38,116 | 0.8% | 17,200 | PASS |
| 1 × 100-team (replayed) | 4,090 | 4.1% | 4,774 | 4.8% | 13,033 | 0.3% | 5,050 | PASS |
| 3 × WUDC (capacity) | 34,050 | 34.1% | 47,670 | 47.7% | 165,450 | 3.3% | 51,600 | PASS |
| 15 × 100-team (capacity) | 61,350 | 61.4% | 71,610 | 71.6% | 707,775 | 14.2% | 75,750 | PASS |
| 15 × 100-team, rounds 6 min apart | | | | | 859,603 | 17.2% | | PASS (enforced) |
| 1 × 1000-team BP (report) | 25,651 | 25.7% | 37,892 | 37.9% | 90,744 | 1.8% | 41,500 | REPORT |

## Discrepancies vs. design section 13 & findings

1. **Composite-PK inserts write 2 rows, not 1**: `permits`, `heads`, and `usage` declare composite `PRIMARY KEY`s without `WITHOUT ROWID` in `migrations/0001_init.sql`, so SQLite maintains an internal PK autoindex alongside the rowid table. First-time inserts write 2 rows (updates write 1). Across a WUDC day this adds ~139 writes (~0.14% of the daily limit).
2. **100-team day and the default request share (fixed)**: host polling every 30 s for 10 hours (1,200 pulls + 500 acks) does not shrink with tournament size, so a 100-team day uses **4,090 requests**. The old default share, `1,000 + 12 × P` = 3,700, would have refused it partway through the day. The default is now `2,000 + 12 × P` (4,700 for P = 225, 12,800 for WUDC); writes were already inside their share (4,774 of 5,050).
3. **WUDC replay totals**: Measured **11,350 requests** and **15,890 writes** vs. design's ~10,850 requests and ~16,750 writes. Requests are slightly higher because non-empty polls send separate `POST /v1/host/ack` requests (1,200 pulls + 600 acks = 1,800 vs. design's 1,300); writes are slightly lower because a single Worker isolate flushes ~600×/day (vs. design's 1,000 multi-isolate budget) and only 600 ticks are non-empty (vs. 1,200).
4. **Staggered schedules (fixed)**: the inbox used to return `next: null` on an empty page, so a quiet host started every pull from its last own row and re-read every other tournament's newer rows; with 15 tournaments whose rounds start 6 minutes apart that was **~10.57M** rows read (211% of 5M). Each inbox page now carries `scanned`, the highest rowid the service examined, and the host starts its next pull there (kept locally, so it costs no service writes). The same schedule now reads **859,603** rows (17.2%), and the budget fails if it goes above 90%.
5. **Host key lookup (fixed)**: hosts were found with a full scan of `tournaments`, a table that only grows because tournaments are never deleted. Migration `0003_key_hash_index.sql` adds an index on `key_hash`; it is written only when a key is approved, reissued or revoked.

## Assumptions

- `3 × WUDC` and `15 × 100-team` requests and rows written multiply the single-tournament Miniflare replays by 3 and 15 respectively.
- `1 × 1000-team BP` (250 rooms, 1,250 adjudicators, `P = 2,250`) extrapolates participant/room-scaled traffic by 2.5× from WUDC while keeping 10 h fixed host polling, acks, permits, and usage flushes at 1×.
- Concurrent `rows_read` assumes synchronized 4-round schedules, measured via real 1-round `N`-way interleaved Miniflare inbox scans (× 4 rounds); host auth reads one `tournaments` row through the `key_hash` index.
- Usage flushes measure a single Worker isolate (~600 flushes over 10 h); multi-isolate routing in production can add up to ~400 writes per tournament-day.
- `RL_LINK` (10/60 s) and `RL_IP` (20/60 s) are evaluated against the simulated 10-hour clock rather than wall-clock replay time.
