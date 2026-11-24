import { SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { SCHEMA_VERSION, parsePublicHeadsResponse } from "@simpletab/core/wire";
import {
  approveTournamentViaAdmin,
  hostHeaders,
  resetDatabase,
  seedAdmin,
  typedEnv,
} from "./helpers";

describe("GET /v1/heads/<slug> (public Verify support)", () => {
  const slug = "verify-open";
  let hostKey: string;

  beforeEach(async () => {
    await resetDatabase();
    const adminEmail = await seedAdmin();
    hostKey = (await approveTournamentViaAdmin(adminEmail, slug)).key;
  });

  it("lists every head in order with CORS and short caching, and needs no key", async () => {
    for (const [seq, ch] of [
      [12, "b"],
      [5, "a"],
    ] as const) {
      const res = await SELF.fetch("https://ballots.test/v1/host/head", {
        method: "POST",
        headers: hostHeaders(hostKey),
        body: JSON.stringify({ schema: SCHEMA_VERSION, seq, headHash: ch.repeat(64) }),
      });
      expect(res.status).toBe(200);
    }

    const res = await SELF.fetch(`https://ballots.test/v1/heads/${slug}`, {
      headers: { Origin: "https://verify-open.pages.dev" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(res.headers.get("Cache-Control")).toContain("max-age=60");
    const parsed = parsePublicHeadsResponse(await res.json());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.heads.map((h) => [h.seq, h.headHash])).toEqual([
      [5, "a".repeat(64)],
      [12, "b".repeat(64)],
    ]);
  });

  it("returns 404 for unknown or pending tournaments and rejects bad slugs", async () => {
    expect((await SELF.fetch("https://ballots.test/v1/heads/nope")).status).toBe(404);
    await typedEnv.DB.prepare("UPDATE tournaments SET status = 'pending' WHERE slug = ?").bind(slug).run();
    expect((await SELF.fetch(`https://ballots.test/v1/heads/${slug}`)).status).toBe(404);
    const bad = await SELF.fetch("https://ballots.test/v1/heads/..%2Fadmin");
    expect(bad.status).toBe(400);
    expect(bad.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  it("marks archived tournaments, whose heads now live in the R2 archive", async () => {
    await typedEnv.DB.prepare("UPDATE tournaments SET status = 'archived' WHERE slug = ?").bind(slug).run();
    const res = await SELF.fetch(`https://ballots.test/v1/heads/${slug}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ slug, heads: [], archived: true });
  });
});
