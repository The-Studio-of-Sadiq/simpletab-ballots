import { base64UrlEncode } from "@simpletab/core/crypto";
import type { Clock, Env } from "../env";
import { DEFAULT_MAX_DELETES_PER_DAY } from "../lib/archive";
import {
  authenticateAdmin,
  hashTournamentKey,
  isClosedStatus,
  type TournamentRow,
  type TournamentStatus,
} from "../lib/auth";
import { errorResponse, jsonResponse, readJsonBody } from "../lib/errors";
import {
  BLOCK_THRESHOLD,
  D1_LIMIT_BYTES,
  DAILY_REQUEST_LIMIT,
  DAILY_WRITE_LIMIT,
  DEFAULT_PARTICIPANTS,
  MAX_ALLOCATED_SHARE_WRITES,
  R2_LIMIT_BYTES,
  WARNING_THRESHOLD,
  defaultShares,
  getAllPendingUsageForDay,
  utcDay,
} from "../lib/usage";

interface KeyRequestRow {
  id: string;
  slug: string;
  contact: string;
  note: string | null;
  requested_at: string;
  decided_at: string | null;
  decision: string | null;
}

interface UsageRow {
  slug: string;
  day: string;
  requests: number;
  writes: number;
  reg_writes: number;
}

interface AdminArchiveJobRow {
  slug: string;
  phase: string;
  table_idx: number;
  next_part: number;
  deleted_day: string | null;
  deleted_today: number;
  error: string | null;
  updated_at: string;
}

interface AdminArchiveRecordRow {
  slug: string;
  r2_key: string;
  rows: number;
  archived_at: string;
}

type ThresholdLevel = "ok" | "warning" | "blocked";

function thresholdLevel(used: number, limit: number): ThresholdLevel {
  const ratio = limit > 0 ? used / limit : 0;
  if (ratio >= BLOCK_THRESHOLD) {
    return "blocked";
  }
  if (ratio >= WARNING_THRESHOLD) {
    return "warning";
  }
  return "ok";
}

function generateRandomKey(): string {
  const bytes = new Uint8Array(new ArrayBuffer(32));
  globalThis.crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

async function getD1UsedBytes(db: D1Database): Promise<number> {
  try {
    const pageCountRow = await db.prepare("PRAGMA page_count").first<{ page_count: number }>();
    const pageSizeRow = await db.prepare("PRAGMA page_size").first<{ page_size: number }>();
    const pages = pageCountRow?.page_count ?? 0;
    const size = pageSizeRow?.page_size ?? 0;
    if (Number.isFinite(pages) && Number.isFinite(size) && pages >= 0 && size >= 0) {
      return pages * size;
    }
    return 0;
  } catch {
    return 0;
  }
}

async function getR2UsedBytes(archive: R2Bucket): Promise<number> {
  try {
    let total = 0;
    let cursor: string | undefined;
    for (let page = 0; page < 10; page++) {
      const listing = await archive.list({ cursor, limit: 1000 });
      for (const obj of listing.objects) {
        total += obj.size;
      }
      if (!listing.truncated) {
        break;
      }
      cursor = listing.cursor;
    }
    return total;
  } catch {
    return 0;
  }
}

async function getAllocatedShareWrites(
  db: D1Database,
  excludeSlug?: string,
): Promise<number> {
  const sql = excludeSlug
    ? `SELECT COALESCE(SUM(share_writes), 0) AS total
       FROM tournaments
       WHERE status IN ('active', 'paused') AND slug != ?`
    : `SELECT COALESCE(SUM(share_writes), 0) AS total
       FROM tournaments
       WHERE status IN ('active', 'paused')`;
  const stmt = excludeSlug ? db.prepare(sql).bind(excludeSlug) : db.prepare(sql);
  const row = await stmt.first<{ total: number }>();
  return row?.total ?? 0;
}

function isPositiveSafeInt(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readOptionalJsonBody(
  request: Request,
): Promise<{ ok: true; value: Record<string, unknown> } | { ok: false; response: Response }> {
  const text = await request.text();
  if (text.trim().length === 0) {
    return { ok: true, value: {} };
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (!isPlainRecord(parsed)) {
      return {
        ok: false,
        response: errorResponse("SCHEMA_INVALID", "Request body must be a JSON object"),
      };
    }
    return { ok: true, value: parsed };
  } catch {
    return {
      ok: false,
      response: errorResponse("SCHEMA_INVALID", "Request body must be valid JSON"),
    };
  }
}

async function listKeyRequests(env: Env, url: URL): Promise<Response> {
  const statusFilter = url.searchParams.get("status")?.trim() ?? "";
  let rows: KeyRequestRow[];

  if (statusFilter === "pending") {
    const res = await env.DB.prepare(
      `SELECT id, slug, contact, note, requested_at, decided_at, decision
       FROM key_requests
       WHERE decision IS NULL
       ORDER BY requested_at ASC`,
    ).all<KeyRequestRow>();
    rows = res.results;
  } else if (statusFilter.length > 0) {
    const res = await env.DB.prepare(
      `SELECT id, slug, contact, note, requested_at, decided_at, decision
       FROM key_requests
       WHERE decision = ?
       ORDER BY requested_at DESC`,
    )
      .bind(statusFilter)
      .all<KeyRequestRow>();
    rows = res.results;
  } else {
    const res = await env.DB.prepare(
      `SELECT id, slug, contact, note, requested_at, decided_at, decision
       FROM key_requests
       ORDER BY requested_at DESC`,
    ).all<KeyRequestRow>();
    rows = res.results;
  }

  return jsonResponse({ items: rows }, 200);
}

async function approveKeyRequest(
  request: Request,
  env: Env,
  requestId: string,
  now: Clock,
): Promise<Response> {
  const reqRow = await env.DB.prepare(
    `SELECT id, slug, contact, note, requested_at, decided_at, decision
     FROM key_requests
     WHERE id = ?`,
  )
    .bind(requestId)
    .first<KeyRequestRow>();

  if (!reqRow) {
    return errorResponse("NOT_FOUND", "Key request not found");
  }
  if (reqRow.decision !== null) {
    return errorResponse("SCHEMA_INVALID", "Key request has already been decided");
  }

  const bodyResult = await readOptionalJsonBody(request);
  if (!bodyResult.ok) {
    return bodyResult.response;
  }
  const body = bodyResult.value;

  const [d1Bytes, r2Bytes] = await Promise.all([
    getD1UsedBytes(env.DB),
    getR2UsedBytes(env.ARCHIVE),
  ]);
  if (
    thresholdLevel(d1Bytes, D1_LIMIT_BYTES) === "blocked" ||
    thresholdLevel(r2Bytes, R2_LIMIT_BYTES) === "blocked"
  ) {
    return errorResponse(
      "QUOTA_EXHAUSTED",
      "Storage usage is at or above 90%; new key approvals are blocked",
      { retryAfterSeconds: 3600 },
    );
  }

  let participants = DEFAULT_PARTICIPANTS;
  if (body.participants !== undefined) {
    if (!isPositiveSafeInt(body.participants)) {
      return errorResponse("SCHEMA_INVALID", "participants: must be a positive integer");
    }
    participants = body.participants;
  }

  const computedShares = defaultShares(participants);
  let shareRequests = computedShares.shareRequests;
  let shareWrites = computedShares.shareWrites;

  if (body.shareRequests !== undefined) {
    if (!isPositiveSafeInt(body.shareRequests)) {
      return errorResponse("SCHEMA_INVALID", "shareRequests: must be a positive integer");
    }
    shareRequests = body.shareRequests;
  }
  if (body.shareWrites !== undefined) {
    if (!isPositiveSafeInt(body.shareWrites)) {
      return errorResponse("SCHEMA_INVALID", "shareWrites: must be a positive integer");
    }
    shareWrites = body.shareWrites;
  }

  let cdnOrigin: string | null = null;
  if (body.cdnOrigin !== undefined) {
    if (typeof body.cdnOrigin !== "string" || body.cdnOrigin.trim().length === 0) {
      return errorResponse("SCHEMA_INVALID", "cdnOrigin: must be a non-empty string");
    }
    cdnOrigin = body.cdnOrigin.trim();
  }

  const existingTournament = await env.DB.prepare(
    `SELECT slug, key_hash, status
     FROM tournaments
     WHERE slug = ?`,
  )
    .bind(reqRow.slug)
    .first<{ slug: string; key_hash: string | null; status: string }>();

  if (existingTournament && existingTournament.key_hash !== null) {
    return errorResponse(
      "SCHEMA_INVALID",
      `Tournament "${reqRow.slug}" already has a key; use reissue instead`,
    );
  }

  const allocatedWrites = await getAllocatedShareWrites(env.DB, reqRow.slug);
  if (allocatedWrites + shareWrites > MAX_ALLOCATED_SHARE_WRITES) {
    return errorResponse(
      "QUOTA_EXHAUSTED",
      `Total allocated daily writes (${allocatedWrites + shareWrites}) would exceed ${MAX_ALLOCATED_SHARE_WRITES}`,
      { retryAfterSeconds: 3600 },
    );
  }

  const plainKey = generateRandomKey();
  const keyHash = await hashTournamentKey(plainKey);
  const nowIso = new Date(now()).toISOString();

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO tournaments (
         slug, key_hash, host_number, host_id, host_rank, status,
         share_requests, share_writes, cdn_origin, acked_through, created_at
       )
       VALUES (?, ?, 1, NULL, NULL, 'active', ?, ?, ?, 0, ?)
       ON CONFLICT(slug) DO UPDATE SET
         key_hash = excluded.key_hash,
         status = 'active',
         share_requests = excluded.share_requests,
         share_writes = excluded.share_writes,
         cdn_origin = excluded.cdn_origin`,
    ).bind(reqRow.slug, keyHash, shareRequests, shareWrites, cdnOrigin, nowIso),
    env.DB.prepare(
      `UPDATE key_requests
       SET decided_at = ?, decision = 'approved'
       WHERE id = ?`,
    ).bind(nowIso, reqRow.id),
  ]);

  return jsonResponse(
    {
      slug: reqRow.slug,
      key: plainKey,
      hostNumber: 1,
      shareRequests,
      shareWrites,
      status: "active",
    },
    201,
  );
}

async function revokeTournament(env: Env, slug: string): Promise<Response> {
  const res = await env.DB.prepare(
    `UPDATE tournaments
     SET status = 'revoked'
     WHERE slug = ?`,
  )
    .bind(slug)
    .run();

  if ((res.meta?.changes ?? 0) === 0) {
    return errorResponse("NOT_FOUND", "Tournament not found");
  }

  return jsonResponse({ slug, status: "revoked" }, 200);
}

async function reissueTournamentKey(env: Env, slug: string): Promise<Response> {
  const existing = await env.DB.prepare(
    `SELECT slug, host_number, status
     FROM tournaments
     WHERE slug = ?`,
  )
    .bind(slug)
    .first<{ slug: string; host_number: number; status: TournamentStatus }>();

  if (!existing) {
    return errorResponse("NOT_FOUND", "Tournament not found");
  }
  if (isClosedStatus(existing.status)) {
    return errorResponse("ROUND_CLOSED", "Cannot reissue key for a closed tournament");
  }

  const plainKey = generateRandomKey();
  const keyHash = await hashTournamentKey(plainKey);
  const nextHostNumber = existing.host_number + 1;

  await env.DB.prepare(
    `UPDATE tournaments
     SET key_hash = ?,
         host_number = ?,
         host_id = NULL,
         host_rank = NULL,
         status = 'active'
     WHERE slug = ?`,
  )
    .bind(keyHash, nextHostNumber, slug)
    .run();

  return jsonResponse(
    {
      slug,
      key: plainKey,
      hostNumber: nextHostNumber,
      status: "active",
    },
    200,
  );
}

async function updateTournamentShare(
  request: Request,
  env: Env,
  slug: string,
): Promise<Response> {
  const existing = await env.DB.prepare(
    `SELECT slug, key_hash, host_number, host_id, host_rank, status,
            share_requests, share_writes, cdn_origin, acked_through,
            reg_open, reg_close, reg_cap, closed_at, created_at
     FROM tournaments
     WHERE slug = ?`,
  )
    .bind(slug)
    .first<TournamentRow>();

  if (!existing) {
    return errorResponse("NOT_FOUND", "Tournament not found");
  }

  const bodyResult = await readJsonBody(request);
  if (!bodyResult.ok) {
    return bodyResult.response;
  }
  if (!isPlainRecord(bodyResult.value)) {
    return errorResponse("SCHEMA_INVALID", "Request body must be a JSON object");
  }
  const body = bodyResult.value;

  let shareRequests = existing.share_requests;
  let shareWrites = existing.share_writes;
  let status = existing.status;

  if (body.shareRequests !== undefined) {
    if (!isPositiveSafeInt(body.shareRequests)) {
      return errorResponse("SCHEMA_INVALID", "shareRequests: must be a positive integer");
    }
    shareRequests = body.shareRequests;
  }

  if (body.shareWrites !== undefined) {
    if (!isPositiveSafeInt(body.shareWrites)) {
      return errorResponse("SCHEMA_INVALID", "shareWrites: must be a positive integer");
    }
    shareWrites = body.shareWrites;
  }

  if (body.paused !== undefined) {
    if (typeof body.paused !== "boolean") {
      return errorResponse("SCHEMA_INVALID", "paused: must be a boolean");
    }
    if (body.paused && status === "active") {
      status = "paused";
    } else if (!body.paused && status === "paused") {
      status = "active";
    }
  }

  if (status === "active" || status === "paused") {
    const otherAllocated = await getAllocatedShareWrites(env.DB, slug);
    if (otherAllocated + shareWrites > MAX_ALLOCATED_SHARE_WRITES) {
      return errorResponse(
        "QUOTA_EXHAUSTED",
        `Total allocated daily writes (${otherAllocated + shareWrites}) would exceed ${MAX_ALLOCATED_SHARE_WRITES}`,
        { retryAfterSeconds: 3600 },
      );
    }
  }

  await env.DB.prepare(
    `UPDATE tournaments
     SET share_requests = ?, share_writes = ?, status = ?
     WHERE slug = ?`,
  )
    .bind(shareRequests, shareWrites, status, slug)
    .run();

  return jsonResponse(
    {
      slug,
      status,
      shareRequests,
      shareWrites,
    },
    200,
  );
}

async function getUsageReport(env: Env, url: URL, now: Clock): Promise<Response> {
  const day = url.searchParams.get("day")?.trim() || utcDay(now());

  const [tournamentsRes, usageRes, archiveJobsRes, archivesRes, d1Bytes, r2Bytes] =
    await Promise.all([
      env.DB.prepare(
        `SELECT slug, status, share_requests, share_writes, host_number, acked_through, closed_at
         FROM tournaments
         ORDER BY created_at DESC`,
      ).all<{
        slug: string;
        status: string;
        share_requests: number;
        share_writes: number;
        host_number: number;
        acked_through: number;
        closed_at: string | null;
      }>(),
      env.DB.prepare(
        `SELECT slug, day, requests, writes, reg_writes
         FROM usage
         WHERE day = ?`,
      )
        .bind(day)
        .all<UsageRow>(),
      env.DB.prepare(
        `SELECT slug, phase, table_idx, next_part, deleted_day, deleted_today, error, updated_at
         FROM archive_jobs
         ORDER BY updated_at DESC`,
      ).all<AdminArchiveJobRow>(),
      env.DB.prepare(
        `SELECT slug, r2_key, rows, archived_at
         FROM archives`,
      ).all<AdminArchiveRecordRow>(),
      getD1UsedBytes(env.DB),
      getR2UsedBytes(env.ARCHIVE),
    ]);

  const usageBySlug = new Map<string, { requests: number; writes: number; regWrites: number }>();
  for (const row of usageRes.results) {
    usageBySlug.set(row.slug, {
      requests: row.requests,
      writes: row.writes,
      regWrites: row.reg_writes,
    });
  }

  const pendingBySlug = getAllPendingUsageForDay(day);
  for (const [slug, pending] of pendingBySlug.entries()) {
    const existing = usageBySlug.get(slug) ?? { requests: 0, writes: 0, regWrites: 0 };
    usageBySlug.set(slug, {
      requests: existing.requests + pending.requests,
      writes: existing.writes + pending.writes,
      regWrites: existing.regWrites + pending.regWrites,
    });
  }

  let totalRequests = 0;
  let totalWrites = 0;
  let totalRegWrites = 0;
  for (const entry of usageBySlug.values()) {
    totalRequests += entry.requests;
    totalWrites += entry.writes;
    totalRegWrites += entry.regWrites;
  }

  const jobsBySlug = new Map<string, AdminArchiveJobRow>();
  let deletedToday = 0;
  for (const job of archiveJobsRes.results) {
    jobsBySlug.set(job.slug, job);
    if (job.deleted_day === day) {
      deletedToday += job.deleted_today;
    }
  }

  const archivesBySlug = new Map<string, AdminArchiveRecordRow>();
  for (const arch of archivesRes.results) {
    archivesBySlug.set(arch.slug, arch);
  }

  let allocatedWrites = 0;
  const tournaments = tournamentsRes.results.map((t) => {
    if (t.status === "active" || t.status === "paused") {
      allocatedWrites += t.share_writes;
    }
    const used = usageBySlug.get(t.slug) ?? { requests: 0, writes: 0, regWrites: 0 };
    const job = jobsBySlug.get(t.slug);
    const arch = archivesBySlug.get(t.slug);
    return {
      slug: t.slug,
      status: t.status,
      hostNumber: t.host_number,
      ackedThrough: t.acked_through,
      shareRequests: t.share_requests,
      shareWrites: t.share_writes,
      requests: used.requests,
      writes: used.writes,
      regWrites: used.regWrites,
      archive: {
        closedAt: t.closed_at,
        phase: job?.phase ?? null,
        error: job?.error ?? null,
        r2Key: arch?.r2_key ?? null,
        archivedRows: arch?.rows ?? null,
        archivedAt: arch?.archived_at ?? null,
      },
    };
  });

  const erroredJobs = archiveJobsRes.results
    .filter((job) => job.error !== null)
    .map((job) => ({
      slug: job.slug,
      phase: job.phase,
      tableIdx: job.table_idx,
      nextPart: job.next_part,
      error: job.error,
      updatedAt: job.updated_at,
    }));

  return jsonResponse(
    {
      day,
      thresholds: {
        warning: WARNING_THRESHOLD,
        block: BLOCK_THRESHOLD,
      },
      daily: {
        requests: {
          used: totalRequests,
          limit: DAILY_REQUEST_LIMIT,
          level: thresholdLevel(totalRequests, DAILY_REQUEST_LIMIT),
        },
        writes: {
          used: totalWrites,
          limit: DAILY_WRITE_LIMIT,
          level: thresholdLevel(totalWrites, DAILY_WRITE_LIMIT),
        },
        regWrites: totalRegWrites,
      },
      allocated: {
        shareWrites: allocatedWrites,
        limit: MAX_ALLOCATED_SHARE_WRITES,
        level: thresholdLevel(allocatedWrites, MAX_ALLOCATED_SHARE_WRITES),
      },
      storage: {
        d1: {
          usedBytes: d1Bytes,
          limitBytes: D1_LIMIT_BYTES,
          level: thresholdLevel(d1Bytes, D1_LIMIT_BYTES),
        },
        r2: {
          usedBytes: r2Bytes,
          limitBytes: R2_LIMIT_BYTES,
          level: thresholdLevel(r2Bytes, R2_LIMIT_BYTES),
        },
      },
      archive: {
        deletedToday,
        dailyDeleteLimit: DEFAULT_MAX_DELETES_PER_DAY,
        erroredJobs,
      },
      tournaments,
    },
    200,
  );
}

async function addAdmin(
  request: Request,
  env: Env,
  now: Clock,
): Promise<Response> {
  const bodyResult = await readJsonBody(request);
  if (!bodyResult.ok) {
    return bodyResult.response;
  }
  if (!isPlainRecord(bodyResult.value)) {
    return errorResponse("SCHEMA_INVALID", "Request body must be a JSON object");
  }
  const rawEmail = bodyResult.value.email;
  const email = typeof rawEmail === "string" ? rawEmail.trim().toLowerCase() : "";
  if (email.length === 0 || !email.includes("@")) {
    return errorResponse("SCHEMA_INVALID", "email: must be a valid email address");
  }

  const addedAt = new Date(now()).toISOString();
  await env.DB.prepare(
    `INSERT INTO admins (email, added_at)
     VALUES (?, ?)
     ON CONFLICT(email) DO NOTHING`,
  )
    .bind(email, addedAt)
    .run();

  return jsonResponse({ email, addedAt }, 201);
}

export async function handleAdmin(
  request: Request,
  env: Env,
  url: URL,
  now: Clock,
): Promise<Response> {
  const auth = await authenticateAdmin(env.DB, request);
  if (!auth.ok) {
    return auth.response;
  }

  const path = url.pathname;
  const method = request.method;

  if (method === "GET" && path === "/admin/key-requests") {
    return listKeyRequests(env, url);
  }

  const approveMatch = /^\/admin\/key-requests\/([^/]+)\/approve$/.exec(path);
  if (method === "POST" && approveMatch) {
    return approveKeyRequest(request, env, decodeURIComponent(approveMatch[1]), now);
  }

  const revokeMatch = /^\/admin\/tournaments\/([^/]+)\/revoke$/.exec(path);
  if (method === "POST" && revokeMatch) {
    return revokeTournament(env, decodeURIComponent(revokeMatch[1]));
  }

  const reissueMatch = /^\/admin\/tournaments\/([^/]+)\/reissue$/.exec(path);
  if (method === "POST" && reissueMatch) {
    return reissueTournamentKey(env, decodeURIComponent(reissueMatch[1]));
  }

  const shareMatch = /^\/admin\/tournaments\/([^/]+)\/share$/.exec(path);
  if ((method === "PATCH" || method === "POST") && shareMatch) {
    return updateTournamentShare(request, env, decodeURIComponent(shareMatch[1]));
  }

  if (method === "GET" && path === "/admin/usage") {
    return getUsageReport(env, url, now);
  }

  if (method === "POST" && path === "/admin/admins") {
    return addAdmin(request, env, now);
  }

  return errorResponse("NOT_FOUND", `Admin route not found: ${method} ${path}`);
}
