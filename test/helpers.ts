import { applyD1Migrations, env } from "cloudflare:test";
import type { D1Migration } from "@cloudflare/vitest-pool-workers";
import {
  base64UrlEncode,
  deriveKeys,
  proof,
  verifier,
} from "@simpletab/core/crypto";
import { SCHEMA_VERSION, type PermitUpload } from "@simpletab/core/wire";
import type { Env } from "../src/env";
import { resetIdempotencyCache } from "../src/lib/auth";
import { clearPermitCache } from "../src/lib/permits";
import { resetUsageCounters } from "../src/lib/usage";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export const typedEnv = env as unknown as Env & {
  TEST_MIGRATIONS: D1Migration[];
};

let ulidCounter = 1;

export function makeUlid(seed?: number): string {
  const n = seed ?? ulidCounter++;
  const chars = new Array<string>(26).fill("0");
  let v = n;
  for (let i = 25; i >= 1; i--) {
    chars[i] = CROCKFORD[v % 32];
    v = Math.floor(v / 32);
  }
  chars[0] = "0";
  return chars.join("");
}

export async function resetDatabase(): Promise<void> {
  await applyD1Migrations(typedEnv.DB, typedEnv.TEST_MIGRATIONS);
  await typedEnv.DB.batch([
    typedEnv.DB.prepare("DELETE FROM submissions"),
    typedEnv.DB.prepare("DELETE FROM permits"),
    typedEnv.DB.prepare("DELETE FROM heads"),
    typedEnv.DB.prepare("DELETE FROM usage"),
    typedEnv.DB.prepare("DELETE FROM archives"),
    typedEnv.DB.prepare("DELETE FROM key_requests"),
    typedEnv.DB.prepare("DELETE FROM tournaments"),
    typedEnv.DB.prepare("DELETE FROM admins"),
  ]);
  resetIdempotencyCache();
  clearPermitCache();
  resetUsageCounters();
}

export async function seedAdmin(email = "admin@simpletab.org"): Promise<string> {
  await typedEnv.DB.prepare(
    `INSERT INTO admins (email, added_at) VALUES (?, ?)`,
  )
    .bind(email, "2026-11-24T00:00:00.000Z")
    .run();
  return email;
}

export async function approveTournamentViaAdmin(
  adminEmail: string,
  slug: string,
  participants = 225,
): Promise<{
  key: string;
  shareRequests: number;
  shareWrites: number;
}> {
  const { SELF } = await import("cloudflare:test");

  const reqResp = await SELF.fetch("https://ballots.test/v1/host/key-request", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      schema: SCHEMA_VERSION,
      slug,
      contact: "tab@example.org",
      note: "test event",
    }),
  });
  const reqBody = (await reqResp.json()) as { id: string };

  const approveResp = await SELF.fetch(
    `https://ballots.test/admin/key-requests/${reqBody.id}/approve`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Cf-Access-Authenticated-User-Email": adminEmail,
      },
      body: JSON.stringify({ participants }),
    },
  );
  return (await approveResp.json()) as {
    key: string;
    shareRequests: number;
    shareWrites: number;
  };
}

export interface LinkFixture {
  lookupId: string;
  authKey: string;
  authKeyBytes: Uint8Array;
  verifier: string;
}

export async function makeLinkFixture(
  slug: string,
  lookupId = "aabcdefghjkmn",
  secretByte = 0x42,
): Promise<LinkFixture> {
  const secret = new Uint8Array(16).fill(secretByte);
  const keys = await deriveKeys(secret, slug);
  return {
    lookupId,
    authKey: base64UrlEncode(keys.authKey),
    authKeyBytes: keys.authKey,
    verifier: await verifier(keys.authKey),
  };
}

export function makePermitPayload(
  link: LinkFixture,
  overrides: Partial<PermitUpload> = {},
): PermitUpload {
  return {
    schema: SCHEMA_VERSION,
    roundId: "round-1",
    version: 1,
    open: true,
    timeZone: "Asia/Dhaka",
    entries: [
      {
        lookupId: link.lookupId,
        verifier: link.verifier,
        roomId: "room-101",
        forms: ["ballot", "feedback", "checkin"],
      },
    ],
    ...overrides,
  };
}

export async function makeSignedSubmission(params: {
  slug: string;
  link: LinkFixture;
  roundId?: string;
  type?: string;
  submissionId?: string;
  payload?: Record<string, unknown>;
  schema?: number;
}): Promise<Record<string, unknown>> {
  const submissionId = params.submissionId ?? makeUlid();
  const payload = params.payload ?? { roomId: "room-101", ranks: [1, 2, 3, 4] };
  const sig = await proof(params.link.authKeyBytes, submissionId, payload);
  return {
    schema: params.schema ?? SCHEMA_VERSION,
    slug: params.slug,
    submissionId,
    type: params.type ?? "ballot",
    roundId: params.roundId ?? "round-1",
    lookupId: params.link.lookupId,
    authKey: params.link.authKey,
    proof: sig,
    payload,
  };
}

export function hostHeaders(
  key: string,
  opts: {
    hostNumber?: number;
    hostId?: string;
    hostRank?: number;
    requestId?: string;
  } = {},
): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${key}`,
    "X-Host-Number": String(opts.hostNumber ?? 1),
    "X-Host-Id": opts.hostId ?? "host-primary",
    "X-Host-Rank": String(opts.hostRank ?? 1),
  };
  if (opts.requestId !== undefined) {
    headers["X-Request-Id"] = opts.requestId;
  }
  return headers;
}
