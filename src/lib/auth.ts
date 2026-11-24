import {
  bytesToHex,
  constantTimeEqualStrings,
  sha256,
  utf8Encode,
} from "@simpletab/core/crypto";
import { errorResponse } from "./errors";

export type TournamentStatus =
  | "pending"
  | "active"
  | "paused"
  | "revoked"
  | "closed"
  | "archiving"
  | "archived";

export function isClosedStatus(status: TournamentStatus): boolean {
  return status === "closed" || status === "archiving" || status === "archived";
}

export interface TournamentRow {
  slug: string;
  key_hash: string | null;
  host_number: number;
  host_id: string | null;
  host_rank: number | null;
  status: TournamentStatus;
  share_requests: number;
  share_writes: number;
  cdn_origin: string | null;
  acked_through: number;
  reg_open: string | null;
  reg_close: string | null;
  reg_cap: number | null;
  closed_at: string | null;
  created_at: string;
}

export type KeyAuthResult =
  | { ok: true; tournament: TournamentRow }
  | { ok: false; response: Response };

export type HostAuthResult =
  | { ok: true; tournament: TournamentRow; hostUpdated: boolean }
  | { ok: false; response: Response };

export type AdminAuthResult =
  | { ok: true; email: string }
  | { ok: false; response: Response };

const POSITIVE_INT_RE = /^[1-9]\d*$/;
const MAX_IDEMPOTENCY_ENTRIES = 512;
const IDEMPOTENCY_TTL_MS = 15 * 60 * 1000;

interface CachedIdempotentResponse {
  status: number;
  body: string;
  contentType: string;
  storedAt: number;
}

const idempotencyCache = new Map<string, CachedIdempotentResponse>();

export async function hashTournamentKey(plainKey: string): Promise<string> {
  const digest = await sha256(utf8Encode(plainKey));
  return bytesToHex(digest);
}

export function extractBearerToken(request: Request): string | null {
  const header = request.headers.get("Authorization");
  if (!header) {
    return null;
  }
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match ? match[1] : null;
}

export async function authenticateTournamentKey(
  db: D1Database,
  request: Request,
): Promise<KeyAuthResult> {
  const token = extractBearerToken(request);
  if (!token) {
    return {
      ok: false,
      response: errorResponse("AUTH_INVALID", "Missing or malformed Authorization Bearer token"),
    };
  }

  const candidateHash = await hashTournamentKey(token);
  const row = await db
    .prepare(
      `SELECT slug, key_hash, host_number, host_id, host_rank, status,
              share_requests, share_writes, cdn_origin, acked_through,
              reg_open, reg_close, reg_cap, closed_at, created_at
       FROM tournaments
       WHERE key_hash = ?`,
    )
    .bind(candidateHash)
    .first<TournamentRow>();

  if (!row || !row.key_hash || !constantTimeEqualStrings(row.key_hash, candidateHash)) {
    return {
      ok: false,
      response: errorResponse("AUTH_INVALID", "Invalid tournament key"),
    };
  }

  if (row.status === "revoked") {
    return {
      ok: false,
      response: errorResponse("KEY_REVOKED", "Tournament key has been revoked"),
    };
  }

  if (row.status === "pending") {
    return {
      ok: false,
      response: errorResponse("AUTH_INVALID", "Tournament key is not active"),
    };
  }

  return { ok: true, tournament: row };
}

function parsePositiveHeaderInt(raw: string | null): number | null {
  if (raw === null) {
    return null;
  }
  const trimmed = raw.trim();
  if (!POSITIVE_INT_RE.test(trimmed)) {
    return null;
  }
  const value = Number(trimmed);
  if (!Number.isSafeInteger(value) || value < 1) {
    return null;
  }
  return value;
}

export async function authenticateHost(
  db: D1Database,
  request: Request,
): Promise<HostAuthResult> {
  const keyResult = await authenticateTournamentKey(db, request);
  if (!keyResult.ok) {
    return keyResult;
  }

  const reqNumber = parsePositiveHeaderInt(request.headers.get("X-Host-Number"));
  if (reqNumber === null) {
    return {
      ok: false,
      response: errorResponse("SCHEMA_INVALID", "X-Host-Number must be a positive integer"),
    };
  }

  const rawHostId = request.headers.get("X-Host-Id");
  const reqHostId = rawHostId ? rawHostId.trim() : "";
  if (reqHostId.length === 0 || reqHostId.length > 128) {
    return {
      ok: false,
      response: errorResponse("SCHEMA_INVALID", "X-Host-Id must be a non-empty string"),
    };
  }

  const rawRank = request.headers.get("X-Host-Rank");
  let reqRank = 1;
  if (rawRank !== null && rawRank.trim().length > 0) {
    const parsedRank = parsePositiveHeaderInt(rawRank);
    if (parsedRank === null) {
      return {
        ok: false,
        response: errorResponse("SCHEMA_INVALID", "X-Host-Rank must be a positive integer"),
      };
    }
    reqRank = parsedRank;
  }

  const tournament = keyResult.tournament;
  if (isClosedStatus(tournament.status)) {
    return { ok: true, hostUpdated: false, tournament };
  }

  const storedNumber = tournament.host_number;
  const storedHostId = tournament.host_id;
  const storedRank = tournament.host_rank;
  const hasStoredHostId = typeof storedHostId === "string" && storedHostId.length > 0;

  // Section 4 step 8 acceptance rule:
  // 1. higher host number
  // 2. equal host number and matching hostId
  // 3. equal host number and (stored host_id is empty OR request rank is lower than stored rank)
  const accepted =
    reqNumber > storedNumber ||
    (reqNumber === storedNumber && hasStoredHostId && reqHostId === storedHostId) ||
    (reqNumber === storedNumber &&
      (!hasStoredHostId || storedRank === null || reqRank < storedRank));

  if (!accepted) {
    return {
      ok: false,
      response: errorResponse(
        "HOST_STALE",
        `Host number ${reqNumber} (id=${reqHostId}, rank=${reqRank}) is stale`,
        { storedHostNumber: storedNumber },
      ),
    };
  }

  const needsUpdate =
    reqNumber !== storedNumber ||
    reqHostId !== storedHostId ||
    reqRank !== storedRank;

  if (needsUpdate) {
    await db
      .prepare(
        `UPDATE tournaments
         SET host_number = ?, host_id = ?, host_rank = ?
         WHERE slug = ?`,
      )
      .bind(reqNumber, reqHostId, reqRank, tournament.slug)
      .run();

    return {
      ok: true,
      hostUpdated: true,
      tournament: {
        ...tournament,
        host_number: reqNumber,
        host_id: reqHostId,
        host_rank: reqRank,
      },
    };
  }

  return { ok: true, hostUpdated: false, tournament };
}

export async function authenticateAdmin(
  db: D1Database,
  request: Request,
): Promise<AdminAuthResult> {
  const rawEmail = request.headers.get("Cf-Access-Authenticated-User-Email");
  const email = rawEmail ? rawEmail.trim().toLowerCase() : "";
  if (email.length === 0) {
    return {
      ok: false,
      response: errorResponse(
        "AUTH_INVALID",
        "Missing Cf-Access-Authenticated-User-Email header",
      ),
    };
  }

  const row = await db
    .prepare("SELECT email FROM admins WHERE LOWER(email) = ?")
    .bind(email)
    .first<{ email: string }>();

  if (!row) {
    return {
      ok: false,
      response: errorResponse("AUTH_INVALID", "User is not an authorized admin"),
    };
  }

  return { ok: true, email: row.email };
}

function buildIdempotencyKey(
  slug: string,
  method: string,
  pathname: string,
  requestId: string,
): string {
  return `${slug}\0${method}\0${pathname}\0${requestId}`;
}

export function getCachedIdempotentResponse(
  slug: string,
  request: Request,
  pathname: string,
  nowMs: number,
): Response | null {
  const rawId = request.headers.get("X-Request-Id");
  const requestId = rawId ? rawId.trim() : "";
  if (requestId.length === 0) {
    return null;
  }

  const key = buildIdempotencyKey(slug, request.method, pathname, requestId);
  const entry = idempotencyCache.get(key);
  if (!entry) {
    return null;
  }

  if (nowMs - entry.storedAt > IDEMPOTENCY_TTL_MS) {
    idempotencyCache.delete(key);
    return null;
  }

  // Refresh LRU order.
  idempotencyCache.delete(key);
  idempotencyCache.set(key, entry);

  return new Response(entry.body, {
    status: entry.status,
    headers: { "Content-Type": entry.contentType },
  });
}

export async function storeIdempotentResponse(
  slug: string,
  request: Request,
  pathname: string,
  response: Response,
  nowMs: number,
): Promise<Response> {
  const rawId = request.headers.get("X-Request-Id");
  const requestId = rawId ? rawId.trim() : "";
  if (requestId.length === 0) {
    return response;
  }

  const body = await response.clone().text();
  const contentType = response.headers.get("Content-Type") ?? "application/json; charset=utf-8";
  const key = buildIdempotencyKey(slug, request.method, pathname, requestId);

  if (idempotencyCache.has(key)) {
    idempotencyCache.delete(key);
  } else if (idempotencyCache.size >= MAX_IDEMPOTENCY_ENTRIES) {
    const oldestKey = idempotencyCache.keys().next().value;
    if (oldestKey !== undefined) {
      idempotencyCache.delete(oldestKey);
    }
  }

  idempotencyCache.set(key, {
    status: response.status,
    body,
    contentType,
    storedAt: nowMs,
  });

  return response;
}

export function resetIdempotencyCache(): void {
  idempotencyCache.clear();
}
