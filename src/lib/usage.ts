import type { RateLimiterBinding } from "../env";

export const DAILY_REQUEST_LIMIT = 100_000;
export const DAILY_WRITE_LIMIT = 100_000;
export const MAX_ALLOCATED_SHARE_WRITES = 80_000;
export const D1_LIMIT_BYTES = 500 * 1024 * 1024;
export const R2_LIMIT_BYTES = 10 * 1024 * 1024 * 1024;
export const WARNING_THRESHOLD = 0.7;
export const BLOCK_THRESHOLD = 0.9;
export const FLUSH_INTERVAL_MS = 60_000;
export const DEFAULT_PARTICIPANTS = 225;

export interface UsageTotals {
  requests: number;
  writes: number;
  regWrites: number;
}

export interface UsageDelta {
  requests?: number;
  writes?: number;
  regWrites?: number;
}

interface UsageBucket {
  pendingRequests: number;
  pendingWrites: number;
  pendingRegWrites: number;
  lastFlushedAt: number;
}

const isolateUsage = new Map<string, UsageBucket>();

export function defaultShares(participants: number): {
  shareRequests: number;
  shareWrites: number;
} {
  return {
    shareRequests: 1_000 + 12 * participants,
    shareWrites: 1_000 + 18 * participants,
  };
}

export function utcDay(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

export function secondsUntilUtcMidnight(nowMs: number): number {
  const nextMidnight = Date.UTC(
    new Date(nowMs).getUTCFullYear(),
    new Date(nowMs).getUTCMonth(),
    new Date(nowMs).getUTCDate() + 1,
  );
  return Math.max(60, Math.ceil((nextMidnight - nowMs) / 1000));
}

function bucketKey(slug: string, day: string): string {
  return `${slug}\0${day}`;
}

export function recordUsage(
  slug: string,
  day: string,
  delta: UsageDelta,
  nowMs: number,
): void {
  const key = bucketKey(slug, day);
  let bucket = isolateUsage.get(key);
  if (!bucket) {
    bucket = {
      pendingRequests: 0,
      pendingWrites: 0,
      pendingRegWrites: 0,
      lastFlushedAt: nowMs,
    };
    isolateUsage.set(key, bucket);
  }
  bucket.pendingRequests += delta.requests ?? 0;
  bucket.pendingWrites += delta.writes ?? 0;
  bucket.pendingRegWrites += delta.regWrites ?? 0;
}

export function getPendingUsage(slug: string, day: string): UsageTotals {
  const bucket = isolateUsage.get(bucketKey(slug, day));
  if (!bucket) {
    return { requests: 0, writes: 0, regWrites: 0 };
  }
  return {
    requests: bucket.pendingRequests,
    writes: bucket.pendingWrites,
    regWrites: bucket.pendingRegWrites,
  };
}

export function getAllPendingUsageForDay(day: string): ReadonlyMap<string, UsageTotals> {
  const result = new Map<string, UsageTotals>();
  const suffix = `\0${day}`;
  for (const [key, bucket] of isolateUsage.entries()) {
    if (!key.endsWith(suffix)) {
      continue;
    }
    const slug = key.slice(0, -suffix.length);
    result.set(slug, {
      requests: bucket.pendingRequests,
      writes: bucket.pendingWrites,
      regWrites: bucket.pendingRegWrites,
    });
  }
  return result;
}

export async function getEffectiveUsage(
  db: D1Database,
  slug: string,
  day: string,
): Promise<UsageTotals> {
  const row = await db
    .prepare(
      `SELECT requests, writes, reg_writes
       FROM usage
       WHERE slug = ? AND day = ?`,
    )
    .bind(slug, day)
    .first<{ requests: number; writes: number; reg_writes: number }>();

  const pending = getPendingUsage(slug, day);
  return {
    requests: (row?.requests ?? 0) + pending.requests,
    writes: (row?.writes ?? 0) + pending.writes,
    regWrites: (row?.reg_writes ?? 0) + pending.regWrites,
  };
}

export async function flushUsageNow(
  db: D1Database,
  slug: string,
  day: string,
  nowMs: number,
): Promise<boolean> {
  const key = bucketKey(slug, day);
  const bucket = isolateUsage.get(key);
  if (!bucket) {
    return false;
  }

  const reqs = bucket.pendingRequests;
  const writes = bucket.pendingWrites;
  const regWrites = bucket.pendingRegWrites;
  if (reqs === 0 && writes === 0 && regWrites === 0) {
    bucket.lastFlushedAt = nowMs;
    return false;
  }

  // Drain pending counters before awaiting so concurrent calls do not double-flush.
  bucket.pendingRequests = 0;
  bucket.pendingWrites = 0;
  bucket.pendingRegWrites = 0;
  bucket.lastFlushedAt = nowMs;

  try {
    await db
      .prepare(
        `INSERT INTO usage (slug, day, requests, writes, reg_writes)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(slug, day) DO UPDATE SET
           requests = usage.requests + excluded.requests,
           writes = usage.writes + excluded.writes,
           reg_writes = usage.reg_writes + excluded.reg_writes`,
      )
      .bind(slug, day, reqs, writes, regWrites)
      .run();
    return true;
  } catch {
    bucket.pendingRequests += reqs;
    bucket.pendingWrites += writes;
    bucket.pendingRegWrites += regWrites;
    return false;
  }
}

export function maybeFlushUsage(
  db: D1Database,
  slug: string,
  day: string,
  nowMs: number,
  ctx?: ExecutionContext,
): void {
  const bucket = isolateUsage.get(bucketKey(slug, day));
  if (!bucket) {
    return;
  }
  if (
    bucket.pendingRequests === 0 &&
    bucket.pendingWrites === 0 &&
    bucket.pendingRegWrites === 0
  ) {
    return;
  }
  if (nowMs - bucket.lastFlushedAt < FLUSH_INTERVAL_MS) {
    return;
  }

  const promise = flushUsageNow(db, slug, day, nowMs);
  if (ctx) {
    ctx.waitUntil(promise);
  }
}

export function resetUsageCounters(): void {
  isolateUsage.clear();
}

export async function checkRateLimit(
  limiter: RateLimiterBinding | undefined,
  key: string,
): Promise<boolean> {
  if (!limiter) {
    return true;
  }
  try {
    const outcome = await limiter.limit({ key });
    return outcome.success;
  } catch {
    // Rate-limit binding is best-effort; fail open if it errors.
    return true;
  }
}
