import type { PublicHeadsResponse } from "@simpletab/core/wire";
import { SCHEMA_VERSION } from "@simpletab/core/wire";
import type { Clock, Env } from "../env";
import { errorResponse, jsonResponse } from "../lib/errors";
import { recordUsage, utcDay } from "../lib/usage";

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

/**
 * Public, read-only list of every head a tournament's host has sent (design section 5,
 * "Anchoring"). The public site's Verify page calls it only when someone presses Verify, from the
 * tournament's own CDN origin, so it allows any origin and is cached for a minute.
 * Heads are moved to the R2 archive with the rest of a closed tournament (section 7.1); after that
 * the list is empty and `archived` is true.
 */
export async function handlePublicHeads(
  env: Env,
  url: URL,
  now: Clock,
): Promise<Response> {
  const slug = decodeURIComponent(url.pathname.slice("/v1/heads/".length));
  if (!SLUG_RE.test(slug)) {
    return withCors(errorResponse("SCHEMA_INVALID", "slug: invalid tournament slug"));
  }

  const tournament = await env.DB.prepare("SELECT status FROM tournaments WHERE slug = ?")
    .bind(slug)
    .first<{ status: string }>();
  if (!tournament || tournament.status === "pending") {
    return withCors(errorResponse("NOT_FOUND", "Tournament not found"));
  }

  // (slug, seq) is the primary key, so this reads only this tournament's heads.
  const rows = await env.DB.prepare(
    `SELECT seq, head_hash, published_at FROM heads WHERE slug = ? ORDER BY seq ASC`,
  )
    .bind(slug)
    .all<{ seq: number; head_hash: string; published_at: string }>();

  const body: PublicHeadsResponse & { archived?: boolean } = {
    schema: SCHEMA_VERSION,
    slug,
    heads: rows.results.map((row) => ({
      seq: row.seq,
      headHash: row.head_hash,
      publishedAt: row.published_at,
    })),
    ...(tournament.status === "archived" || tournament.status === "archiving"
      ? { archived: true }
      : {}),
  };

  const nowMs = now();
  recordUsage(slug, utcDay(nowMs), { requests: 1 }, nowMs);

  return withCors(
    jsonResponse(body, 200, { "Cache-Control": "public, max-age=60" }),
  );
}

function withCors(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Vary", "Origin");
  return new Response(response.body, { status: response.status, headers });
}
