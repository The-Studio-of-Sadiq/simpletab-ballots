import { SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  SCHEMA_VERSION,
  parseErrorBody,
  parseInboxPage,
} from "@simpletab/core/wire";
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

describe("Host authentication, host-number rules, permits, inbox, ack, head, close", () => {
  let adminEmail: string;
  let hostKey: string;
  const slug = "wudc-2027";

  beforeEach(async () => {
    await resetDatabase();
    adminEmail = await seedAdmin();
    const approved = await approveTournamentViaAdmin(adminEmail, slug);
    hostKey = approved.key;
  });

  it("rejects missing or invalid Bearer token with 401 AUTH_INVALID", async () => {
    const missing = await SELF.fetch("https://ballots.test/v1/host/inbox");
    expect(missing.status).toBe(401);
    const missingBody = parseErrorBody(await missing.json());
    expect(missingBody.ok).toBe(true);
    if (missingBody.ok) {
      expect(missingBody.value.code).toBe("AUTH_INVALID");
    }

    const wrong = await SELF.fetch("https://ballots.test/v1/host/inbox", {
      headers: hostHeaders("wrong-key"),
    });
    expect(wrong.status).toBe(401);
  });

  it("enforces section 4 step 8 host-number, host_id, and rank rules", async () => {
    const link = await makeLinkFixture(slug);
    const permit = makePermitPayload(link);

    // 1. Initially host_id is empty -> first request claims it at number 1, rank 2.
    const claim = await SELF.fetch("https://ballots.test/v1/host/permits", {
      method: "POST",
      headers: hostHeaders(hostKey, { hostNumber: 1, hostId: "laptop-b", hostRank: 2 }),
      body: JSON.stringify(permit),
    });
    expect(claim.status).toBe(200);

    // 2. Equal host_number + same host_id is accepted.
    const sameHost = await SELF.fetch("https://ballots.test/v1/host/permits", {
      method: "POST",
      headers: hostHeaders(hostKey, { hostNumber: 1, hostId: "laptop-b", hostRank: 2 }),
      body: JSON.stringify({ ...permit, version: 2 }),
    });
    expect(sameHost.status).toBe(200);

    // 3. Equal host_number + different host_id + worse/equal rank is refused with HOST_STALE (409).
    const equalWorseRank = await SELF.fetch("https://ballots.test/v1/host/permits", {
      method: "POST",
      headers: hostHeaders(hostKey, { hostNumber: 1, hostId: "laptop-c", hostRank: 3 }),
      body: JSON.stringify({ ...permit, version: 3 }),
    });
    expect(equalWorseRank.status).toBe(409);
    const worseBody = parseErrorBody(await equalWorseRank.json());
    expect(worseBody.ok).toBe(true);
    if (worseBody.ok) {
      expect(worseBody.value.code).toBe("HOST_STALE");
      expect(worseBody.value.storedHostNumber).toBe(1);
    }

    // 4. Equal host_number + different host_id + lower (better) rank is accepted.
    const betterRank = await SELF.fetch("https://ballots.test/v1/host/permits", {
      method: "POST",
      headers: hostHeaders(hostKey, { hostNumber: 1, hostId: "laptop-a", hostRank: 1 }),
      body: JSON.stringify({ ...permit, version: 3 }),
    });
    expect(betterRank.status).toBe(200);

    // 5. Equal host_number + different host_id + equal rank 1 is now refused.
    const tiedDiffId = await SELF.fetch("https://ballots.test/v1/host/permits", {
      method: "POST",
      headers: hostHeaders(hostKey, { hostNumber: 1, hostId: "laptop-d", hostRank: 1 }),
      body: JSON.stringify({ ...permit, version: 4 }),
    });
    expect(tiedDiffId.status).toBe(409);

    // 6. Higher host_number is accepted and updates stored host_number/id/rank.
    const higher = await SELF.fetch("https://ballots.test/v1/host/permits", {
      method: "POST",
      headers: hostHeaders(hostKey, { hostNumber: 2, hostId: "laptop-d", hostRank: 1 }),
      body: JSON.stringify({ ...permit, version: 4 }),
    });
    expect(higher.status).toBe(200);

    // 7. Lower (stale) host_number is refused with storedHostNumber = 2.
    const stale = await SELF.fetch("https://ballots.test/v1/host/permits", {
      method: "POST",
      headers: hostHeaders(hostKey, { hostNumber: 1, hostId: "laptop-a", hostRank: 1 }),
      body: JSON.stringify({ ...permit, version: 5 }),
    });
    expect(stale.status).toBe(409);
    const staleBody = parseErrorBody(await stale.json());
    expect(staleBody.ok).toBe(true);
    if (staleBody.ok) {
      expect(staleBody.value.code).toBe("HOST_STALE");
      expect(staleBody.value.storedHostNumber).toBe(2);
    }
  });

  it("uploads one permit row per round and handles X-Request-Id idempotency", async () => {
    const link = await makeLinkFixture(slug);
    const permit = makePermitPayload(link);
    const reqId = "req-permit-001";

    const first = await SELF.fetch("https://ballots.test/v1/host/permits", {
      method: "POST",
      headers: hostHeaders(hostKey, { requestId: reqId }),
      body: JSON.stringify(permit),
    });
    expect(first.status).toBe(200);
    const firstJson = await first.json();

    const replay = await SELF.fetch("https://ballots.test/v1/host/permits", {
      method: "POST",
      headers: hostHeaders(hostKey, { requestId: reqId }),
      body: JSON.stringify(permit),
    });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(firstJson);

    const rows = await typedEnv.DB.prepare(
      "SELECT round_id, version, open FROM permits WHERE slug = ?",
    )
      .bind(slug)
      .all<{ round_id: string; version: number; open: number }>();
    expect(rows.results).toEqual([{ round_id: "round-1", version: 1, open: 1 }]);
  });

  it("pages inbox by rowid for this tournament only and respects ack monotonicity", async () => {
    const otherSlug = "other-tourney";
    const otherApproved = await approveTournamentViaAdmin(adminEmail, otherSlug);

    const linkA = await makeLinkFixture(slug, "aabcdefghjkmn", 0x11);
    const linkB = await makeLinkFixture(otherSlug, "aabcdefghjkmp", 0x22);

    await SELF.fetch("https://ballots.test/v1/host/permits", {
      method: "POST",
      headers: hostHeaders(hostKey),
      body: JSON.stringify(makePermitPayload(linkA)),
    });
    await SELF.fetch("https://ballots.test/v1/host/permits", {
      method: "POST",
      headers: hostHeaders(otherApproved.key),
      body: JSON.stringify(makePermitPayload(linkB)),
    });

    const id1 = makeUlid(1);
    const idOther = makeUlid(2);
    const id2 = makeUlid(3);
    const id3 = makeUlid(4);

    for (const body of [
      await makeSignedSubmission({ slug, link: linkA, submissionId: id1 }),
      await makeSignedSubmission({ slug: otherSlug, link: linkB, submissionId: idOther }),
      await makeSignedSubmission({ slug, link: linkA, submissionId: id2 }),
      await makeSignedSubmission({ slug, link: linkA, submissionId: id3 }),
    ]) {
      const res = await SELF.fetch("https://ballots.test/v1/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(200);
    }

    // Page 1 with limit=2 should exclude otherSlug and set next = rowid of id2.
    const page1Resp = await SELF.fetch(
      "https://ballots.test/v1/host/inbox?after=0&limit=2",
      { headers: hostHeaders(hostKey) },
    );
    expect(page1Resp.status).toBe(200);
    const page1Raw = await page1Resp.json();
    const page1Parsed = parseInboxPage(page1Raw);
    expect(page1Parsed.ok).toBe(true);
    if (!page1Parsed.ok) {
      throw new Error("Expected valid InboxPage");
    }
    expect(page1Parsed.value.items.map((i) => i.submissionId)).toEqual([id1, id2]);
    expect(page1Parsed.value.next).toBe(page1Parsed.value.items[1].rowid);

    // Page 2 from page1.next returns only id3 and next = null.
    const page2Resp = await SELF.fetch(
      `https://ballots.test/v1/host/inbox?after=${page1Parsed.value.next}&limit=2`,
      { headers: hostHeaders(hostKey) },
    );
    const page2Parsed = parseInboxPage(await page2Resp.json());
    expect(page2Parsed.ok).toBe(true);
    if (!page2Parsed.ok) {
      throw new Error("Expected valid InboxPage");
    }
    expect(page2Parsed.value.items.map((i) => i.submissionId)).toEqual([id3]);
    expect(page2Parsed.value.next).toBeNull();

    // Ack through page1.items[1].rowid; a smaller ack must not lower acked_through.
    const ackHigh = await SELF.fetch("https://ballots.test/v1/host/ack", {
      method: "POST",
      headers: hostHeaders(hostKey),
      body: JSON.stringify({ schema: SCHEMA_VERSION, through: page1Parsed.value.items[1].rowid }),
    });
    expect(ackHigh.status).toBe(200);
    expect(await ackHigh.json()).toEqual({
      schema: SCHEMA_VERSION,
      ackedThrough: page1Parsed.value.items[1].rowid,
    });

    const ackLower = await SELF.fetch("https://ballots.test/v1/host/ack", {
      method: "POST",
      headers: hostHeaders(hostKey),
      body: JSON.stringify({ schema: SCHEMA_VERSION, through: 1 }),
    });
    expect(ackLower.status).toBe(200);
    expect(await ackLower.json()).toEqual({
      schema: SCHEMA_VERSION,
      ackedThrough: page1Parsed.value.items[1].rowid,
    });
  });

  it("records heads, closes tournament, and stubs /v1/register with 404", async () => {
    const headHash = "a".repeat(64);
    const headResp = await SELF.fetch("https://ballots.test/v1/host/head", {
      method: "POST",
      headers: hostHeaders(hostKey),
      body: JSON.stringify({ schema: SCHEMA_VERSION, seq: 10, headHash }),
    });
    expect(headResp.status).toBe(200);
    const headRow = await typedEnv.DB.prepare(
      "SELECT seq, head_hash FROM heads WHERE slug = ?",
    )
      .bind(slug)
      .first<{ seq: number; head_hash: string }>();
    expect(headRow).toEqual({ seq: 10, head_hash: headHash });

    const closeResp = await SELF.fetch("https://ballots.test/v1/host/close", {
      method: "POST",
      headers: hostHeaders(hostKey),
      body: JSON.stringify({}),
    });
    expect(closeResp.status).toBe(200);
    expect(await closeResp.json()).toEqual({
      schema: SCHEMA_VERSION,
      slug,
      status: "closed",
    });

    // Submitting after close fails with ROUND_CLOSED (409).
    const link = await makeLinkFixture(slug);
    const subResp = await SELF.fetch("https://ballots.test/v1/submit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(await makeSignedSubmission({ slug, link })),
    });
    expect(subResp.status).toBe(409);

    const regStub = await SELF.fetch("https://ballots.test/v1/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(regStub.status).toBe(404);
  });
});
