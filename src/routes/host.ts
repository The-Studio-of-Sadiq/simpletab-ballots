import {
  SCHEMA_VERSION,
  parseAck,
  parseHead,
  parseKeyRequest,
  parsePermitUpload,
  type InboxItem,
  type InboxPage,
} from "@simpletab/core/wire";
import type { Clock, Env } from "../env";
import {
  authenticateHost,
  getCachedIdempotentResponse,
  storeIdempotentResponse,
} from "../lib/auth";
import { errorResponse, jsonResponse, readJsonBody, wireParseErrorResponse } from "../lib/errors";
import { cacheRoundPermit } from "../lib/permits";
import { maybeFlushUsage, recordUsage, utcDay } from "../lib/usage";

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const NON_NEGATIVE_INT_RE = /^(?:0|[1-9]\d*)$/;
const POSITIVE_INT_RE = /^[1-9]\d*$/;
const MAX_INBOX_LIMIT = 500;
const INBOX_SCAN_BATCH = 2000;

interface SubmissionInboxRow {
  rowid: number;
  submission_id: string;
  slug: string;
  round_id: string | null;
  lookup_id: string | null;
  type: string;
  payload: string;
  received_at: string;
}

interface ExistingHeadRow {
  head_hash: string;
  published_at: string;
}

export async function handleHostKeyRequest(
  request: Request,
  env: Env,
  now: Clock,
): Promise<Response> {
  const bodyResult = await readJsonBody(request);
  if (!bodyResult.ok) {
    return bodyResult.response;
  }

  const parsed = parseKeyRequest(bodyResult.value);
  if (!parsed.ok) {
    return wireParseErrorResponse(parsed.errors);
  }

  if (!SLUG_RE.test(parsed.value.slug)) {
    return errorResponse(
      "SCHEMA_INVALID",
      "slug: must be 1-64 lowercase ASCII letters, digits, or hyphens",
    );
  }

  const id = globalThis.crypto.randomUUID();
  const requestedAt = new Date(now()).toISOString();

  await env.DB.prepare(
    `INSERT INTO key_requests (id, slug, contact, note, requested_at)
     VALUES (?, ?, ?, ?, ?)`,
  )
    .bind(id, parsed.value.slug, parsed.value.contact, parsed.value.note, requestedAt)
    .run();

  return jsonResponse(
    {
      schema: SCHEMA_VERSION,
      id,
      slug: parsed.value.slug,
      status: "pending",
      requestedAt,
    },
    201,
  );
}

export async function handleHostPermits(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  now: Clock,
): Promise<Response> {
  const auth = await authenticateHost(env.DB, request);
  if (!auth.ok) {
    return auth.response;
  }

  const nowMs = now();
  const cached = getCachedIdempotentResponse(
    auth.tournament.slug,
    request,
    "/v1/host/permits",
    nowMs,
  );
  if (cached) {
    return cached;
  }

  if (auth.tournament.status === "closed" || auth.tournament.status === "archived") {
    return errorResponse("ROUND_CLOSED", "Tournament is closed");
  }

  const bodyResult = await readJsonBody(request);
  if (!bodyResult.ok) {
    return bodyResult.response;
  }

  const parsed = parsePermitUpload(bodyResult.value);
  if (!parsed.ok) {
    return wireParseErrorResponse(parsed.errors);
  }

  const permit = parsed.value;
  const serialized = JSON.stringify(permit);

  await env.DB.prepare(
    `INSERT INTO permits (slug, round_id, version, open, body)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(slug, round_id) DO UPDATE SET
       version = excluded.version,
       open = excluded.open,
       body = excluded.body`,
  )
    .bind(auth.tournament.slug, permit.roundId, permit.version, permit.open ? 1 : 0, serialized)
    .run();

  cacheRoundPermit(auth.tournament.slug, permit);

  const day = utcDay(nowMs);
  recordUsage(
    auth.tournament.slug,
    day,
    { requests: 1, writes: 1 + (auth.hostUpdated ? 1 : 0) },
    nowMs,
  );
  maybeFlushUsage(env.DB, auth.tournament.slug, day, nowMs, ctx);

  const response = jsonResponse(
    {
      schema: SCHEMA_VERSION,
      roundId: permit.roundId,
      version: permit.version,
      open: permit.open,
    },
    200,
  );
  return storeIdempotentResponse(
    auth.tournament.slug,
    request,
    "/v1/host/permits",
    response,
    nowMs,
  );
}

export async function handleHostInbox(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  url: URL,
  now: Clock,
): Promise<Response> {
  const auth = await authenticateHost(env.DB, request);
  if (!auth.ok) {
    return auth.response;
  }

  const rawAfter = url.searchParams.get("after");
  let after = 0;
  if (rawAfter !== null && rawAfter.trim().length > 0) {
    if (!NON_NEGATIVE_INT_RE.test(rawAfter.trim())) {
      return errorResponse("SCHEMA_INVALID", "after: must be a non-negative integer");
    }
    after = Number(rawAfter.trim());
    if (!Number.isSafeInteger(after)) {
      return errorResponse("SCHEMA_INVALID", "after: must be a safe integer");
    }
  }

  const rawLimit = url.searchParams.get("limit");
  let limit = MAX_INBOX_LIMIT;
  if (rawLimit !== null && rawLimit.trim().length > 0) {
    if (!POSITIVE_INT_RE.test(rawLimit.trim())) {
      return errorResponse("SCHEMA_INVALID", "limit: must be a positive integer");
    }
    const parsedLimit = Number(rawLimit.trim());
    if (!Number.isSafeInteger(parsedLimit)) {
      return errorResponse("SCHEMA_INVALID", "limit: must be a safe integer");
    }
    limit = Math.min(parsedLimit, MAX_INBOX_LIMIT);
  }

  const matched: InboxItem[] = [];
  let cursor = after;
  let hasMore = false;

  // Scan globally by rowid without a (slug, rowid) index to avoid an extra D1 index write per submission.
  while (matched.length <= limit) {
    const batchResult = await env.DB.prepare(
      `SELECT rowid, submission_id, slug, round_id, lookup_id, type, payload, received_at
       FROM submissions
       WHERE rowid > ?
       ORDER BY rowid ASC
       LIMIT ?`,
    )
      .bind(cursor, INBOX_SCAN_BATCH)
      .all<SubmissionInboxRow>();

    const rows = batchResult.results;
    if (rows.length === 0) {
      break;
    }

    for (const row of rows) {
      cursor = row.rowid;
      if (row.slug !== auth.tournament.slug) {
        continue;
      }

      if (matched.length === limit) {
        hasMore = true;
        break;
      }

      let parsedPayload: Record<string, unknown> = {};
      try {
        const raw: unknown = JSON.parse(row.payload);
        if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
          parsedPayload = raw as Record<string, unknown>;
        }
      } catch {
        parsedPayload = {};
      }

      matched.push({
        rowid: row.rowid,
        submissionId: row.submission_id,
        type: row.type,
        roundId: row.round_id ?? "",
        lookupId: row.lookup_id ?? "",
        payload: parsedPayload,
        receivedAt: row.received_at,
      });
    }

    if (hasMore || rows.length < INBOX_SCAN_BATCH) {
      break;
    }
  }

  const next = hasMore && matched.length > 0 ? matched[matched.length - 1].rowid : null;
  const page: InboxPage = {
    schema: SCHEMA_VERSION,
    items: matched,
    next,
  };

  const nowMs = now();
  const day = utcDay(nowMs);
  recordUsage(
    auth.tournament.slug,
    day,
    { requests: 1, writes: auth.hostUpdated ? 1 : 0 },
    nowMs,
  );
  maybeFlushUsage(env.DB, auth.tournament.slug, day, nowMs, ctx);

  return jsonResponse(page, 200);
}

export async function handleHostAck(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  now: Clock,
): Promise<Response> {
  const auth = await authenticateHost(env.DB, request);
  if (!auth.ok) {
    return auth.response;
  }

  const nowMs = now();
  const cached = getCachedIdempotentResponse(
    auth.tournament.slug,
    request,
    "/v1/host/ack",
    nowMs,
  );
  if (cached) {
    return cached;
  }

  const bodyResult = await readJsonBody(request);
  if (!bodyResult.ok) {
    return bodyResult.response;
  }

  const parsed = parseAck(bodyResult.value);
  if (!parsed.ok) {
    return wireParseErrorResponse(parsed.errors);
  }

  const result = await env.DB.prepare(
    `UPDATE tournaments
     SET acked_through = ?
     WHERE slug = ? AND acked_through < ?`,
  )
    .bind(parsed.value.through, auth.tournament.slug, parsed.value.through)
    .run();

  const updated = (result.meta?.changes ?? 0) > 0;
  const ackedThrough = Math.max(auth.tournament.acked_through, parsed.value.through);

  const day = utcDay(nowMs);
  recordUsage(
    auth.tournament.slug,
    day,
    { requests: 1, writes: (updated ? 1 : 0) + (auth.hostUpdated ? 1 : 0) },
    nowMs,
  );
  maybeFlushUsage(env.DB, auth.tournament.slug, day, nowMs, ctx);

  const response = jsonResponse({ schema: SCHEMA_VERSION, ackedThrough }, 200);
  return storeIdempotentResponse(
    auth.tournament.slug,
    request,
    "/v1/host/ack",
    response,
    nowMs,
  );
}

export async function handleHostHead(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  now: Clock,
): Promise<Response> {
  const auth = await authenticateHost(env.DB, request);
  if (!auth.ok) {
    return auth.response;
  }

  const nowMs = now();
  const cached = getCachedIdempotentResponse(
    auth.tournament.slug,
    request,
    "/v1/host/head",
    nowMs,
  );
  if (cached) {
    return cached;
  }

  const bodyResult = await readJsonBody(request);
  if (!bodyResult.ok) {
    return bodyResult.response;
  }

  const parsed = parseHead(bodyResult.value);
  if (!parsed.ok) {
    return wireParseErrorResponse(parsed.errors);
  }

  const existing = await env.DB.prepare(
    `SELECT head_hash, published_at
     FROM heads
     WHERE slug = ? AND seq = ?`,
  )
    .bind(auth.tournament.slug, parsed.value.seq)
    .first<ExistingHeadRow>();

  const day = utcDay(nowMs);

  if (existing) {
    if (existing.head_hash !== parsed.value.headHash) {
      return errorResponse(
        "SCHEMA_INVALID",
        `Head at seq ${parsed.value.seq} already exists with a different hash`,
      );
    }

    recordUsage(
      auth.tournament.slug,
      day,
      { requests: 1, writes: auth.hostUpdated ? 1 : 0 },
      nowMs,
    );
    maybeFlushUsage(env.DB, auth.tournament.slug, day, nowMs, ctx);

    const response = jsonResponse(
      {
        schema: SCHEMA_VERSION,
        seq: parsed.value.seq,
        headHash: existing.head_hash,
        publishedAt: existing.published_at,
      },
      200,
    );
    return storeIdempotentResponse(
      auth.tournament.slug,
      request,
      "/v1/host/head",
      response,
      nowMs,
    );
  }

  const publishedAt = new Date(nowMs).toISOString();
  await env.DB.prepare(
    `INSERT INTO heads (slug, seq, head_hash, published_at)
     VALUES (?, ?, ?, ?)`,
  )
    .bind(auth.tournament.slug, parsed.value.seq, parsed.value.headHash, publishedAt)
    .run();

  recordUsage(
    auth.tournament.slug,
    day,
    { requests: 1, writes: 1 + (auth.hostUpdated ? 1 : 0) },
    nowMs,
  );
  maybeFlushUsage(env.DB, auth.tournament.slug, day, nowMs, ctx);

  const response = jsonResponse(
    {
      schema: SCHEMA_VERSION,
      seq: parsed.value.seq,
      headHash: parsed.value.headHash,
      publishedAt,
    },
    200,
  );
  return storeIdempotentResponse(
    auth.tournament.slug,
    request,
    "/v1/host/head",
    response,
    nowMs,
  );
}

export async function handleHostClose(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  now: Clock,
): Promise<Response> {
  const auth = await authenticateHost(env.DB, request);
  if (!auth.ok) {
    return auth.response;
  }

  const nowMs = now();
  const cached = getCachedIdempotentResponse(
    auth.tournament.slug,
    request,
    "/v1/host/close",
    nowMs,
  );
  if (cached) {
    return cached;
  }

  const alreadyClosed =
    auth.tournament.status === "closed" || auth.tournament.status === "archived";

  if (!alreadyClosed) {
    await env.DB.prepare(
      `UPDATE tournaments
       SET status = 'closed'
       WHERE slug = ? AND status NOT IN ('closed', 'archived')`,
    )
      .bind(auth.tournament.slug)
      .run();
  }

  const finalStatus =
    auth.tournament.status === "archived" ? "archived" : "closed";

  const day = utcDay(nowMs);
  recordUsage(
    auth.tournament.slug,
    day,
    { requests: 1, writes: (alreadyClosed ? 0 : 1) + (auth.hostUpdated ? 1 : 0) },
    nowMs,
  );
  maybeFlushUsage(env.DB, auth.tournament.slug, day, nowMs, ctx);

  const response = jsonResponse(
    {
      schema: SCHEMA_VERSION,
      slug: auth.tournament.slug,
      status: finalStatus,
    },
    200,
  );
  return storeIdempotentResponse(
    auth.tournament.slug,
    request,
    "/v1/host/close",
    response,
    nowMs,
  );
}
