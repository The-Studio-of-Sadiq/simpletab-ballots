import { constantTimeEqualStrings } from "@simpletab/core/crypto";
import {
  SCHEMA_VERSION,
  type StatusItem,
  type StatusResponse,
} from "@simpletab/core/wire";
import type { Clock, Env } from "../env";
import { extractBearerToken, hashTournamentKey, type TournamentRow } from "../lib/auth";
import { errorResponse, jsonResponse } from "../lib/errors";
import { checkRateLimit, getEffectiveUsage, recordUsage, utcDay } from "../lib/usage";

const ULID_RE = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const LOOKUP_ID_RE = /^[ats][abcdefghjkmnpqrstuvwxyz23456789]{12}$/;
const MAX_STATUS_IDS = 100;

interface SubmissionRowId {
  submission_id: string;
  rowid: number;
}

export async function handleStatus(
  request: Request,
  env: Env,
  url: URL,
  now: Clock,
): Promise<Response> {
  const slug = url.searchParams.get("slug")?.trim() ?? "";
  if (slug.length === 0) {
    return errorResponse("SCHEMA_INVALID", "slug query parameter is required");
  }

  const rawLookupId = url.searchParams.get("lookupId");
  const lookupId = rawLookupId ? rawLookupId.trim() : "";
  const hasAuthHeader = request.headers.has("Authorization");

  if (!hasAuthHeader && !LOOKUP_ID_RE.test(lookupId)) {
    return errorResponse(
      "SCHEMA_INVALID",
      "lookupId query parameter must be a valid participant lookup ID",
    );
  }
  if (lookupId.length > 0 && !LOOKUP_ID_RE.test(lookupId)) {
    return errorResponse(
      "SCHEMA_INVALID",
      "lookupId query parameter must be a valid participant lookup ID",
    );
  }

  const rawIds = url.searchParams.get("ids") ?? "";
  const ids = rawIds
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  if (ids.length > MAX_STATUS_IDS) {
    return errorResponse(
      "SCHEMA_INVALID",
      `ids query parameter supports at most ${MAX_STATUS_IDS} IDs`,
    );
  }

  for (const id of ids) {
    if (!ULID_RE.test(id)) {
      return errorResponse(
        "SCHEMA_INVALID",
        `ids entry "${id}" must be a 26-character Crockford ULID`,
      );
    }
  }

  const allowed = await checkRateLimit(
    env.RL_LINK,
    `status:${slug}:${lookupId || "host"}`,
  );
  if (!allowed) {
    return errorResponse("RATE_LIMITED", "Rate limit exceeded for status checks", {
      retryAfterSeconds: 60,
    });
  }

  const tournament = await env.DB.prepare(
    `SELECT slug, key_hash, host_number, host_id, host_rank, status,
            share_requests, share_writes, cdn_origin, acked_through,
            reg_open, reg_close, reg_cap, created_at
     FROM tournaments
     WHERE slug = ?`,
  )
    .bind(slug)
    .first<TournamentRow>();

  if (!tournament || tournament.status === "pending") {
    return errorResponse("NOT_FOUND", "Tournament not found");
  }

  let isHost = false;
  if (hasAuthHeader) {
    const token = extractBearerToken(request);
    if (!token || !tournament.key_hash) {
      return errorResponse("AUTH_INVALID", "Invalid tournament key");
    }
    const candidateHash = await hashTournamentKey(token);
    if (!constantTimeEqualStrings(tournament.key_hash, candidateHash)) {
      return errorResponse("AUTH_INVALID", "Invalid tournament key");
    }
    if (tournament.status === "revoked") {
      return errorResponse("KEY_REVOKED", "Tournament key has been revoked");
    }
    isHost = true;
  }

  const rowIdBySubmissionId = new Map<string, number>();
  if (ids.length > 0) {
    const placeholders = ids.map(() => "?").join(", ");
    const sql = isHost
      ? `SELECT submission_id, rowid
         FROM submissions
         WHERE slug = ? AND submission_id IN (${placeholders})`
      : `SELECT submission_id, rowid
         FROM submissions
         WHERE slug = ? AND lookup_id = ? AND submission_id IN (${placeholders})`;

    const bindings: unknown[] = isHost ? [slug, ...ids] : [slug, lookupId, ...ids];
    const queryResult = await env.DB.prepare(sql)
      .bind(...bindings)
      .all<SubmissionRowId>();

    for (const row of queryResult.results) {
      rowIdBySubmissionId.set(row.submission_id, row.rowid);
    }
  }

  const items: StatusItem[] = ids.map((submissionId) => {
    const rowid = rowIdBySubmissionId.get(submissionId);
    const server = rowid !== undefined;
    return {
      submissionId,
      server,
      tabRoom: server && rowid <= tournament.acked_through,
    };
  });

  const nowMs = now();
  const day = utcDay(nowMs);
  // Status performs zero D1 writes; record only the in-memory request count.
  recordUsage(slug, day, { requests: 1 }, nowMs);

  const responseBody: StatusResponse = {
    schema: SCHEMA_VERSION,
    items,
  };

  if (isHost) {
    const effective = await getEffectiveUsage(env.DB, slug, day);
    const remainingRequests = tournament.share_requests - effective.requests;
    const remainingWrites = tournament.share_writes - effective.writes;
    responseBody.shareLeft = Math.max(0, Math.min(remainingRequests, remainingWrites));
  }

  return jsonResponse(responseBody, 200);
}
