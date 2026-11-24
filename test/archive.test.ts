import {
  SELF,
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  bytesToHex,
  sha256,
  toBufferSource,
  utf8Decode,
  utf8Encode,
} from "@simpletab/core/crypto";
import { SCHEMA_VERSION, parseErrorBody } from "@simpletab/core/wire";
import {
  ARCHIVE_GRACE_PERIOD_MS,
  ARCHIVE_TABLES,
  archiveManifestKey,
  archivePartKey,
  gzipBytes,
  runArchiveTick,
  type ArchiveConfig,
  type ArchiveManifest,
  type ArchiveTickResult,
} from "../src/lib/archive";
import worker, { handleRequest } from "../src/worker";
import {
  approveTournamentViaAdmin,
  hostHeaders,
  makeLinkFixture,
  makePermitPayload,
  makeSignedSubmission,
  makeUlid,
  resetArchiveBucket,
  resetDatabase,
  seedAdmin,
  typedEnv,
} from "./helpers";

async function gunzipText(bytes: ArrayBuffer): Promise<string> {
  const stream = new Blob([bytes])
    .stream()
    .pipeThrough(new DecompressionStream("gzip"));
  const decompressed = await new Response(stream).arrayBuffer();
  return utf8Decode(new Uint8Array(decompressed));
}

async function seedTournamentData(
  slug: string,
  hostKey: string,
  counts: { permits: number; heads: number; usage: number; submissions: number },
): Promise<void> {
  const link = await makeLinkFixture(slug, "aabcdefghjkm8");
  for (let i = 1; i <= counts.permits; i++) {
    const permit = makePermitPayload(link, { roundId: `round-${i}`, version: i });
    const res = await SELF.fetch("https://ballots.test/v1/host/permits", {
      method: "POST",
      headers: hostHeaders(hostKey),
      body: JSON.stringify(permit),
    });
    expect(res.status).toBe(200);
  }

  for (let i = 1; i <= counts.heads; i++) {
    const headHash = i.toString(16).padStart(64, "0");
    const res = await SELF.fetch("https://ballots.test/v1/host/head", {
      method: "POST",
      headers: hostHeaders(hostKey),
      body: JSON.stringify({ schema: SCHEMA_VERSION, seq: i, headHash }),
    });
    expect(res.status).toBe(200);
  }

  for (let i = 1; i <= counts.usage; i++) {
    const day = `2026-10-${String(i).padStart(2, "0")}`;
    await typedEnv.DB.prepare(
      `INSERT INTO usage (slug, day, requests, writes, reg_writes)
       VALUES (?, ?, ?, ?, 0)`,
    )
      .bind(slug, day, i * 10, i * 2)
      .run();
  }

  if (counts.submissions > 0) {
    if (counts.permits === 0) {
      const permit = makePermitPayload(link, { roundId: "round-1", version: 1 });
      await SELF.fetch("https://ballots.test/v1/host/permits", {
        method: "POST",
        headers: hostHeaders(hostKey),
        body: JSON.stringify(permit),
      });
    }
    for (let i = 1; i <= counts.submissions; i++) {
      const body = await makeSignedSubmission({
        slug,
        link,
        roundId: "round-1",
        payload: { roomId: `room-${i}`, ranks: [1, 2, 3, 4] },
      });
      const res = await SELF.fetch("https://ballots.test/v1/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ status: "received" });
    }
  }
}

async function runUntilDone(
  nowMs: number,
  config?: ArchiveConfig,
  maxTicks = 100,
): Promise<ArchiveTickResult[]> {
  const results: ArchiveTickResult[] = [];
  for (let i = 0; i < maxTicks; i++) {
    const res = await runArchiveTick(typedEnv, nowMs + i * 1000, config);
    results.push(res);
    if (
      res.action === "idle" ||
      res.action === "error" ||
      res.action === "delete_capped" ||
      res.action === "delete_waiting"
    ) {
      break;
    }
  }
  return results;
}

describe("R2 archive state machine (design amendment 5)", () => {
  let adminEmail: string;
  const baseTime = Date.UTC(2026, 10, 24, 12, 0, 0);

  beforeEach(async () => {
    await resetDatabase();
    await resetArchiveBucket();
    adminEmail = await seedAdmin();
  });

  it("archives a closed tournament end-to-end, keeps tournaments row, verifies R2 content, and deletes D1 rows", async () => {
    const closedSlug = "closed-happy";
    const activeSlug = "active-untouched";
    const closedApproved = await approveTournamentViaAdmin(adminEmail, closedSlug);
    const activeApproved = await approveTournamentViaAdmin(adminEmail, activeSlug);

    await seedTournamentData(closedSlug, closedApproved.key, {
      permits: 2,
      heads: 3,
      usage: 2,
      submissions: 4,
    });
    await seedTournamentData(activeSlug, activeApproved.key, {
      permits: 1,
      heads: 1,
      usage: 1,
      submissions: 2,
    });

    const closeCtx = createExecutionContext();
    const closeRes = await handleRequest(
      new Request("https://ballots.test/v1/host/close", {
        method: "POST",
        headers: hostHeaders(closedApproved.key),
        body: JSON.stringify({}),
      }),
      typedEnv,
      closeCtx,
      () => baseTime,
    );
    await waitOnExecutionContext(closeCtx);
    expect(closeRes.status).toBe(200);

    const tAfterClose = await typedEnv.DB.prepare(
      "SELECT status, closed_at FROM tournaments WHERE slug = ?",
    )
      .bind(closedSlug)
      .first<{ status: string; closed_at: string | null }>();
    expect(tAfterClose).toEqual({
      status: "closed",
      closed_at: new Date(baseTime).toISOString(),
    });

    const archiveTime = baseTime + ARCHIVE_GRACE_PERIOD_MS + 1000;
    const ticks = await runUntilDone(archiveTime);
    expect(ticks.some((t) => t.action === "started")).toBe(true);
    expect(ticks.some((t) => t.action === "archived")).toBe(true);
    expect(ticks.some((t) => t.action === "completed")).toBe(true);
    expect(ticks[ticks.length - 1].action).toBe("idle");

    // tournaments row stays with status = 'archived'.
    const tArchived = await typedEnv.DB.prepare(
      "SELECT status, closed_at FROM tournaments WHERE slug = ?",
    )
      .bind(closedSlug)
      .first<{ status: string; closed_at: string | null }>();
    expect(tArchived?.status).toBe("archived");

    const expectedTotal = 2 + 3 + 2 + 4;
    const archiveRow = await typedEnv.DB.prepare(
      "SELECT slug, r2_key, rows FROM archives WHERE slug = ?",
    )
      .bind(closedSlug)
      .first<{ slug: string; r2_key: string; rows: number }>();
    expect(archiveRow).toEqual({
      slug: closedSlug,
      r2_key: archiveManifestKey(closedSlug),
      rows: expectedTotal,
    });

    // D1 rows for closedSlug are completely removed across the 4 data tables.
    for (const tbl of ARCHIVE_TABLES) {
      const cntRow = await typedEnv.DB.prepare(
        `SELECT COUNT(*) AS cnt FROM ${tbl} WHERE slug = ?`,
      )
        .bind(closedSlug)
        .first<{ cnt: number }>();
      expect(cntRow?.cnt).toBe(0);
    }

    // Active tournament rows remain completely untouched.
    const activeSubs = await typedEnv.DB.prepare(
      "SELECT COUNT(*) AS cnt FROM submissions WHERE slug = ?",
    )
      .bind(activeSlug)
      .first<{ cnt: number }>();
    expect(activeSubs?.cnt).toBe(2);

    // Manifest & parts in R2 decompress to exact NDJSON rows.
    const manifestObj = await typedEnv.ARCHIVE.get(archiveManifestKey(closedSlug));
    expect(manifestObj).not.toBeNull();
    const manifest = (await manifestObj!.json()) as ArchiveManifest;
    expect(manifest.schema).toBe(SCHEMA_VERSION);
    expect(manifest.slug).toBe(closedSlug);
    expect(manifest.counts).toEqual({
      permits: 2,
      heads: 3,
      usage: 2,
      submissions: 4,
    });
    expect(manifest.totalRows).toBe(expectedTotal);

    const parsedLines: Array<{ t: string; r: Record<string, unknown> }> = [];
    for (const part of manifest.parts) {
      const obj = await typedEnv.ARCHIVE.get(part.key);
      expect(obj).not.toBeNull();
      const text = await gunzipText(await obj!.arrayBuffer());
      const lines = text.trim().split("\n");
      expect(lines.length).toBe(part.rows);
      for (const line of lines) {
        parsedLines.push(JSON.parse(line) as { t: string; r: Record<string, unknown> });
      }
    }
    expect(parsedLines.length).toBe(expectedTotal);
    expect(parsedLines.filter((l) => l.t === "submissions").length).toBe(4);

    // /admin/usage includes per-tournament archive state.
    const usageResp = await SELF.fetch("https://ballots.test/admin/usage", {
      headers: { "Cf-Access-Authenticated-User-Email": adminEmail },
    });
    expect(usageResp.status).toBe(200);
    const usageJson = (await usageResp.json()) as {
      archive: { deletedToday: number; dailyDeleteLimit: number; erroredJobs: unknown[] };
      tournaments: Array<{
        slug: string;
        status: string;
        archive: {
          closedAt: string | null;
          phase: string | null;
          r2Key: string | null;
          archivedRows: number | null;
          error: string | null;
        };
      }>;
    };
    expect(usageJson.archive.erroredJobs).toEqual([]);
    const closedEntry = usageJson.tournaments.find((t) => t.slug === closedSlug);
    expect(closedEntry?.status).toBe("archived");
    expect(closedEntry?.archive).toMatchObject({
      phase: "done",
      r2Key: archiveManifestKey(closedSlug),
      archivedRows: expectedTotal,
      error: null,
    });
  });

  it("respects 1-hour grace period and stamps NULL closed_at on legacy closed rows", async () => {
    const slugWithTs = "grace-with-ts";
    const approvedA = await approveTournamentViaAdmin(adminEmail, slugWithTs);
    await seedTournamentData(slugWithTs, approvedA.key, {
      permits: 1,
      heads: 0,
      usage: 0,
      submissions: 0,
    });

    const closeCtx = createExecutionContext();
    await handleRequest(
      new Request("https://ballots.test/v1/host/close", {
        method: "POST",
        headers: hostHeaders(approvedA.key),
        body: JSON.stringify({}),
      }),
      typedEnv,
      closeCtx,
      () => baseTime,
    );
    await waitOnExecutionContext(closeCtx);

    // 1 ms before 1 hour -> idle.
    const tooEarly = await runArchiveTick(
      typedEnv,
      baseTime + ARCHIVE_GRACE_PERIOD_MS - 1,
    );
    expect(tooEarly).toEqual({ action: "idle" });

    const stillClosed = await typedEnv.DB.prepare(
      "SELECT status FROM tournaments WHERE slug = ?",
    )
      .bind(slugWithTs)
      .first<{ status: string }>();
    expect(stillClosed?.status).toBe("closed");

    // Legacy closed tournament with closed_at = NULL gets stamped first, then waits 1 hour.
    const legacySlug = "grace-legacy-null";
    const approvedB = await approveTournamentViaAdmin(adminEmail, legacySlug);
    await typedEnv.DB.prepare(
      "UPDATE tournaments SET status = 'closed', closed_at = NULL WHERE slug = ?",
    )
      .bind(legacySlug)
      .run();

    const stampTime = baseTime + 10_000;
    const stamped = await runArchiveTick(typedEnv, stampTime);
    expect(stamped).toEqual({ action: "stamped_closed_at", slug: legacySlug });

    const stampedRow = await typedEnv.DB.prepare(
      "SELECT status, closed_at FROM tournaments WHERE slug = ?",
    )
      .bind(legacySlug)
      .first<{ status: string; closed_at: string | null }>();
    expect(stampedRow).toEqual({
      status: "closed",
      closed_at: new Date(stampTime).toISOString(),
    });

    // At baseTime + 1h, slugWithTs starts (legacySlug still within grace period).
    const startedA = await runArchiveTick(
      typedEnv,
      baseTime + ARCHIVE_GRACE_PERIOD_MS,
    );
    expect(startedA).toEqual({ action: "started", slug: slugWithTs });

    await runUntilDone(baseTime + ARCHIVE_GRACE_PERIOD_MS + 1000);

    // Before stampTime + 1h, legacySlug is still waiting.
    const legacyWait = await runArchiveTick(
      typedEnv,
      stampTime + ARCHIVE_GRACE_PERIOD_MS - 1,
    );
    expect(legacyWait).toEqual({ action: "idle" });

    const legacyStart = await runArchiveTick(
      typedEnv,
      stampTime + ARCHIVE_GRACE_PERIOD_MS,
    );
    expect(legacyStart).toEqual({ action: "started", slug: legacySlug });
  });

  it("resumes after crash between R2 put and D1 update if sha256 matches, and errors on mismatch", async () => {
    const okSlug = "crash-resume-ok";
    const approvedOk = await approveTournamentViaAdmin(adminEmail, okSlug);
    await seedTournamentData(okSlug, approvedOk.key, {
      permits: 1,
      heads: 0,
      usage: 0,
      submissions: 0,
    });
    await typedEnv.DB.prepare(
      "UPDATE tournaments SET status = 'closed', closed_at = ? WHERE slug = ?",
    )
      .bind(new Date(baseTime).toISOString(), okSlug)
      .run();

    const tStart = baseTime + ARCHIVE_GRACE_PERIOD_MS + 1000;
    expect(await runArchiveTick(typedEnv, tStart)).toEqual({
      action: "started",
      slug: okSlug,
    });

    // Simulate a crash right after R2 put of part-00001 and before D1 batch commit.
    const permitRow = await typedEnv.DB.prepare(
      "SELECT slug, round_id, version, open, body FROM permits WHERE slug = ?",
    )
      .bind(okSlug)
      .first<{ slug: string; round_id: string; version: number; open: number; body: string }>();
    const ndjson = utf8Encode(`${JSON.stringify({ t: "permits", r: permitRow })}\n`);
    const gz = await gzipBytes(ndjson);
    const gzSha = bytesToHex(await sha256(gz));
    const partKey = archivePartKey(okSlug, 1);

    const prePut = await typedEnv.ARCHIVE.put(partKey, toBufferSource(gz), {
      sha256: gzSha,
      customMetadata: { marker: "pre-crash" },
    });
    expect(prePut).not.toBeNull();

    const resumed = await runArchiveTick(typedEnv, tStart + 1000);
    expect(resumed).toEqual({
      action: "exported_part",
      slug: okSlug,
      part: 1,
      table: "permits",
      rows: 1,
    });

    // Verify existing object was accepted, not overwritten.
    const afterHead = await typedEnv.ARCHIVE.head(partKey);
    expect(afterHead?.customMetadata?.marker).toBe("pre-crash");

    await runUntilDone(tStart + 2000);
    const archivedRow = await typedEnv.DB.prepare(
      "SELECT status FROM tournaments WHERE slug = ?",
    )
      .bind(okSlug)
      .first<{ status: string }>();
    expect(archivedRow?.status).toBe("archived");

    // Case B: mismatched existing object triggers error without overwriting and surfaces in /admin/usage.
    const badSlug = "crash-mismatch";
    const approvedBad = await approveTournamentViaAdmin(adminEmail, badSlug);
    await seedTournamentData(badSlug, approvedBad.key, {
      permits: 1,
      heads: 0,
      usage: 0,
      submissions: 0,
    });
    await typedEnv.DB.prepare(
      "UPDATE tournaments SET status = 'closed', closed_at = ? WHERE slug = ?",
    )
      .bind(new Date(baseTime).toISOString(), badSlug)
      .run();

    expect(await runArchiveTick(typedEnv, tStart + 10_000)).toEqual({
      action: "started",
      slug: badSlug,
    });

    const badPartKey = archivePartKey(badSlug, 1);
    const badBytes = utf8Encode("corrupt-or-different");
    const badSha = bytesToHex(await sha256(badBytes));
    await typedEnv.ARCHIVE.put(badPartKey, toBufferSource(badBytes), {
      sha256: badSha,
      customMetadata: { marker: "corrupt" },
    });

    const errTick = await runArchiveTick(typedEnv, tStart + 11_000);
    expect(errTick.action).toBe("error");
    expect(errTick.slug).toBe(badSlug);

    const badHeadAfter = await typedEnv.ARCHIVE.head(badPartKey);
    expect(badHeadAfter?.customMetadata?.marker).toBe("corrupt");

    const usageResp = await SELF.fetch("https://ballots.test/admin/usage", {
      headers: { "Cf-Access-Authenticated-User-Email": adminEmail },
    });
    const usageJson = (await usageResp.json()) as {
      archive: { erroredJobs: Array<{ slug: string; error: string }> };
    };
    expect(usageJson.archive.erroredJobs.some((j) => j.slug === badSlug)).toBe(true);
  });

  it("refuses to delete when D1 row count exceeds the manifest", async () => {
    const slug = "extra-rows-refuse";
    const approved = await approveTournamentViaAdmin(adminEmail, slug);
    await seedTournamentData(slug, approved.key, {
      permits: 1,
      heads: 2,
      usage: 0,
      submissions: 1,
    });
    await typedEnv.DB.prepare(
      "UPDATE tournaments SET status = 'closed', closed_at = ? WHERE slug = ?",
    )
      .bind(new Date(baseTime).toISOString(), slug)
      .run();

    const tStart = baseTime + ARCHIVE_GRACE_PERIOD_MS + 1000;
    // Advance until phase === 'delete' (right after 'archived' tick).
    for (let i = 0; i < 20; i++) {
      const res = await runArchiveTick(typedEnv, tStart + i * 1000);
      if (res.action === "archived") {
        break;
      }
    }

    // Inject an unexpected row directly into D1 after verification.
    await typedEnv.DB.prepare(
      `INSERT INTO heads (slug, seq, head_hash, published_at)
       VALUES (?, 999, ?, ?)`,
    )
      .bind(slug, "f".repeat(64), new Date(tStart).toISOString())
      .run();

    const deleteTick = await runArchiveTick(typedEnv, tStart + 30_000);
    expect(deleteTick.action).toBe("error");
    expect(deleteTick.table).toBe("heads");

    // Verify zero rows were deleted from any table.
    const headsCnt = await typedEnv.DB.prepare(
      "SELECT COUNT(*) AS cnt FROM heads WHERE slug = ?",
    )
      .bind(slug)
      .first<{ cnt: number }>();
    const subsCnt = await typedEnv.DB.prepare(
      "SELECT COUNT(*) AS cnt FROM submissions WHERE slug = ?",
    )
      .bind(slug)
      .first<{ cnt: number }>();
    expect(headsCnt?.cnt).toBe(3);
    expect(subsCnt?.cnt).toBe(1);

    // Subsequent tick does not touch the errored job.
    const nextTick = await runArchiveTick(typedEnv, tStart + 31_000);
    expect(nextTick).toEqual({ action: "idle" });
  });

  it("never deletes a submission newer than the archive and reports it", async () => {
    const slug = "newer-submission-kept";
    const approved = await approveTournamentViaAdmin(adminEmail, slug);
    await seedTournamentData(slug, approved.key, { permits: 1, heads: 1, usage: 0, submissions: 2 });
    await typedEnv.DB.prepare(
      "UPDATE tournaments SET status = 'closed', closed_at = ? WHERE slug = ?",
    )
      .bind(new Date(baseTime).toISOString(), slug)
      .run();

    const tStart = baseTime + ARCHIVE_GRACE_PERIOD_MS + 1000;
    for (let i = 0; i < 20; i++) {
      const res = await runArchiveTick(typedEnv, tStart + i * 1000);
      if (res.action === "archived") {
        break;
      }
    }

    // A row that should be impossible (routes refuse closed tournaments) appears after the
    // archive, followed by another tournament's row so it is not the table's newest.
    for (const [id, rowSlug] of [
      ["late-own", slug],
      ["later-elsewhere", "other-slug"],
    ] as const) {
      await typedEnv.DB.prepare(
        `INSERT INTO submissions (submission_id, slug, round_id, lookup_id, type, payload, received_at)
         VALUES (?, ?, 'r1', 'aabcdefghjkm8', 'checkin', '{}', ?)`,
      )
        .bind(id, rowSlug, new Date(tStart).toISOString())
        .run();
    }

    const ticks = await runUntilDone(tStart + 60_000);
    expect(ticks.at(-1)?.action).toBe("error");
    expect(ticks.at(-1)?.error).toContain("newer than the archive");
    const kept = await typedEnv.DB.prepare(
      "SELECT submission_id FROM submissions WHERE slug = ?",
    )
      .bind(slug)
      .all<{ submission_id: string }>();
    expect(kept.results.map((r) => r.submission_id)).toEqual(["late-own"]);
  });

  it("enforces the 5,000-row daily delete cap across runs and resets on the next UTC day", async () => {
    const slug = "daily-cap-test";
    await approveTournamentViaAdmin(adminEmail, slug);

    // Insert 5,200 heads rows in batches (D1/SQLite param limit friendly).
    for (let start = 1; start <= 5200; start += 20) {
      const stmts: D1PreparedStatement[] = [];
      for (let seq = start; seq < start + 20; seq++) {
        stmts.push(
          typedEnv.DB.prepare(
            `INSERT INTO heads (slug, seq, head_hash, published_at)
             VALUES (?, ?, ?, ?)`,
          ).bind(slug, seq, seq.toString(16).padStart(64, "0"), "2026-11-24T00:00:00.000Z"),
        );
      }
      await typedEnv.DB.batch(stmts);
    }

    await typedEnv.DB.prepare(
      "UPDATE tournaments SET status = 'closed', closed_at = ? WHERE slug = ?",
    )
      .bind(new Date(baseTime).toISOString(), slug)
      .run();

    const day1 = Date.UTC(2026, 10, 24, 15, 0, 0);
    // Export + manifest + verify with large part limit so test focuses on delete cap.
    for (let i = 0; i < 20; i++) {
      const res = await runArchiveTick(typedEnv, day1 + i * 1000, {
        maxRowsPerPart: 6000,
        maxBytesPerPart: 2 * 1024 * 1024,
      });
      if (res.action === "archived") {
        break;
      }
    }

    // 10 ticks * 500 rows/batch = 5,000 rows deleted on day1.
    for (let i = 0; i < 10; i++) {
      const del = await runArchiveTick(typedEnv, day1 + 30_000 + i * 1000);
      expect(del).toEqual({
        action: "deleted_batch",
        slug,
        table: "heads",
        rows: 500,
      });
    }

    // 11th tick on day1 hits the 5,000-row daily cap.
    const capped = await runArchiveTick(typedEnv, day1 + 50_000);
    expect(capped).toEqual({ action: "delete_capped", slug });

    const remainingDay1 = await typedEnv.DB.prepare(
      "SELECT COUNT(*) AS cnt FROM heads WHERE slug = ?",
    )
      .bind(slug)
      .first<{ cnt: number }>();
    expect(remainingDay1?.cnt).toBe(200);

    // Next UTC day: remaining 200 rows are deleted and job completes.
    const day2 = Date.UTC(2026, 10, 25, 0, 1, 0);
    const lastBatch = await runArchiveTick(typedEnv, day2);
    expect(lastBatch).toEqual({
      action: "deleted_batch",
      slug,
      table: "heads",
      rows: 200,
    });
    // The next run confirms nothing is left and marks the job done.
    const finished = await runArchiveTick(typedEnv, day2 + 600_000);
    expect(finished).toEqual({ action: "completed", slug, rows: 0 });

    const remainingDay2 = await typedEnv.DB.prepare(
      "SELECT COUNT(*) AS cnt FROM heads WHERE slug = ?",
    )
      .bind(slug)
      .first<{ cnt: number }>();
    expect(remainingDay2?.cnt).toBe(0);
  });

  it("refuses 'archiving' tournaments on submit, status, host routes, and admin reissue", async () => {
    const slug = "archiving-refused";
    const approved = await approveTournamentViaAdmin(adminEmail, slug);
    const link = await makeLinkFixture(slug, "aabcdefghjkm9");

    await SELF.fetch("https://ballots.test/v1/host/permits", {
      method: "POST",
      headers: hostHeaders(approved.key),
      body: JSON.stringify(makePermitPayload(link)),
    });

    await typedEnv.DB.prepare(
      "UPDATE tournaments SET status = 'closed', closed_at = ? WHERE slug = ?",
    )
      .bind(new Date(baseTime).toISOString(), slug)
      .run();

    const startRes = await runArchiveTick(
      typedEnv,
      baseTime + ARCHIVE_GRACE_PERIOD_MS + 1000,
    );
    expect(startRes).toEqual({ action: "started", slug });

    const submitRes = await SELF.fetch("https://ballots.test/v1/submit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(await makeSignedSubmission({ slug, link })),
    });
    expect(submitRes.status).toBe(409);
    const submitErr = parseErrorBody(await submitRes.json());
    expect(submitErr.ok && submitErr.value.code).toBe("ROUND_CLOSED");

    const statusRes = await SELF.fetch(
      `https://ballots.test/v1/status?slug=${slug}&lookupId=${link.lookupId}&ids=${makeUlid(99)}`,
    );
    expect(statusRes.status).toBe(409);

    const permitsRes = await SELF.fetch("https://ballots.test/v1/host/permits", {
      method: "POST",
      headers: hostHeaders(approved.key),
      body: JSON.stringify(makePermitPayload(link, { version: 2 })),
    });
    expect(permitsRes.status).toBe(409);

    const inboxRes = await SELF.fetch("https://ballots.test/v1/host/inbox", {
      headers: hostHeaders(approved.key),
    });
    expect(inboxRes.status).toBe(409);

    const ackRes = await SELF.fetch("https://ballots.test/v1/host/ack", {
      method: "POST",
      headers: hostHeaders(approved.key),
      body: JSON.stringify({ schema: SCHEMA_VERSION, through: 1 }),
    });
    expect(ackRes.status).toBe(409);

    const headRes = await SELF.fetch("https://ballots.test/v1/host/head", {
      method: "POST",
      headers: hostHeaders(approved.key),
      body: JSON.stringify({ schema: SCHEMA_VERSION, seq: 1, headHash: "a".repeat(64) }),
    });
    expect(headRes.status).toBe(409);

    const reissueRes = await SELF.fetch(
      `https://ballots.test/admin/tournaments/${slug}/reissue`,
      {
        method: "POST",
        headers: { "Cf-Access-Authenticated-User-Email": adminEmail },
      },
    );
    expect(reissueRes.status).toBe(409);

    // Close on an archiving tournament is idempotent.
    const closeAgain = await SELF.fetch("https://ballots.test/v1/host/close", {
      method: "POST",
      headers: hostHeaders(approved.key),
      body: JSON.stringify({}),
    });
    expect(closeAgain.status).toBe(200);
    expect(await closeAgain.json()).toEqual({
      schema: SCHEMA_VERSION,
      slug,
      status: "archiving",
    });
  });

  it("splits multi-part exports by row and byte caps, verifies in batches, and is idempotent when done", async () => {
    const slug = "multipart-idempotent";
    const approved = await approveTournamentViaAdmin(adminEmail, slug);
    await seedTournamentData(slug, approved.key, {
      permits: 3,
      heads: 3,
      usage: 3,
      submissions: 5,
    });

    await typedEnv.DB.prepare(
      "UPDATE tournaments SET status = 'closed', closed_at = ? WHERE slug = ?",
    )
      .bind(new Date(baseTime).toISOString(), slug)
      .run();

    const tStart = baseTime + ARCHIVE_GRACE_PERIOD_MS + 1000;
    const cfg: ArchiveConfig = {
      maxRowsPerPart: 2,
      maxBytesPerPart: 250,
      verifyBatchSize: 2,
      deleteBatchSize: 3,
    };

    const ticks = await runUntilDone(tStart, cfg, 200);
    const exported = ticks.filter((t) => t.action === "exported_part");
    const verifiedBatches = ticks.filter((t) => t.action === "verified_batch");
    expect(exported.length).toBeGreaterThanOrEqual(7);
    expect(verifiedBatches.length).toBeGreaterThanOrEqual(3);

    // Ensure part numbers are sequential 1..N in table order.
    expect(exported.map((e) => e.part)).toEqual(
      exported.map((_, idx) => idx + 1),
    );

    const manifestObj = await typedEnv.ARCHIVE.get(archiveManifestKey(slug));
    const manifest = (await manifestObj!.json()) as ArchiveManifest;
    expect(manifest.parts.length).toBe(exported.length);
    expect(manifest.totalRows).toBe(14);

    // This tournament owns the newest submission in the table, which is never deleted (SQLite
    // would reuse its rowid behind hosts' pull positions). The job waits instead of failing.
    expect(ticks.at(-1)).toEqual({ action: "delete_waiting", slug, table: "submissions" });
    const kept = await typedEnv.DB.prepare(
      "SELECT COUNT(*) AS n FROM submissions WHERE slug = ?",
    )
      .bind(slug)
      .first<{ n: number }>();
    expect(kept?.n).toBe(1);
    const waitingAgain = await runArchiveTick(typedEnv, tStart + 400_000, cfg);
    expect(waitingAgain.action).toBe("delete_waiting");

    // Once any newer submission exists, the last row goes and the job completes.
    await typedEnv.DB.prepare(
      `INSERT INTO submissions (submission_id, slug, round_id, lookup_id, type, payload, received_at)
       VALUES ('newer-elsewhere', 'other-slug', 'r1', 'aabcdefghjkm8', 'checkin', '{}', ?)`,
    )
      .bind(new Date(tStart).toISOString())
      .run();
    const lastBatch = await runArchiveTick(typedEnv, tStart + 450_000, cfg);
    expect(lastBatch).toEqual({ action: "deleted_batch", slug, table: "submissions", rows: 1 });
    const finished = await runArchiveTick(typedEnv, tStart + 460_000, cfg);
    expect(finished.action).toBe("completed");
    const left = await typedEnv.DB.prepare(
      "SELECT COUNT(*) AS n FROM submissions WHERE slug = ?",
    )
      .bind(slug)
      .first<{ n: number }>();
    expect(left?.n).toBe(0);

    // Extra ticks after completion are pure no-ops.
    const extra1 = await runArchiveTick(typedEnv, tStart + 500_000, cfg);
    const extra2 = await runArchiveTick(typedEnv, tStart + 600_000, cfg);
    expect(extra1).toEqual({ action: "idle" });
    expect(extra2).toEqual({ action: "idle" });

    // Exercise scheduled() entrypoint directly.
    const schedCtx = createExecutionContext();
    await worker.scheduled(
      {
        scheduledTime: tStart + 700_000,
        cron: "*/10 * * * *",
        noRetry() {},
      },
      typedEnv,
      schedCtx,
    );
    await waitOnExecutionContext(schedCtx);
  });
});
