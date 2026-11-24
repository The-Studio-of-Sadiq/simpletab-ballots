import {
  bytesToHex,
  constantTimeEqualStrings,
  sha256,
  toBufferSource,
  utf8Encode,
} from "@simpletab/core/crypto";
import { SCHEMA_VERSION } from "@simpletab/core/wire";
import type { Env } from "../env";
import { utcDay } from "./usage";

export const ARCHIVE_TABLES = [
  "permits",
  "heads",
  "usage",
  "submissions",
] as const;

export type ArchiveTableName = (typeof ARCHIVE_TABLES)[number];

export type ArchivePhase =
  | "export"
  | "manifest"
  | "verify"
  | "delete"
  | "done";

export const ARCHIVE_GRACE_PERIOD_MS = 60 * 60 * 1000;
export const DEFAULT_MAX_ROWS_PER_PART = 200;
export const DEFAULT_MAX_BYTES_PER_PART = 128 * 1024;
export const DEFAULT_VERIFY_BATCH_SIZE = 100;
export const DEFAULT_DELETE_BATCH_SIZE = 500;
export const DEFAULT_MAX_DELETES_PER_DAY = 5_000;

export interface ArchiveConfig {
  gracePeriodMs?: number;
  maxRowsPerPart?: number;
  maxBytesPerPart?: number;
  verifyBatchSize?: number;
  deleteBatchSize?: number;
  maxDeletesPerDay?: number;
}

interface ResolvedArchiveConfig {
  gracePeriodMs: number;
  maxRowsPerPart: number;
  maxBytesPerPart: number;
  verifyBatchSize: number;
  deleteBatchSize: number;
  maxDeletesPerDay: number;
}

export interface ArchiveManifestPart {
  part: number;
  key: string;
  tbl: ArchiveTableName;
  rows: number;
  bytes: number;
  sha256: string;
}

export interface ArchiveManifest {
  schema: number;
  slug: string;
  createdAt: string;
  counts: Record<ArchiveTableName, number>;
  totalRows: number;
  parts: ArchiveManifestPart[];
  partsSha256: string;
}

export interface ArchiveJobRow {
  slug: string;
  phase: ArchivePhase;
  table_idx: number;
  cursor: string | null;
  next_part: number;
  max_submission_rowid: number;
  deleted_day: string | null;
  deleted_today: number;
  error: string | null;
  updated_at: string;
}

export interface ArchivePartRow {
  slug: string;
  part: number;
  tbl: ArchiveTableName;
  rows: number;
  bytes: number;
  sha256: string;
}

export type ArchiveTickAction =
  | "idle"
  | "stamped_closed_at"
  | "started"
  | "exported_part"
  | "advanced_export"
  | "wrote_manifest"
  | "verified_batch"
  | "archived"
  | "deleted_batch"
  | "delete_capped"
  | "delete_waiting"
  | "completed"
  | "error";

export interface ArchiveTickResult {
  action: ArchiveTickAction;
  slug?: string;
  part?: number;
  table?: ArchiveTableName;
  rows?: number;
  error?: string;
}

interface ExportRowItem {
  cursor: string;
  rowid: number;
  record: Record<string, unknown>;
}

interface PermitExportRow {
  slug: string;
  round_id: string;
  version: number;
  open: number;
  body: string;
}

interface HeadExportRow {
  slug: string;
  seq: number;
  head_hash: string;
  published_at: string;
}

interface UsageExportRow {
  slug: string;
  day: string;
  requests: number;
  writes: number;
  reg_writes: number;
}

interface SubmissionExportRow {
  rowid: number;
  submission_id: string;
  slug: string;
  round_id: string | null;
  lookup_id: string | null;
  type: string;
  payload: string;
  received_at: string;
}

function resolveConfig(config?: ArchiveConfig): ResolvedArchiveConfig {
  return {
    gracePeriodMs: config?.gracePeriodMs ?? ARCHIVE_GRACE_PERIOD_MS,
    maxRowsPerPart: config?.maxRowsPerPart ?? DEFAULT_MAX_ROWS_PER_PART,
    maxBytesPerPart: config?.maxBytesPerPart ?? DEFAULT_MAX_BYTES_PER_PART,
    verifyBatchSize: config?.verifyBatchSize ?? DEFAULT_VERIFY_BATCH_SIZE,
    deleteBatchSize: config?.deleteBatchSize ?? DEFAULT_DELETE_BATCH_SIZE,
    maxDeletesPerDay: config?.maxDeletesPerDay ?? DEFAULT_MAX_DELETES_PER_DAY,
  };
}

export function archivePartKey(slug: string, part: number): string {
  return `archive/${slug}/part-${String(part).padStart(5, "0")}.ndjson.gz`;
}

export function archiveManifestKey(slug: string): string {
  return `archive/${slug}.v1.manifest.json`;
}

function concatByteChunks(chunks: readonly Uint8Array[]): Uint8Array {
  let totalLength = 0;
  for (const chunk of chunks) {
    totalLength += chunk.byteLength;
  }
  const merged = new Uint8Array(new ArrayBuffer(totalLength));
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

export async function gzipBytes(input: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([toBufferSource(input)])
    .stream()
    .pipeThrough(new CompressionStream("gzip"));
  const buffer = await new Response(stream).arrayBuffer();
  return new Uint8Array(buffer);
}

export function extractR2Sha256Hex(checksums: R2Checksums): string | null {
  if (checksums.sha256) {
    return bytesToHex(new Uint8Array(checksums.sha256));
  }
  const json = checksums.toJSON();
  return typeof json.sha256 === "string" && json.sha256.length > 0
    ? json.sha256.toLowerCase()
    : null;
}

export async function computePartsSha256(
  parts: readonly { sha256: string }[],
): Promise<string> {
  const concatenated = parts.map((part) => part.sha256).join("");
  const digest = await sha256(utf8Encode(concatenated));
  return bytesToHex(digest);
}

function sanitizeErrorMessage(message: string): string {
  const singleLine = message.replace(/\s+/g, " ").trim();
  if (singleLine.length <= 200) {
    return singleLine;
  }
  return `${singleLine.slice(0, 197)}...`;
}

export async function recordJobError(
  db: D1Database,
  slug: string,
  message: string,
  nowIso: string,
): Promise<string> {
  const short = sanitizeErrorMessage(message);
  console.error(`[archive] slug=${slug} error=${short}`);
  await db
    .prepare(
      `UPDATE archive_jobs
       SET error = ?, updated_at = ?
       WHERE slug = ?`,
    )
    .bind(short, nowIso, slug)
    .run();
  return short;
}

export async function queryTableCounts(
  db: D1Database,
  slug: string,
): Promise<Record<ArchiveTableName, number>> {
  const [permits, heads, usage, submissions] = await Promise.all([
    db
      .prepare("SELECT COUNT(*) AS cnt FROM permits WHERE slug = ?")
      .bind(slug)
      .first<{ cnt: number }>(),
    db
      .prepare("SELECT COUNT(*) AS cnt FROM heads WHERE slug = ?")
      .bind(slug)
      .first<{ cnt: number }>(),
    db
      .prepare("SELECT COUNT(*) AS cnt FROM usage WHERE slug = ?")
      .bind(slug)
      .first<{ cnt: number }>(),
    db
      .prepare("SELECT COUNT(*) AS cnt FROM submissions WHERE slug = ?")
      .bind(slug)
      .first<{ cnt: number }>(),
  ]);

  return {
    permits: permits?.cnt ?? 0,
    heads: heads?.cnt ?? 0,
    usage: usage?.cnt ?? 0,
    submissions: submissions?.cnt ?? 0,
  };
}

export async function queryExpectedCounts(
  db: D1Database,
  slug: string,
): Promise<{ counts: Record<ArchiveTableName, number>; totalRows: number }> {
  const counts: Record<ArchiveTableName, number> = {
    permits: 0,
    heads: 0,
    usage: 0,
    submissions: 0,
  };
  const res = await db
    .prepare(
      `SELECT tbl, COALESCE(SUM(rows), 0) AS cnt
       FROM archive_parts
       WHERE slug = ?
       GROUP BY tbl`,
    )
    .bind(slug)
    .all<{ tbl: ArchiveTableName; cnt: number }>();

  let totalRows = 0;
  for (const row of res.results) {
    if (ARCHIVE_TABLES.includes(row.tbl)) {
      counts[row.tbl] = row.cnt;
      totalRows += row.cnt;
    }
  }
  return { counts, totalRows };
}

export async function getServiceDeletedToday(
  db: D1Database,
  day: string,
): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COALESCE(SUM(deleted_today), 0) AS total
       FROM archive_jobs
       WHERE deleted_day = ?`,
    )
    .bind(day)
    .first<{ total: number }>();
  return row?.total ?? 0;
}

async function fetchTableBatch(
  db: D1Database,
  slug: string,
  tbl: ArchiveTableName,
  cursor: string | null,
  limit: number,
): Promise<ExportRowItem[]> {
  if (tbl === "permits") {
    const stmt =
      cursor === null
        ? db
            .prepare(
              `SELECT slug, round_id, version, open, body
               FROM permits
               WHERE slug = ?
               ORDER BY round_id ASC
               LIMIT ?`,
            )
            .bind(slug, limit)
        : db
            .prepare(
              `SELECT slug, round_id, version, open, body
               FROM permits
               WHERE slug = ? AND round_id > ?
               ORDER BY round_id ASC
               LIMIT ?`,
            )
            .bind(slug, cursor, limit);
    const res = await stmt.all<PermitExportRow>();
    return res.results.map((row) => ({
      cursor: row.round_id,
      rowid: 0,
      record: { ...row },
    }));
  }

  if (tbl === "heads") {
    const stmt =
      cursor === null
        ? db
            .prepare(
              `SELECT slug, seq, head_hash, published_at
               FROM heads
               WHERE slug = ?
               ORDER BY seq ASC
               LIMIT ?`,
            )
            .bind(slug, limit)
        : db
            .prepare(
              `SELECT slug, seq, head_hash, published_at
               FROM heads
               WHERE slug = ? AND seq > ?
               ORDER BY seq ASC
               LIMIT ?`,
            )
            .bind(slug, Number(cursor), limit);
    const res = await stmt.all<HeadExportRow>();
    return res.results.map((row) => ({
      cursor: String(row.seq),
      rowid: 0,
      record: { ...row },
    }));
  }

  if (tbl === "usage") {
    const stmt =
      cursor === null
        ? db
            .prepare(
              `SELECT slug, day, requests, writes, reg_writes
               FROM usage
               WHERE slug = ?
               ORDER BY day ASC
               LIMIT ?`,
            )
            .bind(slug, limit)
        : db
            .prepare(
              `SELECT slug, day, requests, writes, reg_writes
               FROM usage
               WHERE slug = ? AND day > ?
               ORDER BY day ASC
               LIMIT ?`,
            )
            .bind(slug, cursor, limit);
    const res = await stmt.all<UsageExportRow>();
    return res.results.map((row) => ({
      cursor: row.day,
      rowid: 0,
      record: { ...row },
    }));
  }

  const stmt =
    cursor === null
      ? db
          .prepare(
            `SELECT rowid, submission_id, slug, round_id, lookup_id, type, payload, received_at
             FROM submissions
             WHERE slug = ?
             ORDER BY rowid ASC
             LIMIT ?`,
          )
          .bind(slug, limit)
      : db
          .prepare(
            `SELECT rowid, submission_id, slug, round_id, lookup_id, type, payload, received_at
             FROM submissions
             WHERE slug = ? AND rowid > ?
             ORDER BY rowid ASC
             LIMIT ?`,
          )
          .bind(slug, Number(cursor), limit);
  const res = await stmt.all<SubmissionExportRow>();
  return res.results.map((row) => ({
    cursor: String(row.rowid),
    rowid: row.rowid,
    record: { ...row },
  }));
}

export async function runStartPhase(
  env: Env,
  slug: string,
  nowIso: string,
): Promise<ArchiveTickResult> {
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE tournaments
       SET status = 'archiving'
       WHERE slug = ? AND status = 'closed'`,
    ).bind(slug),
    env.DB.prepare(
      `INSERT INTO archive_jobs (
         slug, phase, table_idx, cursor, next_part,
         max_submission_rowid, deleted_day, deleted_today, error, updated_at
       )
       VALUES (?, 'export', 0, NULL, 1, 0, NULL, 0, NULL, ?)`,
    ).bind(slug, nowIso),
  ]);
  return { action: "started", slug };
}

export async function runExportStep(
  env: Env,
  job: ArchiveJobRow,
  nowIso: string,
  cfg: ResolvedArchiveConfig,
): Promise<ArchiveTickResult> {
  let tableIdx = job.table_idx;
  let cursor = job.cursor;

  while (tableIdx < ARCHIVE_TABLES.length) {
    const tbl = ARCHIVE_TABLES[tableIdx];
    const rows = await fetchTableBatch(
      env.DB,
      job.slug,
      tbl,
      cursor,
      cfg.maxRowsPerPart,
    );
    if (rows.length === 0) {
      tableIdx += 1;
      cursor = null;
      continue;
    }

    const lineChunks: Uint8Array[] = [];
    const selectedRows: ExportRowItem[] = [];
    let ndjsonSize = 0;

    for (const item of rows) {
      const encoded = utf8Encode(`${JSON.stringify({ t: tbl, r: item.record })}\n`);
      if (selectedRows.length > 0 && ndjsonSize + encoded.byteLength > cfg.maxBytesPerPart) {
        break;
      }
      lineChunks.push(encoded);
      selectedRows.push(item);
      ndjsonSize += encoded.byteLength;
    }

    const ndjsonBytes = concatByteChunks(lineChunks);
    const gzBytes = await gzipBytes(ndjsonBytes);
    const gzSha256Hex = bytesToHex(await sha256(gzBytes));
    const key = archivePartKey(job.slug, job.next_part);

    const existing = await env.ARCHIVE.head(key);
    let storedBytes: number;
    if (existing !== null) {
      const existingSha = extractR2Sha256Hex(existing.checksums);
      if (!existingSha || !constantTimeEqualStrings(existingSha, gzSha256Hex)) {
        const error = await recordJobError(
          env.DB,
          job.slug,
          `R2 part ${job.next_part} already exists with mismatched sha256`,
          nowIso,
        );
        return { action: "error", slug: job.slug, part: job.next_part, table: tbl, error };
      }
      storedBytes = existing.size;
    } else {
      await env.ARCHIVE.put(key, toBufferSource(gzBytes), {
        sha256: gzSha256Hex,
        httpMetadata: { contentType: "application/gzip" },
      });
      storedBytes = gzBytes.byteLength;
    }

    const lastRow = selectedRows[selectedRows.length - 1];
    const maxSubmissionRowid =
      tbl === "submissions"
        ? Math.max(job.max_submission_rowid, lastRow.rowid)
        : job.max_submission_rowid;

    const tableExhausted =
      selectedRows.length === rows.length && rows.length < cfg.maxRowsPerPart;

    let nextPhase: ArchivePhase = "export";
    let nextTableIdx = tableIdx;
    let nextCursor: string | null = lastRow.cursor;

    if (tableExhausted) {
      if (tableIdx + 1 < ARCHIVE_TABLES.length) {
        nextTableIdx = tableIdx + 1;
        nextCursor = null;
      } else {
        nextPhase = "manifest";
        nextTableIdx = ARCHIVE_TABLES.length;
        nextCursor = null;
      }
    }

    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO archive_parts (slug, part, tbl, rows, bytes, sha256)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).bind(job.slug, job.next_part, tbl, selectedRows.length, storedBytes, gzSha256Hex),
      env.DB.prepare(
        `UPDATE archive_jobs
         SET phase = ?, table_idx = ?, cursor = ?, next_part = ?,
             max_submission_rowid = ?, error = NULL, updated_at = ?
         WHERE slug = ?`,
      ).bind(
        nextPhase,
        nextTableIdx,
        nextCursor,
        job.next_part + 1,
        maxSubmissionRowid,
        nowIso,
        job.slug,
      ),
    ]);

    return {
      action: "exported_part",
      slug: job.slug,
      part: job.next_part,
      table: tbl,
      rows: selectedRows.length,
    };
  }

  await env.DB.prepare(
    `UPDATE archive_jobs
     SET phase = 'manifest', table_idx = ?, cursor = NULL, error = NULL, updated_at = ?
     WHERE slug = ?`,
  )
    .bind(ARCHIVE_TABLES.length, nowIso, job.slug)
    .run();

  return { action: "advanced_export", slug: job.slug };
}

function isMatchingManifest(
  raw: unknown,
  slug: string,
  counts: Record<ArchiveTableName, number>,
  totalRows: number,
  partsSha256: string,
): boolean {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return false;
  }
  const obj = raw as Record<string, unknown>;
  if (
    obj.schema !== SCHEMA_VERSION ||
    obj.slug !== slug ||
    obj.totalRows !== totalRows ||
    typeof obj.partsSha256 !== "string" ||
    !constantTimeEqualStrings(obj.partsSha256, partsSha256)
  ) {
    return false;
  }
  if (typeof obj.counts !== "object" || obj.counts === null || Array.isArray(obj.counts)) {
    return false;
  }
  const parsedCounts = obj.counts as Record<string, unknown>;
  for (const tbl of ARCHIVE_TABLES) {
    if (parsedCounts[tbl] !== counts[tbl]) {
      return false;
    }
  }
  return true;
}

export async function runManifestStep(
  env: Env,
  job: ArchiveJobRow,
  nowIso: string,
): Promise<ArchiveTickResult> {
  const partsRes = await env.DB.prepare(
    `SELECT slug, part, tbl, rows, bytes, sha256
     FROM archive_parts
     WHERE slug = ?
     ORDER BY part ASC`,
  )
    .bind(job.slug)
    .all<ArchivePartRow>();

  const counts: Record<ArchiveTableName, number> = {
    permits: 0,
    heads: 0,
    usage: 0,
    submissions: 0,
  };
  let totalRows = 0;

  const manifestParts: ArchiveManifestPart[] = partsRes.results.map((part) => {
    counts[part.tbl] += part.rows;
    totalRows += part.rows;
    return {
      part: part.part,
      key: archivePartKey(job.slug, part.part),
      tbl: part.tbl,
      rows: part.rows,
      bytes: part.bytes,
      sha256: part.sha256,
    };
  });

  const partsSha256 = await computePartsSha256(manifestParts);
  const manifestKey = archiveManifestKey(job.slug);
  const existing = await env.ARCHIVE.head(manifestKey);

  if (existing !== null) {
    const obj = await env.ARCHIVE.get(manifestKey);
    let matches = false;
    if (obj !== null) {
      try {
        const parsed: unknown = await obj.json();
        matches = isMatchingManifest(parsed, job.slug, counts, totalRows, partsSha256);
      } catch {
        matches = false;
      }
    }
    if (!matches) {
      const error = await recordJobError(
        env.DB,
        job.slug,
        "Existing R2 manifest does not match archive_parts",
        nowIso,
      );
      return { action: "error", slug: job.slug, error };
    }
  } else {
    const manifest: ArchiveManifest = {
      schema: SCHEMA_VERSION,
      slug: job.slug,
      createdAt: nowIso,
      counts,
      totalRows,
      parts: manifestParts,
      partsSha256,
    };
    const manifestBytes = utf8Encode(JSON.stringify(manifest));
    const manifestShaHex = bytesToHex(await sha256(manifestBytes));
    await env.ARCHIVE.put(manifestKey, toBufferSource(manifestBytes), {
      sha256: manifestShaHex,
      httpMetadata: { contentType: "application/json; charset=utf-8" },
    });
  }

  await env.DB.prepare(
    `UPDATE archive_jobs
     SET phase = 'verify', cursor = '0', error = NULL, updated_at = ?
     WHERE slug = ?`,
  )
    .bind(nowIso, job.slug)
    .run();

  return { action: "wrote_manifest", slug: job.slug, rows: totalRows };
}

export async function runVerifyStep(
  env: Env,
  job: ArchiveJobRow,
  nowIso: string,
  cfg: ResolvedArchiveConfig,
): Promise<ArchiveTickResult> {
  const verifiedThrough = job.cursor !== null ? Number(job.cursor) : 0;
  const manifestKey = archiveManifestKey(job.slug);

  if (verifiedThrough === 0) {
    const manifestObj = await env.ARCHIVE.head(manifestKey);
    if (!manifestObj) {
      const error = await recordJobError(
        env.DB,
        job.slug,
        "Missing R2 manifest during verify",
        nowIso,
      );
      return { action: "error", slug: job.slug, error };
    }
  }

  const partsRes = await env.DB.prepare(
    `SELECT slug, part, tbl, rows, bytes, sha256
     FROM archive_parts
     WHERE slug = ? AND part > ?
     ORDER BY part ASC
     LIMIT ?`,
  )
    .bind(job.slug, verifiedThrough, cfg.verifyBatchSize + 1)
    .all<ArchivePartRow>();

  const hasMore = partsRes.results.length > cfg.verifyBatchSize;
  const batch = hasMore
    ? partsRes.results.slice(0, cfg.verifyBatchSize)
    : partsRes.results;

  for (const part of batch) {
    const obj = await env.ARCHIVE.head(archivePartKey(job.slug, part.part));
    if (!obj) {
      const error = await recordJobError(
        env.DB,
        job.slug,
        `Missing R2 part ${part.part} during verify`,
        nowIso,
      );
      return { action: "error", slug: job.slug, part: part.part, error };
    }
    const actualSha = extractR2Sha256Hex(obj.checksums);
    if (
      obj.size !== part.bytes ||
      !actualSha ||
      !constantTimeEqualStrings(actualSha, part.sha256)
    ) {
      const error = await recordJobError(
        env.DB,
        job.slug,
        `R2 part ${part.part} checksum or size mismatch during verify`,
        nowIso,
      );
      return { action: "error", slug: job.slug, part: part.part, error };
    }
  }

  if (hasMore) {
    const lastPart = batch[batch.length - 1].part;
    await env.DB.prepare(
      `UPDATE archive_jobs
       SET cursor = ?, error = NULL, updated_at = ?
       WHERE slug = ?`,
    )
      .bind(String(lastPart), nowIso, job.slug)
      .run();
    return { action: "verified_batch", slug: job.slug, part: lastPart };
  }

  const [d1Counts, expected] = await Promise.all([
    queryTableCounts(env.DB, job.slug),
    queryExpectedCounts(env.DB, job.slug),
  ]);

  for (const tbl of ARCHIVE_TABLES) {
    if (d1Counts[tbl] !== expected.counts[tbl]) {
      const error = await recordJobError(
        env.DB,
        job.slug,
        `Verify count mismatch for ${tbl}: d1=${d1Counts[tbl]} archive=${expected.counts[tbl]}`,
        nowIso,
      );
      return { action: "error", slug: job.slug, table: tbl, error };
    }
  }

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO archives (slug, r2_key, rows, archived_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(slug) DO UPDATE SET
         r2_key = excluded.r2_key,
         rows = excluded.rows,
         archived_at = excluded.archived_at`,
    ).bind(job.slug, manifestKey, expected.totalRows, nowIso),
    env.DB.prepare(
      `UPDATE tournaments
       SET status = 'archived'
       WHERE slug = ?`,
    ).bind(job.slug),
    env.DB.prepare(
      `UPDATE archive_jobs
       SET phase = 'delete', table_idx = 0, cursor = NULL, error = NULL, updated_at = ?
       WHERE slug = ?`,
    ).bind(nowIso, job.slug),
  ]);

  return { action: "archived", slug: job.slug, rows: expected.totalRows };
}

type SmallArchiveTable = Exclude<ArchiveTableName, "submissions">;
const SMALL_ARCHIVE_TABLES: readonly SmallArchiveTable[] = ["permits", "heads", "usage"];

/**
 * Counts this tournament's rows in permits, heads and usage. Their primary keys start with the
 * slug, so these are index lookups. submissions has no slug index (one fewer written row per
 * submission), so it is never counted on every delete run.
 */
async function querySmallTableCounts(
  db: D1Database,
  slug: string,
): Promise<Record<SmallArchiveTable, number>> {
  const [permits, heads, usage] = await Promise.all(
    SMALL_ARCHIVE_TABLES.map((tbl) =>
      db
        .prepare(`SELECT COUNT(*) AS cnt FROM ${tbl} WHERE slug = ?`)
        .bind(slug)
        .first<{ cnt: number }>(),
    ),
  );
  return {
    permits: permits?.cnt ?? 0,
    heads: heads?.cnt ?? 0,
    usage: usage?.cnt ?? 0,
  };
}

async function deleteSmallTableBatch(
  db: D1Database,
  slug: string,
  tbl: SmallArchiveTable,
  limit: number,
): Promise<number> {
  const res = await db
    .prepare(
      `DELETE FROM ${tbl}
       WHERE rowid IN (SELECT rowid FROM ${tbl} WHERE slug = ? LIMIT ?)`,
    )
    .bind(slug, limit)
    .run();
  return res.meta?.changes ?? 0;
}

async function recordDeleted(
  db: D1Database,
  job: ArchiveJobRow,
  today: string,
  deletedCount: number,
  tableIdx: number,
  cursor: string | null,
  nowIso: string,
): Promise<void> {
  const deletedToday =
    job.deleted_day === today ? job.deleted_today + deletedCount : deletedCount;
  await db
    .prepare(
      `UPDATE archive_jobs
       SET table_idx = ?, cursor = ?, deleted_day = ?, deleted_today = ?,
           error = NULL, updated_at = ?
       WHERE slug = ?`,
    )
    .bind(tableIdx, cursor, today, deletedToday, nowIso, job.slug)
    .run();
}

/**
 * One bounded delete batch for an archived tournament. Small tables go first; then submissions,
 * walked by a rowid cursor (kept in archive_jobs.cursor) up to the highest exported rowid, so each
 * row is read about once instead of the whole table being scanned on every run.
 */
export async function runDeleteStep(
  env: Env,
  job: ArchiveJobRow,
  nowMs: number,
  nowIso: string,
  cfg: ResolvedArchiveConfig,
): Promise<ArchiveTickResult> {
  const [tournamentRow, archiveRow, smallCounts, expected] = await Promise.all([
    env.DB.prepare("SELECT status FROM tournaments WHERE slug = ?")
      .bind(job.slug)
      .first<{ status: string }>(),
    env.DB.prepare("SELECT rows FROM archives WHERE slug = ?")
      .bind(job.slug)
      .first<{ rows: number }>(),
    querySmallTableCounts(env.DB, job.slug),
    queryExpectedCounts(env.DB, job.slug),
  ]);

  if (!tournamentRow || tournamentRow.status !== "archived" || !archiveRow) {
    const error = await recordJobError(
      env.DB,
      job.slug,
      "Refusing delete: tournament is not verified as archived",
      nowIso,
    );
    return { action: "error", slug: job.slug, error };
  }

  if (expected.totalRows !== archiveRow.rows) {
    const error = await recordJobError(
      env.DB,
      job.slug,
      `Refusing delete: archive_parts total (${expected.totalRows}) != archives.rows (${archiveRow.rows})`,
      nowIso,
    );
    return { action: "error", slug: job.slug, error };
  }

  for (const tbl of SMALL_ARCHIVE_TABLES) {
    if (smallCounts[tbl] > expected.counts[tbl]) {
      const error = await recordJobError(
        env.DB,
        job.slug,
        `Refusing delete: D1 count for ${tbl} (${smallCounts[tbl]}) exceeds manifest (${expected.counts[tbl]})`,
        nowIso,
      );
      return { action: "error", slug: job.slug, table: tbl, error };
    }
  }

  const today = utcDay(nowMs);
  const remainingToday = cfg.maxDeletesPerDay - (await getServiceDeletedToday(env.DB, today));
  if (remainingToday <= 0) {
    return { action: "delete_capped", slug: job.slug };
  }
  const batchLimit = Math.min(cfg.deleteBatchSize, remainingToday);

  const smallTable = SMALL_ARCHIVE_TABLES.find((tbl) => smallCounts[tbl] > 0);
  if (smallTable !== undefined) {
    const deletedCount = await deleteSmallTableBatch(env.DB, job.slug, smallTable, batchLimit);
    if (deletedCount === 0) {
      const error = await recordJobError(
        env.DB,
        job.slug,
        `Delete made no progress for ${smallTable}`,
        nowIso,
      );
      return { action: "error", slug: job.slug, table: smallTable, error };
    }
    await recordDeleted(
      env.DB,
      job,
      today,
      deletedCount,
      ARCHIVE_TABLES.indexOf(smallTable),
      null,
      nowIso,
    );
    return { action: "deleted_batch", slug: job.slug, table: smallTable, rows: deletedCount };
  }

  const submissionsIdx = ARCHIVE_TABLES.indexOf("submissions");
  const parsedCursor = job.table_idx === submissionsIdx ? Number(job.cursor ?? "0") : 0;
  const cursor = Number.isSafeInteger(parsedCursor) && parsedCursor > 0 ? parsedCursor : 0;

  const batch = await env.DB.prepare(
    `SELECT rowid FROM submissions
     WHERE rowid > ? AND rowid <= ? AND slug = ?
     ORDER BY rowid ASC
     LIMIT ?`,
  )
    .bind(cursor, job.max_submission_rowid, job.slug, batchLimit)
    .all<{ rowid: number }>();

  if (batch.results.length === 0) {
    // Every exported submission is gone. One full count (the only one) confirms nothing newer
    // than the archive is left; such rows are never deleted, only reported.
    const left = await env.DB.prepare("SELECT COUNT(*) AS cnt FROM submissions WHERE slug = ?")
      .bind(job.slug)
      .first<{ cnt: number }>();
    const leftCount = left?.cnt ?? 0;
    if (leftCount > 0) {
      const error = await recordJobError(
        env.DB,
        job.slug,
        `Refusing delete: ${leftCount} submissions are newer than the archive`,
        nowIso,
      );
      return { action: "error", slug: job.slug, table: "submissions", error };
    }
    await env.DB.prepare(
      `UPDATE archive_jobs
       SET phase = 'done', table_idx = ?, cursor = NULL, error = NULL, updated_at = ?
       WHERE slug = ?`,
    )
      .bind(ARCHIVE_TABLES.length, nowIso, job.slug)
      .run();
    return { action: "completed", slug: job.slug, rows: 0 };
  }

  // The newest submission in the whole table is never deleted: SQLite would give its rowid to the
  // next submission, behind hosts' pull positions, and that submission would be missed. It goes
  // on a later run, once any newer submission exists.
  const maxRow = await env.DB.prepare("SELECT MAX(rowid) AS hi FROM submissions").first<{
    hi: number | null;
  }>();
  const lastSelected = batch.results[batch.results.length - 1].rowid;
  const upper = Math.min(lastSelected, (maxRow?.hi ?? 0) - 1);
  if (upper <= cursor) {
    return { action: "delete_waiting", slug: job.slug, table: "submissions" };
  }

  const res = await env.DB.prepare(
    "DELETE FROM submissions WHERE slug = ? AND rowid > ? AND rowid <= ?",
  )
    .bind(job.slug, cursor, upper)
    .run();
  const deletedCount = res.meta?.changes ?? 0;
  await recordDeleted(env.DB, job, today, deletedCount, submissionsIdx, String(upper), nowIso);
  return { action: "deleted_batch", slug: job.slug, table: "submissions", rows: deletedCount };
}

export async function runArchiveTick(
  env: Env,
  nowMs: number,
  config?: ArchiveConfig,
): Promise<ArchiveTickResult> {
  const cfg = resolveConfig(config);
  const nowIso = new Date(nowMs).toISOString();

  const activeJob = await env.DB.prepare(
    `SELECT j.slug, j.phase, j.table_idx, j.cursor, j.next_part,
            j.max_submission_rowid, j.deleted_day, j.deleted_today, j.error, j.updated_at
     FROM archive_jobs j
     JOIN tournaments t ON t.slug = j.slug
     WHERE j.phase IN ('export', 'manifest', 'verify') AND j.error IS NULL
     ORDER BY COALESCE(t.closed_at, t.created_at) ASC, j.slug ASC
     LIMIT 1`,
  ).first<ArchiveJobRow>();

  if (activeJob) {
    try {
      if (activeJob.phase === "export") {
        return await runExportStep(env, activeJob, nowIso, cfg);
      }
      if (activeJob.phase === "manifest") {
        return await runManifestStep(env, activeJob, nowIso);
      }
      return await runVerifyStep(env, activeJob, nowIso, cfg);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const error = await recordJobError(env.DB, activeJob.slug, msg, nowIso);
      return { action: "error", slug: activeJob.slug, error };
    }
  }

  const legacyClosed = await env.DB.prepare(
    `SELECT slug
     FROM tournaments
     WHERE status = 'closed' AND closed_at IS NULL
     ORDER BY created_at ASC, slug ASC
     LIMIT 1`,
  ).first<{ slug: string }>();

  if (legacyClosed) {
    await env.DB.prepare(
      `UPDATE tournaments
       SET closed_at = ?
       WHERE slug = ? AND status = 'closed' AND closed_at IS NULL`,
    )
      .bind(nowIso, legacyClosed.slug)
      .run();
    return { action: "stamped_closed_at", slug: legacyClosed.slug };
  }

  const candidates = await env.DB.prepare(
    `SELECT t.slug, t.closed_at
     FROM tournaments t
     WHERE t.status = 'closed'
       AND t.closed_at IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM archive_jobs j WHERE j.slug = t.slug)
     ORDER BY t.closed_at ASC, t.slug ASC
     LIMIT 50`,
  ).all<{ slug: string; closed_at: string }>();

  for (const row of candidates.results) {
    const closedMs = Date.parse(row.closed_at);
    if (Number.isFinite(closedMs) && nowMs - closedMs >= cfg.gracePeriodMs) {
      return await runStartPhase(env, row.slug, nowIso);
    }
  }

  const deleteJob = await env.DB.prepare(
    `SELECT j.slug, j.phase, j.table_idx, j.cursor, j.next_part,
            j.max_submission_rowid, j.deleted_day, j.deleted_today, j.error, j.updated_at
     FROM archive_jobs j
     JOIN tournaments t ON t.slug = j.slug
     WHERE j.phase = 'delete' AND j.error IS NULL
     ORDER BY COALESCE(t.closed_at, t.created_at) ASC, j.slug ASC
     LIMIT 1`,
  ).first<ArchiveJobRow>();

  // Deletes come last: starting a new archive (a safety copy) matters more than freeing D1 rows.
  if (deleteJob) {
    const today = utcDay(nowMs);
    const totalDeletedToday = await getServiceDeletedToday(env.DB, today);
    if (totalDeletedToday < cfg.maxDeletesPerDay) {
      try {
        return await runDeleteStep(env, deleteJob, nowMs, nowIso, cfg);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        const error = await recordJobError(env.DB, deleteJob.slug, msg, nowIso);
        return { action: "error", slug: deleteJob.slug, error };
      }
    }
  }

  if (deleteJob) {
    return { action: "delete_capped", slug: deleteJob.slug };
  }

  return { action: "idle" };
}
