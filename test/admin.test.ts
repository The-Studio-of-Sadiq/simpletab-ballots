import { SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { SCHEMA_VERSION, parseErrorBody } from "@simpletab/core/wire";
import { hashTournamentKey } from "../src/lib/auth";
import {
  approveTournamentViaAdmin,
  hostHeaders,
  resetDatabase,
  seedAdmin,
  typedEnv,
} from "./helpers";

describe("Admin routes, Access protection, key lifecycle, shares, and usage report", () => {
  const adminEmail = "tab.director@example.org";

  beforeEach(async () => {
    await resetDatabase();
    await seedAdmin(adminEmail);
  });

  it("requires Cf-Access-Authenticated-User-Email header and membership in admins table", async () => {
    const noHeader = await SELF.fetch("https://ballots.test/admin/key-requests");
    expect(noHeader.status).toBe(401);

    const unknownAdmin = await SELF.fetch("https://ballots.test/admin/key-requests", {
      headers: { "Cf-Access-Authenticated-User-Email": "stranger@example.org" },
    });
    expect(unknownAdmin.status).toBe(401);

    const validAdmin = await SELF.fetch("https://ballots.test/admin/key-requests", {
      headers: { "Cf-Access-Authenticated-User-Email": adminEmail },
    });
    expect(validAdmin.status).toBe(200);
  });

  it("approves key requests, stores only SHA-256, revokes, and reissues with bumped host_number", async () => {
    const slug = "wudc-admin-test";
    const reqResp = await SELF.fetch("https://ballots.test/v1/host/key-request", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        schema: SCHEMA_VERSION,
        slug,
        contact: "convener@example.org",
        note: "WUDC size",
      }),
    });
    expect(reqResp.status).toBe(201);
    const { id } = (await reqResp.json()) as { id: string };

    const listResp = await SELF.fetch(
      "https://ballots.test/admin/key-requests?status=pending",
      { headers: { "Cf-Access-Authenticated-User-Email": adminEmail } },
    );
    const listBody = (await listResp.json()) as { items: Array<{ id: string; slug: string }> };
    expect(listBody.items.some((item) => item.id === id && item.slug === slug)).toBe(true);

    // P = 900 -> requests = 1000 + 12*900 = 11800, writes = 1000 + 18*900 = 17200.
    const approveResp = await SELF.fetch(
      `https://ballots.test/admin/key-requests/${id}/approve`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Cf-Access-Authenticated-User-Email": adminEmail,
        },
        body: JSON.stringify({ participants: 900 }),
      },
    );
    expect(approveResp.status).toBe(201);
    const approved = (await approveResp.json()) as {
      key: string;
      shareRequests: number;
      shareWrites: number;
      hostNumber: number;
    };
    expect(approved.shareRequests).toBe(11800);
    expect(approved.shareWrites).toBe(17200);
    expect(approved.hostNumber).toBe(1);

    const dbRow = await typedEnv.DB.prepare(
      "SELECT key_hash, host_number FROM tournaments WHERE slug = ?",
    )
      .bind(slug)
      .first<{ key_hash: string; host_number: number }>();
    expect(dbRow?.key_hash).toBe(await hashTournamentKey(approved.key));
    expect(dbRow?.key_hash).not.toBe(approved.key);

    // Claim host_id on host 1.
    const inboxOk = await SELF.fetch("https://ballots.test/v1/host/inbox", {
      headers: hostHeaders(approved.key, { hostNumber: 1, hostId: "old-laptop" }),
    });
    expect(inboxOk.status).toBe(200);

    // Revoke key -> 403 KEY_REVOKED.
    const revokeResp = await SELF.fetch(
      `https://ballots.test/admin/tournaments/${slug}/revoke`,
      {
        method: "POST",
        headers: { "Cf-Access-Authenticated-User-Email": adminEmail },
      },
    );
    expect(revokeResp.status).toBe(200);

    const revokedInbox = await SELF.fetch("https://ballots.test/v1/host/inbox", {
      headers: hostHeaders(approved.key, { hostNumber: 1, hostId: "old-laptop" }),
    });
    expect(revokedInbox.status).toBe(403);
    const revokedParsed = parseErrorBody(await revokedInbox.json());
    expect(revokedParsed.ok && revokedParsed.value.code).toBe("KEY_REVOKED");

    // Reissue -> new key, host_number incremented to 2, host_id cleared.
    const reissueResp = await SELF.fetch(
      `https://ballots.test/admin/tournaments/${slug}/reissue`,
      {
        method: "POST",
        headers: { "Cf-Access-Authenticated-User-Email": adminEmail },
      },
    );
    expect(reissueResp.status).toBe(200);
    const reissued = (await reissueResp.json()) as { key: string; hostNumber: number };
    expect(reissued.hostNumber).toBe(2);
    expect(reissued.key).not.toBe(approved.key);

    // Old host_number 1 with new key gets HOST_STALE (storedHostNumber: 2).
    const staleAfterReissue = await SELF.fetch("https://ballots.test/v1/host/inbox", {
      headers: hostHeaders(reissued.key, { hostNumber: 1, hostId: "new-laptop" }),
    });
    expect(staleAfterReissue.status).toBe(409);

    // Adopting host_number 2 claims empty host_id.
    const claimedAfterReissue = await SELF.fetch("https://ballots.test/v1/host/inbox", {
      headers: hostHeaders(reissued.key, { hostNumber: 2, hostId: "new-laptop" }),
    });
    expect(claimedAfterReissue.status).toBe(200);
  });

  it("sets shares, enforces 80k cap, and reports 70%/90% thresholds in /admin/usage", async () => {
    const slug = "share-cap-test";
    await approveTournamentViaAdmin(adminEmail, slug, 225);

    const shareUpdate = await SELF.fetch(
      `https://ballots.test/admin/tournaments/${slug}/share`,
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "Cf-Access-Authenticated-User-Email": adminEmail,
        },
        body: JSON.stringify({ shareRequests: 75_000, shareWrites: 60_000 }),
      },
    );
    expect(shareUpdate.status).toBe(200);

    // Exceeding 80,000 allocated writes is refused.
    const tooHigh = await SELF.fetch(
      `https://ballots.test/admin/tournaments/${slug}/share`,
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "Cf-Access-Authenticated-User-Email": adminEmail,
        },
        body: JSON.stringify({ shareWrites: 85_000 }),
      },
    );
    expect(tooHigh.status).toBe(429);

    // Seed usage near 75% to verify warning threshold and 95% for blocked threshold.
    const today = new Date().toISOString().slice(0, 10);
    await typedEnv.DB.prepare(
      `INSERT INTO usage (slug, day, requests, writes, reg_writes)
       VALUES (?, ?, 75000, 92000, 0)`,
    )
      .bind(slug, today)
      .run();

    const usageResp = await SELF.fetch("https://ballots.test/admin/usage", {
      headers: { "Cf-Access-Authenticated-User-Email": adminEmail },
    });
    expect(usageResp.status).toBe(200);
    const report = (await usageResp.json()) as {
      thresholds: { warning: number; block: number };
      daily: {
        requests: { level: string };
        writes: { level: string };
      };
      allocated: { level: string; shareWrites: number };
    };
    expect(report.thresholds).toEqual({ warning: 0.7, block: 0.9 });
    expect(report.daily.requests.level).toBe("warning");
    expect(report.daily.writes.level).toBe("blocked");
    expect(report.allocated.level).toBe("warning");
    expect(report.allocated.shareWrites).toBe(60_000);
  });
});
