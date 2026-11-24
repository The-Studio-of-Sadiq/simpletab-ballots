import {
  SELF,
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  SCHEMA_VERSION,
  parseErrorBody,
  parseStatusResponse,
} from "@simpletab/core/wire";
import { handleRequest } from "../src/worker";
import type { Env } from "../src/env";
import { resetUsageCounters } from "../src/lib/usage";
import {
  approveTournamentViaAdmin,
  hostHeaders,
  makeLinkFixture,
  makePermitPayload,
  makeSignedSubmission,
  makeUlid,
  resetDatabase,
  seedAdmin,
  typedEnv,
} from "./helpers";

describe("Submit, deadlines, status, rate limits, and usage flushes", () => {
  const slug = "aust-2027";
  let adminEmail: string;
  let hostKey: string;

  beforeEach(async () => {
    await resetDatabase();
    adminEmail = await seedAdmin();
    const approved = await approveTournamentViaAdmin(adminEmail, slug);
    hostKey = approved.key;
  });

  it("accepts valid submission once, deduplicates resends, and never checks team ids", async () => {
    const link = await makeLinkFixture(slug, "aabcdefghjkm2");
    await SELF.fetch("https://ballots.test/v1/host/permits", {
      method: "POST",
      headers: hostHeaders(hostKey),
      body: JSON.stringify(makePermitPayload(link)),
    });

    const submissionId = makeUlid(101);
    const body = await makeSignedSubmission({
      slug,
      link,
      submissionId,
      payload: {
        roomId: "room-101",
        substitution: true,
        arbitrarySwingTeamIds: ["swing-999"],
        ranks: [1, 2, 3, 4],
      },
    });

    const first = await SELF.fetch("https://ballots.test/v1/submit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({
      status: "received",
      submissionId,
    });

    const resend = await SELF.fetch("https://ballots.test/v1/submit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(resend.status).toBe(200);
    expect(await resend.json()).toEqual({ status: "already_received" });

    const countRow = await typedEnv.DB.prepare(
      "SELECT COUNT(*) AS cnt FROM submissions WHERE submission_id = ?",
    )
      .bind(submissionId)
      .first<{ cnt: number }>();
    expect(countRow?.cnt).toBe(1);
  });

  it("rejects bad proof (AUTH_INVALID), disallowed form (FORM_NOT_ALLOWED), and closed round (ROUND_CLOSED)", async () => {
    const link = await makeLinkFixture(slug, "aabcdefghjkm3");
    await SELF.fetch("https://ballots.test/v1/host/permits", {
      method: "POST",
      headers: hostHeaders(hostKey),
      body: JSON.stringify({
        ...makePermitPayload(link),
        entries: [
          {
            lookupId: link.lookupId,
            verifier: link.verifier,
            roomId: "room-101",
            forms: ["ballot"],
          },
        ],
      }),
    });

    const badProofBody = await makeSignedSubmission({ slug, link });
    badProofBody.proof = "tampered_proof_signature";
    const badProofRes = await SELF.fetch("https://ballots.test/v1/submit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(badProofBody),
    });
    expect(badProofRes.status).toBe(401);
    const badProofParsed = parseErrorBody(await badProofRes.json());
    expect(badProofParsed.ok && badProofParsed.value.code).toBe("AUTH_INVALID");

    const wrongFormBody = await makeSignedSubmission({
      slug,
      link,
      type: "feedback",
    });
    const wrongFormRes = await SELF.fetch("https://ballots.test/v1/submit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(wrongFormBody),
    });
    expect(wrongFormRes.status).toBe(403);
    const wrongFormParsed = parseErrorBody(await wrongFormRes.json());
    expect(wrongFormParsed.ok && wrongFormParsed.value.code).toBe("FORM_NOT_ALLOWED");

    // Close round permit -> ROUND_CLOSED (409).
    await SELF.fetch("https://ballots.test/v1/host/permits", {
      method: "POST",
      headers: hostHeaders(hostKey),
      body: JSON.stringify(makePermitPayload(link, { version: 2, open: false })),
    });
    const closedRoundRes = await SELF.fetch("https://ballots.test/v1/submit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(await makeSignedSubmission({ slug, link })),
    });
    expect(closedRoundRes.status).toBe(409);
    const closedParsed = parseErrorBody(await closedRoundRes.json());
    expect(closedParsed.ok && closedParsed.value.code).toBe("ROUND_CLOSED");
  });

  it("enforces deadlines: accepted 1 ms before, refused at exact instant with DEADLINE_PASSED", async () => {
    const link = await makeLinkFixture(slug, "aabcdefghjkm4");
    const ballotDeadline = "2026-11-24T14:00:00.000Z";
    const feedbackDeadline = "2026-11-24T15:00:00.000Z";
    const deadlineMs = Date.parse(ballotDeadline);

    await SELF.fetch("https://ballots.test/v1/host/permits", {
      method: "POST",
      headers: hostHeaders(hostKey),
      body: JSON.stringify(
        makePermitPayload(link, {
          ballotDeadline,
          feedbackDeadline,
          timeZone: "Asia/Dhaka",
        }),
      ),
    });

    const beforeCtx = createExecutionContext();
    const beforeReq = new Request("https://ballots.test/v1/submit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(await makeSignedSubmission({ slug, link, type: "ballot" })),
    });
    const beforeRes = await handleRequest(beforeReq, typedEnv, beforeCtx, () => deadlineMs - 1);
    await waitOnExecutionContext(beforeCtx);
    expect(beforeRes.status).toBe(200);

    const atCtx = createExecutionContext();
    const atReq = new Request("https://ballots.test/v1/submit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(await makeSignedSubmission({ slug, link, type: "ballot" })),
    });
    const atRes = await handleRequest(atReq, typedEnv, atCtx, () => deadlineMs);
    await waitOnExecutionContext(atCtx);
    expect(atRes.status).toBe(409);
    const atErr = parseErrorBody(await atRes.json());
    expect(atErr.ok).toBe(true);
    if (atErr.ok) {
      expect(atErr.value.code).toBe("DEADLINE_PASSED");
      expect(atErr.value.deadline).toBe(ballotDeadline);
      expect(atErr.value.timeZone).toBe("Asia/Dhaka");
    }

    // Feedback is unaffected by ballotDeadline, only by feedbackDeadline.
    const fbOkCtx = createExecutionContext();
    const fbOkRes = await handleRequest(
      new Request("https://ballots.test/v1/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(await makeSignedSubmission({ slug, link, type: "feedback" })),
      }),
      typedEnv,
      fbOkCtx,
      () => deadlineMs,
    );
    await waitOnExecutionContext(fbOkCtx);
    expect(fbOkRes.status).toBe(200);

    const fbLateCtx = createExecutionContext();
    const fbLateRes = await handleRequest(
      new Request("https://ballots.test/v1/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(await makeSignedSubmission({ slug, link, type: "feedback" })),
      }),
      typedEnv,
      fbLateCtx,
      () => Date.parse(feedbackDeadline),
    );
    await waitOnExecutionContext(fbLateCtx);
    expect(fbLateRes.status).toBe(409);
  });

  it("reports status server/tabRoom, omits shareLeft for phones, includes it for host, and writes nothing", async () => {
    const link = await makeLinkFixture(slug, "aabcdefghjkm5");
    await SELF.fetch("https://ballots.test/v1/host/permits", {
      method: "POST",
      headers: hostHeaders(hostKey),
      body: JSON.stringify(makePermitPayload(link)),
    });

    const id1 = makeUlid(201);
    const id2 = makeUlid(202);
    const idMissing = makeUlid(203);

    const sub1Res = await SELF.fetch("https://ballots.test/v1/submit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(await makeSignedSubmission({ slug, link, submissionId: id1 })),
    });
    expect(sub1Res.status).toBe(200);
    const sub2Res = await SELF.fetch("https://ballots.test/v1/submit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(await makeSignedSubmission({ slug, link, submissionId: id2 })),
    });
    expect(sub2Res.status).toBe(200);

    const inboxRes = await SELF.fetch("https://ballots.test/v1/host/inbox", {
      headers: hostHeaders(hostKey),
    });
    const inboxJson = (await inboxRes.json()) as { items: Array<{ rowid: number; submissionId: string }> };
    const row1 = inboxJson.items[0].rowid;

    await SELF.fetch("https://ballots.test/v1/host/ack", {
      method: "POST",
      headers: hostHeaders(hostKey),
      body: JSON.stringify({ schema: SCHEMA_VERSION, through: row1 }),
    });

    const usageBefore = await typedEnv.DB.prepare(
      "SELECT COUNT(*) AS cnt FROM usage",
    ).first<{ cnt: number }>();

    const phoneStatusRes = await SELF.fetch(
      `https://ballots.test/v1/status?slug=${slug}&lookupId=${link.lookupId}&ids=${id1},${id2},${idMissing}`,
    );
    expect(phoneStatusRes.status).toBe(200);
    const phoneStatus = parseStatusResponse(await phoneStatusRes.json());
    expect(phoneStatus.ok).toBe(true);
    if (phoneStatus.ok) {
      expect(phoneStatus.value.shareLeft).toBeUndefined();
      expect(phoneStatus.value.items).toEqual([
        { submissionId: id1, server: true, tabRoom: true },
        { submissionId: id2, server: true, tabRoom: false },
        { submissionId: idMissing, server: false, tabRoom: false },
      ]);
    }

    const hostStatusRes = await SELF.fetch(
      `https://ballots.test/v1/status?slug=${slug}&ids=${id1},${id2}`,
      { headers: { Authorization: `Bearer ${hostKey}` } },
    );
    expect(hostStatusRes.status).toBe(200);
    const hostStatus = parseStatusResponse(await hostStatusRes.json());
    expect(hostStatus.ok).toBe(true);
    if (hostStatus.ok) {
      expect(typeof hostStatus.value.shareLeft).toBe("number");
    }

    const usageAfter = await typedEnv.DB.prepare(
      "SELECT COUNT(*) AS cnt FROM usage",
    ).first<{ cnt: number }>();
    expect(usageAfter?.cnt).toBe(usageBefore?.cnt);
  });

  it("fails open when rate-limit binding throws and flushes usage counters additively after 60s", async () => {
    const link = await makeLinkFixture(slug, "aabcdefghjkm6");
    await SELF.fetch("https://ballots.test/v1/host/permits", {
      method: "POST",
      headers: hostHeaders(hostKey),
      body: JSON.stringify(makePermitPayload(link)),
    });
    resetUsageCounters();

    const throwingEnv: Env = {
      ...typedEnv,
      RL_LINK: {
        async limit(): Promise<{ success: boolean }> {
          throw new Error("binding unavailable");
        },
      },
      RL_IP: {
        async limit(): Promise<{ success: boolean }> {
          throw new Error("binding unavailable");
        },
      },
    };

    const t0 = Date.UTC(2026, 10, 24, 10, 0, 0);
    const ctx1 = createExecutionContext();
    const res1 = await handleRequest(
      new Request("https://ballots.test/v1/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(await makeSignedSubmission({ slug, link })),
      }),
      throwingEnv,
      ctx1,
      () => t0,
    );
    await waitOnExecutionContext(ctx1);
    expect(res1.status).toBe(200);

    // 61 seconds later -> first additive UPSERT flush (2 requests, 4 writes).
    const ctx2 = createExecutionContext();
    const res2 = await handleRequest(
      new Request("https://ballots.test/v1/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(await makeSignedSubmission({ slug, link })),
      }),
      throwingEnv,
      ctx2,
      () => t0 + 61_000,
    );
    await waitOnExecutionContext(ctx2);
    expect(res2.status).toBe(200);

    const afterFirstFlush = await typedEnv.DB.prepare(
      "SELECT requests, writes FROM usage WHERE slug = ? AND day = '2026-11-24'",
    )
      .bind(slug)
      .first<{ requests: number; writes: number }>();
    expect(afterFirstFlush).toEqual({ requests: 2, writes: 4 });

    // Another 61 seconds later -> additive UPSERT increments existing row to (3, 6).
    const ctx3 = createExecutionContext();
    const res3 = await handleRequest(
      new Request("https://ballots.test/v1/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(await makeSignedSubmission({ slug, link })),
      }),
      throwingEnv,
      ctx3,
      () => t0 + 122_000,
    );
    await waitOnExecutionContext(ctx3);
    expect(res3.status).toBe(200);

    const afterSecondFlush = await typedEnv.DB.prepare(
      "SELECT requests, writes FROM usage WHERE slug = ? AND day = '2026-11-24'",
    )
      .bind(slug)
      .first<{ requests: number; writes: number }>();
    expect(afterSecondFlush).toEqual({ requests: 3, writes: 6 });
  });

  it("enforces QUOTA_EXHAUSTED (429), RATE_LIMITED (429), and SCHEMA_UNSUPPORTED (415)", async () => {
    const link = await makeLinkFixture(slug, "aabcdefghjkm7");
    await SELF.fetch("https://ballots.test/v1/host/permits", {
      method: "POST",
      headers: hostHeaders(hostKey),
      body: JSON.stringify(makePermitPayload(link)),
    });

    const badSchemaRes = await SELF.fetch("https://ballots.test/v1/submit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(await makeSignedSubmission({ slug, link, schema: 2 })),
    });
    expect(badSchemaRes.status).toBe(415);
    const badSchemaErr = parseErrorBody(await badSchemaRes.json());
    expect(badSchemaErr.ok && badSchemaErr.value.code).toBe("SCHEMA_UNSUPPORTED");

    // Exhaust share via admin share update -> 429 QUOTA_EXHAUSTED with Retry-After.
    await SELF.fetch(`https://ballots.test/admin/tournaments/${slug}/share`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "Cf-Access-Authenticated-User-Email": adminEmail,
      },
      body: JSON.stringify({ shareRequests: 1, shareWrites: 1 }),
    });

    const quotaRes = await SELF.fetch("https://ballots.test/v1/submit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(await makeSignedSubmission({ slug, link })),
    });
    expect(quotaRes.status).toBe(429);
    expect(quotaRes.headers.get("Retry-After")).toBeTruthy();
    const quotaErr = parseErrorBody(await quotaRes.json());
    expect(quotaErr.ok && quotaErr.value.code).toBe("QUOTA_EXHAUSTED");

    // Rate limiter denying -> 429 RATE_LIMITED with Retry-After.
    const limitedEnv: Env = {
      ...typedEnv,
      RL_LINK: {
        async limit(): Promise<{ success: boolean }> {
          return { success: false };
        },
      },
    };
    const rlCtx = createExecutionContext();
    const rlRes = await handleRequest(
      new Request("https://ballots.test/v1/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(await makeSignedSubmission({ slug, link })),
      }),
      limitedEnv,
      rlCtx,
    );
    await waitOnExecutionContext(rlCtx);
    expect(rlRes.status).toBe(429);
    expect(rlRes.headers.get("Retry-After")).toBe("60");
    const rlErr = parseErrorBody(await rlRes.json());
    expect(rlErr.ok && rlErr.value.code).toBe("RATE_LIMITED");
  });
});
