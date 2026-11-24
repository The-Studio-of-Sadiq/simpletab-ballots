import { SELF } from "cloudflare:test";
import { base64UrlEncode, deriveKeys, verifier } from "@simpletab/core/crypto";
import {
  SCHEMA_VERSION,
  type PermitEntry,
  type PermitForm,
  type PermitUpload,
} from "@simpletab/core/wire";
import {
  BLOCK_THRESHOLD,
  DAILY_REQUEST_LIMIT,
  DAILY_WRITE_LIMIT,
  MAX_ALLOCATED_SHARE_WRITES,
  defaultShares,
  flushUsageNow,
  resetUsageCounters,
  utcDay,
} from "../../src/lib/usage";
import {
  approveTournamentViaAdmin,
  hostHeaders,
  makeSignedSubmission,
  makeUlid,
  resetDatabase,
  seedAdmin,
  typedEnv,
  type LinkFixture,
} from "../helpers";
import {
  createBudgetHarness,
  type BudgetHarness,
  type RouteMetrics,
} from "./counting-db";

export const FREE_DAILY_REQUESTS = DAILY_REQUEST_LIMIT;
export const FREE_DAILY_WRITES = DAILY_WRITE_LIMIT;
export const FREE_DAILY_READS = 5_000_000;
export const BUDGET_MAX_RATIO = BLOCK_THRESHOLD; // 0.90
export const ALLOCATED_SHARE_WRITES_CAP = MAX_ALLOCATED_SHARE_WRITES; // 80,000
export const BUDGET_REPORT_MARKER = "__BUDGET_REPORT_JSON__:";

const LOOKUP_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

export interface TournamentProfile {
  readonly id: "wudc" | "small100";
  readonly label: string;
  readonly slug: string;
  readonly rounds: number;
  readonly rooms: number;
  readonly teams: number;
  readonly adjudicators: number;
  readonly statusChecksPerRound: number;
  readonly permitsPerRound: number;
  readonly headsTotal: number;
  readonly dayHours: number;
  readonly pollIntervalSeconds: number;
  readonly shareRequestsOverride?: number;
}

export const WUDC_PROFILE: TournamentProfile = {
  id: "wudc",
  label: "1 × WUDC (400 teams, 100 rooms, 900 participants)",
  slug: "budget-wudc",
  rounds: 4,
  rooms: 100,
  teams: 400,
  adjudicators: 500,
  statusChecksPerRound: 550, // 2,200 total (~0.306 per form)
  permitsPerRound: 4, // open + 2 mid-round revisions + close = 16 total
  headsTotal: 134, // 16 permits + 134 heads = 150 total
  dayHours: 10,
  pollIntervalSeconds: 30,
};

export const SMALL100_PROFILE: TournamentProfile = {
  id: "small100",
  label: "1 × 100-team (100 teams, 25 rooms, 225 participants)",
  slug: "budget-small100",
  rounds: 4,
  rooms: 25,
  teams: 100,
  adjudicators: 125,
  statusChecksPerRound: 138, // 552 total (~0.307 per form)
  permitsPerRound: 2, // open + close = 8 total
  headsTotal: 30, // 8 permits + 30 heads = 38 total
  dayHours: 10,
  pollIntervalSeconds: 30,
};

export interface PerRouteMeasurement {
  route: string;
  designWrites: number;
  expectedWrites: number;
  measuredWrites: number;
  measuredReads: number;
  note: string;
}

export interface ReplayResult {
  profile: TournamentProfile;
  participants: number;
  defaultShareRequests: number;
  defaultShareWrites: number;
  effectiveShareRequests: number;
  effectiveShareWrites: number;
  requests: number;
  rowsWritten: number;
  rowsRead: number;
  queries: number;
  durationMs: number;
  breakdown: Record<string, RouteMetrics>;
  counts: {
    checkins: number;
    ballots: number;
    feedback: number;
    statusChecks: number;
    permits: number;
    heads: number;
    inboxPulls: number;
    acks: number;
    usageFlushes: number;
    usageFlushWrites: number;
    usageFlushReads: number;
    hostClaimWrites: number;
    inboxScanReads: number;
    hostAuthReads: number;
  };
}

export interface InterleavedReadResult {
  tournaments: number;
  roundsMeasured: number;
  ticksPerRound: number;
  submissionsPerTournamentPerRound: number;
  measuredOneRoundInboxReads: number;
  projectedFourRoundInboxReads: number;
  staggeredOneRoundInboxReads?: number;
  staggeredFourRoundInboxReads?: number;
}

export interface ScenarioSummary {
  name: string;
  enforced: boolean;
  requests: number;
  rowsWritten: number;
  rowsRead: number;
  allocatedShareWrites: number;
  pctRequests: number;
  pctWrites: number;
  pctReads: number;
  pctShareWrites: number;
  passed: boolean;
  notes: string;
}

export interface BudgetReport {
  limits: {
    requests: number;
    rowsWritten: number;
    rowsRead: number;
    failRatio: number;
    maxAllocatedShareWrites: number;
  };
  perRoute: PerRouteMeasurement[];
  replays: {
    wudc: ReplayResult;
    small100: ReplayResult;
  };
  interleaved: {
    wudc3: InterleavedReadResult;
    small100x15: InterleavedReadResult;
  };
  scenarios: ScenarioSummary[];
  /** Rows read on a day of 15 × 100-team tournaments whose rounds start 6 minutes apart. */
  staggeredReads?: number;
  findings: string[];
  assumptions: string[];
  overallPassed: boolean;
}

interface ParticipantLink {
  readonly link: LinkFixture;
  readonly role: "team" | "chair" | "panelist";
  readonly roomId: string;
  readonly forms: readonly PermitForm[];
}

function makeLookupId(prefix: "a" | "t", index: number): string {
  const chars = new Array<string>(12).fill(LOOKUP_ALPHABET[0]);
  let v = index + 1;
  for (let i = 11; i >= 0; i--) {
    chars[i] = LOOKUP_ALPHABET[v % LOOKUP_ALPHABET.length];
    v = Math.floor(v / LOOKUP_ALPHABET.length);
  }
  return `${prefix}${chars.join("")}`;
}

async function makeUniqueLinkFixture(
  slug: string,
  prefix: "a" | "t",
  index: number,
): Promise<LinkFixture> {
  const secret = new Uint8Array(16);
  secret[0] = prefix === "t" ? 1 : 2;
  secret[1] = (index >>> 16) & 0xff;
  secret[2] = (index >>> 8) & 0xff;
  secret[3] = index & 0xff;
  secret[15] = 0x5a;
  const keys = await deriveKeys(secret, slug);
  return {
    lookupId: makeLookupId(prefix, index),
    authKey: base64UrlEncode(keys.authKey),
    authKeyBytes: keys.authKey,
    verifier: await verifier(keys.authKey),
  };
}

async function buildParticipantLinks(
  profile: TournamentProfile,
): Promise<ParticipantLink[]> {
  const specs: Array<{
    prefix: "a" | "t";
    index: number;
    role: "team" | "chair" | "panelist";
    roomId: string;
    forms: readonly PermitForm[];
  }> = [];

  for (let t = 0; t < profile.teams; t++) {
    const roomNum = Math.floor(t / 4) + 1;
    specs.push({
      prefix: "t",
      index: t,
      role: "team",
      roomId: `room-${String(roomNum).padStart(3, "0")}`,
      forms: ["checkin", "feedback"],
    });
  }

  for (let a = 0; a < profile.adjudicators; a++) {
    const roomNum = (a % profile.rooms) + 1;
    const isChair = a < profile.rooms;
    specs.push({
      prefix: "a",
      index: a,
      role: isChair ? "chair" : "panelist",
      roomId: `room-${String(roomNum).padStart(3, "0")}`,
      forms: isChair ? ["checkin", "ballot", "feedback"] : ["checkin", "feedback"],
    });
  }

  const out: ParticipantLink[] = new Array(specs.length);
  const batchSize = 50;
  for (let start = 0; start < specs.length; start += batchSize) {
    const slice = specs.slice(start, start + batchSize);
    const fixtures = await Promise.all(
      slice.map((s) => makeUniqueLinkFixture(profile.slug, s.prefix, s.index)),
    );
    for (let i = 0; i < slice.length; i++) {
      out[start + i] = {
        link: fixtures[i],
        role: slice[i].role,
        roomId: slice[i].roomId,
        forms: slice[i].forms,
      };
    }
  }
  return out;
}

function buildRoundPermit(
  participants: readonly ParticipantLink[],
  roundId: string,
  version: number,
  open: boolean,
): PermitUpload {
  const entries: PermitEntry[] = participants.map((p) => ({
    lookupId: p.link.lookupId,
    verifier: p.link.verifier,
    roomId: p.roomId,
    forms: [...p.forms],
  }));
  return {
    schema: SCHEMA_VERSION,
    roundId,
    version,
    open,
    timeZone: "UTC",
    entries,
  };
}

function makeHeadHash(seq: number): string {
  return seq.toString(16).padStart(64, "0");
}

function distributeAcrossTicks<T>(
  items: readonly T[],
  startTick: number,
  endTickInclusive: number,
): Map<number, T[]> {
  const buckets = new Map<number, T[]>();
  const span = endTickInclusive - startTick + 1;
  for (let i = 0; i < items.length; i++) {
    const tick = startTick + Math.floor((i * span) / items.length);
    let list = buckets.get(tick);
    if (!list) {
      list = [];
      buckets.set(tick, list);
    }
    list.push(items[i]);
  }
  return buckets;
}

function distributeCounts(total: number, parts: number): number[] {
  const base = Math.floor(total / parts);
  const rem = total % parts;
  return Array.from({ length: parts }, (_, i) => base + (i < rem ? 1 : 0));
}

export async function measurePerRouteWrites(): Promise<PerRouteMeasurement[]> {
  await resetDatabase();
  const adminEmail = await seedAdmin();
  const slug = "route-probe-2027";
  const approved = await approveTournamentViaAdmin(adminEmail, slug, 900);
  const link = await makeUniqueLinkFixture(slug, "a", 0);

  const t0 = Date.UTC(2026, 10, 24, 8, 0, 0);
  const harness = createBudgetHarness(typedEnv, t0);

  // Establish host_id / host_rank once so steady-state per-route writes do not include initial host claim.
  const prime = await harness.fetch("https://ballots.test/v1/host/inbox?after=0", {
    headers: hostHeaders(approved.key),
  });
  if (prime.response.status !== 200) {
    throw new Error(`Failed to prime host identity: ${prime.response.status}`);
  }
  harness.resetCounters();
  resetUsageCounters();

  // 1. POST /v1/host/permits (first insert for round-1)
  const permitInsert = await harness.fetch("https://ballots.test/v1/host/permits", {
    method: "POST",
    headers: hostHeaders(approved.key),
    body: JSON.stringify({
      schema: SCHEMA_VERSION,
      roundId: "round-1",
      version: 1,
      open: true,
      timeZone: "UTC",
      entries: [
        {
          lookupId: link.lookupId,
          verifier: link.verifier,
          roomId: "room-001",
          forms: ["checkin", "ballot", "feedback"],
        },
      ],
    }),
  });
  if (permitInsert.response.status !== 200) {
    throw new Error(`Permit insert failed: ${permitInsert.response.status}`);
  }

  // 2. POST /v1/host/permits (update existing round-1)
  const permitUpdate = await harness.fetch("https://ballots.test/v1/host/permits", {
    method: "POST",
    headers: hostHeaders(approved.key),
    body: JSON.stringify({
      schema: SCHEMA_VERSION,
      roundId: "round-1",
      version: 2,
      open: true,
      timeZone: "UTC",
      entries: [
        {
          lookupId: link.lookupId,
          verifier: link.verifier,
          roomId: "room-001",
          forms: ["checkin", "ballot", "feedback"],
        },
      ],
    }),
  });
  if (permitUpdate.response.status !== 200) {
    throw new Error(`Permit update failed: ${permitUpdate.response.status}`);
  }

  // 3. POST /v1/submit (new submission)
  const subId = makeUlid();
  const submitNew = await harness.fetch("https://ballots.test/v1/submit", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(
      await makeSignedSubmission({
        slug,
        link,
        roundId: "round-1",
        type: "ballot",
        submissionId: subId,
      }),
    ),
  });
  if (submitNew.response.status !== 200) {
    throw new Error(`Submit failed: ${submitNew.response.status}`);
  }

  // 4. POST /v1/submit (idempotent duplicate)
  const submitDup = await harness.fetch("https://ballots.test/v1/submit", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(
      await makeSignedSubmission({
        slug,
        link,
        roundId: "round-1",
        type: "ballot",
        submissionId: subId,
      }),
    ),
  });
  if (submitDup.response.status !== 200) {
    throw new Error(`Duplicate submit failed: ${submitDup.response.status}`);
  }

  // 5. GET /v1/host/inbox
  const inbox = await harness.fetch("https://ballots.test/v1/host/inbox?after=0", {
    headers: hostHeaders(approved.key),
  });
  if (inbox.response.status !== 200) {
    throw new Error(`Inbox failed: ${inbox.response.status}`);
  }
  const inboxJson = (await inbox.response.json()) as {
    items: Array<{ rowid: number }>;
  };
  const rowid = inboxJson.items[0].rowid;

  // 6. POST /v1/host/ack
  const ack = await harness.fetch("https://ballots.test/v1/host/ack", {
    method: "POST",
    headers: hostHeaders(approved.key),
    body: JSON.stringify({ schema: SCHEMA_VERSION, through: rowid }),
  });
  if (ack.response.status !== 200) {
    throw new Error(`Ack failed: ${ack.response.status}`);
  }

  // 7. GET /v1/status
  const status = await harness.fetch(
    `https://ballots.test/v1/status?slug=${slug}&lookupId=${link.lookupId}&ids=${subId}`,
  );
  if (status.response.status !== 200) {
    throw new Error(`Status failed: ${status.response.status}`);
  }

  // 8. POST /v1/host/head (new seq)
  const head = await harness.fetch("https://ballots.test/v1/host/head", {
    method: "POST",
    headers: hostHeaders(approved.key),
    body: JSON.stringify({
      schema: SCHEMA_VERSION,
      seq: 1,
      headHash: makeHeadHash(1),
    }),
  });
  if (head.response.status !== 200) {
    throw new Error(`Head failed: ${head.response.status}`);
  }

  // 9. Usage flush (1st insert of day vs steady-state update)
  const beforeFlush1 = harness.db.snapshot();
  await flushUsageNow(harness.env.DB, slug, utcDay(t0), t0 + 61_000);
  const flushInsert = harness.db.diff(beforeFlush1);

  await harness.fetch(`https://ballots.test/v1/host/inbox?after=${rowid}`, {
    headers: hostHeaders(approved.key),
  });
  const beforeFlush2 = harness.db.snapshot();
  await flushUsageNow(harness.env.DB, slug, utcDay(t0), t0 + 122_000);
  const flushUpdate = harness.db.diff(beforeFlush2);

  return [
    {
      route: "POST /v1/submit (new)",
      designWrites: 2,
      expectedWrites: 2,
      measuredWrites: submitNew.delta.rowsWritten,
      measuredReads: submitNew.delta.rowsRead,
      note: "1 row + UNIQUE(submission_id) autoindex; no secondary indexes",
    },
    {
      route: "POST /v1/submit (duplicate)",
      designWrites: 0,
      expectedWrites: 0,
      measuredWrites: submitDup.delta.rowsWritten,
      measuredReads: submitDup.delta.rowsRead,
      note: "ON CONFLICT DO NOTHING",
    },
    {
      route: "GET /v1/status",
      designWrites: 0,
      expectedWrites: 0,
      measuredWrites: status.delta.rowsWritten,
      measuredReads: status.delta.rowsRead,
      note: "Read-only; in-memory request counter only",
    },
    {
      route: "GET /v1/host/inbox",
      designWrites: 0,
      expectedWrites: 0,
      measuredWrites: inbox.delta.rowsWritten,
      measuredReads: inbox.delta.rowsRead,
      note: "Read-only rowid scan filtered by slug",
    },
    {
      route: "POST /v1/host/ack",
      designWrites: 1,
      expectedWrites: 1,
      measuredWrites: ack.delta.rowsWritten,
      measuredReads: ack.delta.rowsRead,
      note: "Updates tournaments.acked_through (non-PK column)",
    },
    {
      route: "POST /v1/host/permits (update)",
      designWrites: 1,
      expectedWrites: 1,
      measuredWrites: permitUpdate.delta.rowsWritten,
      measuredReads: permitUpdate.delta.rowsRead,
      note: "ON CONFLICT DO UPDATE on existing (slug, round_id)",
    },
    {
      route: "POST /v1/host/permits (insert)",
      designWrites: 1,
      expectedWrites: 2,
      measuredWrites: permitInsert.delta.rowsWritten,
      measuredReads: permitInsert.delta.rowsRead,
      note: "1 row + PK(slug, round_id) autoindex (table lacks WITHOUT ROWID)",
    },
    {
      route: "POST /v1/host/head (insert)",
      designWrites: 1,
      expectedWrites: 2,
      measuredWrites: head.delta.rowsWritten,
      measuredReads: head.delta.rowsRead,
      note: "1 row + PK(slug, seq) autoindex (table lacks WITHOUT ROWID)",
    },
    {
      route: "Usage flush (steady-state)",
      designWrites: 1,
      expectedWrites: 1,
      measuredWrites: flushUpdate.rowsWritten,
      measuredReads: flushUpdate.rowsRead,
      note: "ON CONFLICT DO UPDATE (1st insert of day writes 2)",
    },
    {
      route: "Usage flush (first of day)",
      designWrites: 1,
      expectedWrites: 2,
      measuredWrites: flushInsert.rowsWritten,
      measuredReads: flushInsert.rowsRead,
      note: "1 row + PK(slug, day) autoindex once per tournament-day",
    },
  ];
}

async function pollAndAck(
  harness: BudgetHarness,
  hostKey: string,
  lastRowId: number,
): Promise<{ nextLastRowId: number; pulls: number; acked: boolean }> {
  let cursor = lastRowId;
  let maxSeen = lastRowId;
  let scannedThrough = lastRowId;
  let pulls = 0;

  while (true) {
    const res = await harness.fetch(
      `https://ballots.test/v1/host/inbox?after=${cursor}&limit=500`,
      { headers: hostHeaders(hostKey) },
      "GET /v1/host/inbox",
    );
    if (res.response.status !== 200) {
      const text = await res.response.text();
      throw new Error(`Inbox pull failed (${res.response.status}): ${text}`);
    }
    pulls += 1;
    const page = (await res.response.json()) as {
      items: Array<{ rowid: number }>;
      next: number | null;
      scanned?: number;
    };
    if (page.items.length > 0) {
      maxSeen = Math.max(maxSeen, page.items[page.items.length - 1].rowid);
    }
    // Like the real host: the next pull starts after everything the service scanned.
    scannedThrough = Math.max(scannedThrough, maxSeen, page.scanned ?? 0);
    if (page.next === null) {
      break;
    }
    cursor = page.next;
  }

  let acked = false;
  if (maxSeen > lastRowId) {
    const ackRes = await harness.fetch(
      "https://ballots.test/v1/host/ack",
      {
        method: "POST",
        headers: hostHeaders(hostKey),
        body: JSON.stringify({ schema: SCHEMA_VERSION, through: maxSeen }),
      },
      "POST /v1/host/ack",
    );
    if (ackRes.response.status !== 200) {
      const text = await ackRes.response.text();
      throw new Error(`Host ack failed (${ackRes.response.status}): ${text}`);
    }
    acked = true;
  }

  return { nextLastRowId: scannedThrough, pulls, acked };
}

export async function replayTournamentDay(
  profile: TournamentProfile,
): Promise<ReplayResult> {
  const startWall = performance.now();
  await resetDatabase();
  const adminEmail = await seedAdmin();
  const participants = profile.teams + profile.adjudicators;
  const defaults = defaultShares(participants);
  const approved = await approveTournamentViaAdmin(
    adminEmail,
    profile.slug,
    participants,
  );

  let effectiveShareRequests = approved.shareRequests;
  const effectiveShareWrites = approved.shareWrites;

  if (profile.shareRequestsOverride !== undefined) {
    const patchRes = await SELF.fetch(
      `https://ballots.test/admin/tournaments/${profile.slug}/share`,
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "Cf-Access-Authenticated-User-Email": adminEmail,
        },
        body: JSON.stringify({ shareRequests: profile.shareRequestsOverride }),
      },
    );
    if (patchRes.status !== 200) {
      throw new Error(`Failed to patch shareRequests: ${patchRes.status}`);
    }
    effectiveShareRequests = profile.shareRequestsOverride;
  }

  const links = await buildParticipantLinks(profile);
  const chairs = links.filter((p) => p.role === "chair");
  const feedbackSenders = links.filter(
    (p) => p.role === "team" || p.role === "panelist",
  );

  const t0 = Date.UTC(2026, 10, 24, 8, 0, 0);
  const harness = createBudgetHarness(typedEnv, t0);
  resetUsageCounters();

  const totalTicks = (profile.dayHours * 3600) / profile.pollIntervalSeconds;
  const ticksPerRound = Math.floor(totalTicks / profile.rounds);
  const headsPerRound = distributeCounts(profile.headsTotal, profile.rounds);

  let lastRowId = 0;
  let headSeq = 0;

  const counts = {
    checkins: 0,
    ballots: 0,
    feedback: 0,
    statusChecks: 0,
    permits: 0,
    heads: 0,
    inboxPulls: 0,
    acks: 0,
    usageFlushes: 0,
    usageFlushWrites: 0,
    usageFlushReads: 0,
    hostClaimWrites: 0,
    inboxScanReads: 0,
    hostAuthReads: 0,
  };

  for (let roundIdx = 0; roundIdx < profile.rounds; roundIdx++) {
    const roundId = `round-${roundIdx + 1}`;
    const roundStartTick = roundIdx * ticksPerRound;

    // Schedule submissions inside each 150-minute (300-tick) round:
    //   ticks 0..39   (20m): check-ins
    //   ticks 40..189 (75m): debate (mid-round permit updates, idle polls)
    //   ticks 190..239 (25m): deliberation & BP consensus ballots
    //   ticks 240..299 (30m): feedback forms
    const checkinBuckets = distributeAcrossTicks(links, 0, 39);
    const ballotBuckets = distributeAcrossTicks(chairs, 190, 239);
    const feedbackBuckets = distributeAcrossTicks(feedbackSenders, 240, 299);

    const statusCheckTicks = distributeCounts(profile.statusChecksPerRound, 3);
    const statusCheckSchedule = new Map<number, number>();
    const addStatusSchedule = (
      count: number,
      start: number,
      end: number,
    ): void => {
      const span = end - start + 1;
      for (let i = 0; i < count; i++) {
        const tick = start + Math.floor((i * span) / count);
        statusCheckSchedule.set(tick, (statusCheckSchedule.get(tick) ?? 0) + 1);
      }
    };
    addStatusSchedule(statusCheckTicks[0], 2, 45);
    addStatusSchedule(statusCheckTicks[1], 192, 242);
    addStatusSchedule(statusCheckTicks[2], 242, ticksPerRound - 1);

    const headTicks = new Map<number, number>();
    const roundHeads = headsPerRound[roundIdx];
    for (let i = 0; i < roundHeads; i++) {
      const tick = Math.floor((i * ticksPerRound) / roundHeads);
      headTicks.set(tick, (headTicks.get(tick) ?? 0) + 1);
    }

    const midRoundPermitTicks = new Set<number>();
    const midUpdates = Math.max(0, profile.permitsPerRound - 2);
    for (let m = 0; m < midUpdates; m++) {
      midRoundPermitTicks.add(60 + m * 60);
    }

    let permitVersion = 0;
    const recentSubmissions: Array<{ lookupId: string; submissionId: string }> = [];
    let statusCursor = 0;

    for (let localTick = 0; localTick < ticksPerRound; localTick++) {
      const globalTick = roundStartTick + localTick;
      harness.nowMs = t0 + globalTick * profile.pollIntervalSeconds * 1000;

      // 1. Open permit at start of round, or mid-round permit revision.
      if (localTick === 0 || midRoundPermitTicks.has(localTick)) {
        permitVersion += 1;
        const permitBody = buildRoundPermit(links, roundId, permitVersion, true);
        const res = await harness.fetch(
          "https://ballots.test/v1/host/permits",
          {
            method: "POST",
            headers: hostHeaders(approved.key),
            body: JSON.stringify(permitBody),
          },
          "POST /v1/host/permits",
        );
        if (res.response.status !== 200) {
          throw new Error(
            `Permit upload failed (round=${roundId}, v=${permitVersion}): ${res.response.status}`,
          );
        }
        counts.permits += 1;
      }

      // 2. Participant submissions scheduled for this 30s tick.
      const submitBatch = async (
        batch: readonly ParticipantLink[] | undefined,
        type: "checkin" | "ballot" | "feedback",
      ): Promise<void> => {
        if (!batch || batch.length === 0) {
          return;
        }
        for (const p of batch) {
          const submissionId = makeUlid();
          const payload =
            type === "checkin"
              ? { roomId: p.roomId, present: true }
              : type === "ballot"
                ? { roomId: p.roomId, ranks: [1, 2, 3, 4], points: [78, 76, 74, 72] }
                : { roomId: p.roomId, score: 8, comment: "Clear call" };

          const signed = await makeSignedSubmission({
            slug: profile.slug,
            link: p.link,
            roundId,
            type,
            submissionId,
            payload,
          });
          const res = await harness.fetch(
            "https://ballots.test/v1/submit",
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(signed),
            },
            `POST /v1/submit (${type})`,
          );
          if (res.response.status !== 200) {
            const errText = await res.response.text();
            throw new Error(
              `Submit ${type} failed at tick ${globalTick} (${res.response.status}): ${errText}`,
            );
          }
          recentSubmissions.push({
            lookupId: p.link.lookupId,
            submissionId,
          });
          if (type === "checkin") {
            counts.checkins += 1;
          } else if (type === "ballot") {
            counts.ballots += 1;
          } else {
            counts.feedback += 1;
          }
        }
      };

      await submitBatch(checkinBuckets.get(localTick), "checkin");
      await submitBatch(ballotBuckets.get(localTick), "ballot");
      await submitBatch(feedbackBuckets.get(localTick), "feedback");

      // 3. Status checks scheduled for this tick.
      const statusCount = statusCheckSchedule.get(localTick) ?? 0;
      for (let s = 0; s < statusCount; s++) {
        const target =
          recentSubmissions.length > 0
            ? recentSubmissions[statusCursor % recentSubmissions.length]
            : { lookupId: links[0].link.lookupId, submissionId: makeUlid() };
        statusCursor += 1;
        const res = await harness.fetch(
          `https://ballots.test/v1/status?slug=${profile.slug}&lookupId=${target.lookupId}&ids=${target.submissionId}`,
          undefined,
          "GET /v1/status",
        );
        if (res.response.status !== 200) {
          const errText = await res.response.text();
          throw new Error(
            `Status check failed at tick ${globalTick} (${res.response.status}): ${errText}`,
          );
        }
        counts.statusChecks += 1;
      }

      // 4. Host head publishes scheduled for this tick.
      const headsNow = headTicks.get(localTick) ?? 0;
      for (let h = 0; h < headsNow; h++) {
        headSeq += 1;
        const res = await harness.fetch(
          "https://ballots.test/v1/host/head",
          {
            method: "POST",
            headers: hostHeaders(approved.key),
            body: JSON.stringify({
              schema: SCHEMA_VERSION,
              seq: headSeq,
              headHash: makeHeadHash(headSeq),
            }),
          },
          "POST /v1/host/head",
        );
        if (res.response.status !== 200) {
          throw new Error(
            `Head publish failed at seq ${headSeq}: ${res.response.status}`,
          );
        }
        counts.heads += 1;
      }

      // 5. Close permit at end of round.
      if (localTick === ticksPerRound - 1) {
        permitVersion += 1;
        const closePermit = buildRoundPermit(links, roundId, permitVersion, false);
        const res = await harness.fetch(
          "https://ballots.test/v1/host/permits",
          {
            method: "POST",
            headers: hostHeaders(approved.key),
            body: JSON.stringify(closePermit),
          },
          "POST /v1/host/permits",
        );
        if (res.response.status !== 200) {
          throw new Error(
            `Close permit failed (round=${roundId}): ${res.response.status}`,
          );
        }
        counts.permits += 1;
      }

      // 6. Host 30s inbox poll + ack on non-empty pulls.
      const polled = await pollAndAck(harness, approved.key, lastRowId);
      lastRowId = polled.nextLastRowId;
      counts.inboxPulls += polled.pulls;
      if (polled.acked) {
        counts.acks += 1;
      }
    }
  }

  // Final flush of any remaining in-memory usage counters at end of day.
  await flushUsageNow(
    harness.env.DB,
    profile.slug,
    utcDay(t0),
    harness.nowMs + 60_000,
  );

  counts.usageFlushes = harness.db.categories.usageFlushQueries;
  counts.usageFlushWrites = harness.db.categories.usageFlushWrites;
  counts.usageFlushReads = harness.db.categories.usageFlushReads;
  counts.hostClaimWrites = harness.db.categories.hostClaimWrites;
  counts.inboxScanReads = harness.db.categories.inboxScanReads;
  counts.hostAuthReads = harness.db.categories.hostAuthReads;

  const breakdown: Record<string, RouteMetrics> = {};
  for (const [k, v] of harness.routes.entries()) {
    breakdown[k] = { ...v };
  }

  return {
    profile,
    participants,
    defaultShareRequests: defaults.shareRequests,
    defaultShareWrites: defaults.shareWrites,
    effectiveShareRequests,
    effectiveShareWrites,
    requests: harness.totalRequests(),
    rowsWritten: harness.db.counts.rowsWritten,
    rowsRead: harness.db.counts.rowsRead,
    queries: harness.db.counts.queries,
    durationMs: Math.round(performance.now() - startWall),
    breakdown,
    counts,
  };
}

/**
 * Measures real D1 rows_read for GET /v1/host/inbox when N tournaments share the
 * submissions table and poll concurrently at 30s cadence over one full round (300 ticks).
 *
 * Uses real tournament approvals (proving N tournaments fit under MAX_ALLOCATED_SHARE_WRITES)
 * and real Worker GET /v1/host/inbox calls through CountingD1, while seeding interleaved
 * submission rows in SQLite batches so the multi-tournament benchmark completes in seconds.
 */
export function simulateStaggeredInterleavedInboxReads(params: {
  tournaments: number;
  participantsPerTournament: number;
  roomsPerTournament: number;
  ticksPerRound: number;
  staggerOffsetTicks: number;
}): { oneRoundReads: number; fourRoundReads: number } {
  const {
    tournaments: n,
    participantsPerTournament,
    roomsPerTournament,
    ticksPerRound,
    staggerOffsetTicks,
  } = params;

  const checkinsPerTick = distributeCounts(participantsPerTournament, 40);
  const ballotsPerTick = distributeCounts(roomsPerTournament, 50);
  const feedbackPerTick = distributeCounts(8 * roomsPerTournament, 60);

  const countForLocalTick = (localTick: number): number => {
    let total = 0;
    if (localTick >= 0 && localTick < 40) {
      total += checkinsPerTick[localTick];
    }
    if (localTick >= 190 && localTick < 240) {
      total += ballotsPerTick[localTick - 190];
    }
    if (localTick >= 240 && localTick < 300) {
      total += feedbackPerTick[localTick - 240];
    }
    return total;
  };

  const cursors = new Array<number>(n).fill(0);
  let globalMaxRowId = 0;
  let totalReads = 0;
  const totalSimTicks = ticksPerRound + (n - 1) * staggerOffsetTicks;

  for (let simTick = 0; simTick < totalSimTicks; simTick++) {
    const tickMaxRowByTournament = new Array<number>(n).fill(0);

    for (let i = 0; i < n; i++) {
      const localTick = simTick - i * staggerOffsetTicks;
      if (localTick < 0 || localTick >= ticksPerRound) {
        continue;
      }
      const added = countForLocalTick(localTick);
      if (added > 0) {
        globalMaxRowId += added;
        tickMaxRowByTournament[i] = globalMaxRowId;
      }
    }

    for (let i = 0; i < n; i++) {
      const localTick = simTick - i * staggerOffsetTicks;
      if (localTick < 0 || localTick >= ticksPerRound) {
        continue;
      }
      // Each GET /v1/host/inbox reads 1 tournaments row (key_hash index), 1 row for
      // MAX(rowid), plus all submissions with rowid > cursors[i] up to globalMaxRowId. The page's
      // `scanned` then moves the host's cursor to globalMaxRowId.
      totalReads += 2 + Math.max(0, globalMaxRowId - cursors[i]);
      cursors[i] = Math.max(cursors[i], globalMaxRowId, tickMaxRowByTournament[i]);
    }
  }

  return {
    oneRoundReads: totalReads,
    fourRoundReads: totalReads * 4,
  };
}

export async function measureInterleavedInboxReads(params: {
  tournaments: number;
  participantsPerTournament: number;
  roomsPerTournament: number;
  ticksPerRound: number;
  staggerOffsetTicks?: number;
}): Promise<InterleavedReadResult> {
  const {
    tournaments: n,
    participantsPerTournament,
    roomsPerTournament,
    ticksPerRound,
    staggerOffsetTicks = 0,
  } = params;

  const runMode = async (offsetTicks: number): Promise<number> => {
    await resetDatabase();
    const adminEmail = await seedAdmin();
    const t0 = Date.UTC(2026, 10, 24, 8, 0, 0);

    const keys: Array<{ slug: string; key: string; cursor: number }> = [];
    for (let i = 0; i < n; i++) {
      const slug = `interleaved-${n}-${String(i + 1).padStart(2, "0")}`;
      const approved = await approveTournamentViaAdmin(
        adminEmail,
        slug,
        participantsPerTournament,
      );
      if (!approved.key) {
        throw new Error(
          `Approval failed for ${slug} (likely exceeded MAX_ALLOCATED_SHARE_WRITES)`,
        );
      }
      keys.push({ slug, key: approved.key, cursor: 0 });
    }

    const harness = createBudgetHarness(typedEnv, t0);

    // Prime host identities so host_id claim writes do not occur during read measurement.
    for (const entry of keys) {
      const res = await harness.fetch("https://ballots.test/v1/host/inbox?after=0", {
        headers: hostHeaders(entry.key),
      });
      if (res.response.status !== 200) {
        throw new Error(`Prime failed for ${entry.slug}: ${res.response.status}`);
      }
    }
    harness.resetCounters();
    resetUsageCounters();

    // Per-round submission counts matching replayTournamentDay:
    // check-ins (P across 40 ticks), ballots (rooms across 50 ticks), feedback (8*rooms across 60 ticks).
    const checkinsPerTick = distributeCounts(participantsPerTournament, 40);
    const ballotsPerTick = distributeCounts(roomsPerTournament, 50);
    const feedbackPerTick = distributeCounts(8 * roomsPerTournament, 60);

    const submissionsForLocalTick = (
      localTick: number,
    ): Array<{ type: string; count: number }> => {
      const out: Array<{ type: string; count: number }> = [];
      if (localTick >= 0 && localTick < 40 && checkinsPerTick[localTick] > 0) {
        out.push({ type: "checkin", count: checkinsPerTick[localTick] });
      }
      if (localTick >= 190 && localTick < 240 && ballotsPerTick[localTick - 190] > 0) {
        out.push({ type: "ballot", count: ballotsPerTick[localTick - 190] });
      }
      if (localTick >= 240 && localTick < 300 && feedbackPerTick[localTick - 240] > 0) {
        out.push({ type: "feedback", count: feedbackPerTick[localTick - 240] });
      }
      return out;
    };

    const totalSimTicks = ticksPerRound + (n - 1) * offsetTicks;
    const payloadJson = JSON.stringify({ roomId: "room-001", ok: true });

    for (let simTick = 0; simTick < totalSimTicks; simTick++) {
      harness.nowMs = t0 + simTick * 30_000;
      const receivedAt = new Date(harness.nowMs).toISOString();

      // 1. Insert interleaved rows for all tournaments active at simTick using unwrapped DB.
      const insertStmts: D1PreparedStatement[] = [];
      for (let i = 0; i < n; i++) {
        const localTick = simTick - i * offsetTicks;
        if (localTick < 0 || localTick >= ticksPerRound) {
          continue;
        }
        const items = submissionsForLocalTick(localTick);
        for (const item of items) {
          for (let c = 0; c < item.count; c++) {
            insertStmts.push(
              typedEnv.DB.prepare(
                `INSERT INTO submissions (submission_id, slug, round_id, lookup_id, type, payload, received_at)
                 VALUES (?, ?, 'round-1', 'aabcdefghjkmn', ?, ?, ?)`,
              ).bind(makeUlid(), keys[i].slug, item.type, payloadJson, receivedAt),
            );
          }
        }
      }

      for (let start = 0; start < insertStmts.length; start += 100) {
        await typedEnv.DB.batch(insertStmts.slice(start, start + 100));
      }

      // 2. Every active tournament polls GET /v1/host/inbox with its own last-matched rowid cursor.
      for (let i = 0; i < n; i++) {
        const localTick = simTick - i * offsetTicks;
        if (localTick < 0 || localTick >= ticksPerRound) {
          continue;
        }
        let pageCursor = keys[i].cursor;
        let maxMatched = keys[i].cursor;
        while (true) {
          const res = await harness.fetch(
            `https://ballots.test/v1/host/inbox?after=${pageCursor}&limit=500`,
            { headers: hostHeaders(keys[i].key) },
            "GET /v1/host/inbox",
          );
          if (res.response.status !== 200) {
            throw new Error(
              `Interleaved inbox failed for ${keys[i].slug}: ${res.response.status}`,
            );
          }
          const page = (await res.response.json()) as {
            items: Array<{ rowid: number }>;
            next: number | null;
            scanned?: number;
          };
          if (page.items.length > 0) {
            maxMatched = Math.max(
              maxMatched,
              page.items[page.items.length - 1].rowid,
            );
          }
          maxMatched = Math.max(maxMatched, page.scanned ?? 0);
          if (page.next === null) {
            break;
          }
          pageCursor = page.next;
        }
        keys[i].cursor = maxMatched;
      }
    }

    return harness.db.counts.rowsRead;
  };

  const syncReads = await runMode(0);
  const staggered =
    staggerOffsetTicks > 0
      ? simulateStaggeredInterleavedInboxReads({
          tournaments: n,
          participantsPerTournament,
          roomsPerTournament,
          ticksPerRound,
          staggerOffsetTicks,
        })
      : undefined;

  return {
    tournaments: n,
    roundsMeasured: 1,
    ticksPerRound,
    submissionsPerTournamentPerRound:
      participantsPerTournament + roomsPerTournament + 8 * roomsPerTournament,
    measuredOneRoundInboxReads: syncReads,
    projectedFourRoundInboxReads: syncReads * 4,
    staggeredOneRoundInboxReads: staggered?.oneRoundReads,
    staggeredFourRoundInboxReads: staggered?.fourRoundReads,
  };
}

export function buildBudgetReport(params: {
  perRoute: PerRouteMeasurement[];
  wudc: ReplayResult;
  small100: ReplayResult;
  wudc3Interleaved: InterleavedReadResult;
  small100x15Interleaved: InterleavedReadResult;
}): BudgetReport {
  const { perRoute, wudc, small100, wudc3Interleaved, small100x15Interleaved } =
    params;

  const makeScenario = (input: {
    name: string;
    enforced: boolean;
    requests: number;
    rowsWritten: number;
    rowsRead: number;
    allocatedShareWrites: number;
    notes: string;
  }): ScenarioSummary => {
    const pctRequests = input.requests / FREE_DAILY_REQUESTS;
    const pctWrites = input.rowsWritten / FREE_DAILY_WRITES;
    const pctReads = input.rowsRead / FREE_DAILY_READS;
    const pctShareWrites = input.allocatedShareWrites / ALLOCATED_SHARE_WRITES_CAP;

    const withinLimits =
      pctRequests <= BUDGET_MAX_RATIO &&
      pctWrites <= BUDGET_MAX_RATIO &&
      pctReads <= BUDGET_MAX_RATIO &&
      input.allocatedShareWrites <= ALLOCATED_SHARE_WRITES_CAP;

    return {
      ...input,
      pctRequests,
      pctWrites,
      pctReads,
      pctShareWrites,
      passed: input.enforced ? withinLimits : true,
    };
  };

  // Helper to compute total rows read for N concurrent tournaments:
  //   N * (single-day non-inbox reads)
  // + N * (N - 1) * (non-inbox host auth calls, since `WHERE key_hash = ?` scans N tournaments)
  // + measured 4-round interleaved inbox reads (which already includes host auth scan on every pull).
  const computeConcurrentReads = (
    single: ReplayResult,
    interleaved: InterleavedReadResult,
  ): number => {
    const n = interleaved.tournaments;
    const singleInboxRoute = single.breakdown["GET /v1/host/inbox"];
    const singleInboxReads = singleInboxRoute ? singleInboxRoute.rowsRead : 0;
    const singleNonInboxReads = single.rowsRead - singleInboxReads;
    const nonInboxHostCalls =
      single.counts.acks + single.counts.permits + single.counts.heads;
    const extraAuthTableScanReads = n * (n - 1) * nonInboxHostCalls;
    return (
      n * singleNonInboxReads +
      extraAuthTableScanReads +
      interleaved.projectedFourRoundInboxReads
    );
  };

  // Extrapolate 1000-team BP day (250 rooms, 1,250 adjudicators, P = 2,250) from WUDC (100 rooms, P = 900).
  // Participant/room traffic scales by 2.5x (250/100); fixed 10h polling/acks/permits/flushes stay 1-tournament scale.
  const roomScale = 250 / wudc.profile.rooms; // 2.5
  const submitWritesPerRow =
    perRoute.find((r) => r.route === "POST /v1/submit (new)")?.measuredWrites ?? 2;
  const headWritesPerRow =
    perRoute.find((r) => r.route === "POST /v1/host/head (insert)")?.measuredWrites ?? 2;

  const submitRouteReq =
    wudc.counts.checkins + wudc.counts.ballots + wudc.counts.feedback;
  const scaledWudcWrites =
    submitRouteReq * submitWritesPerRow + wudc.counts.heads * headWritesPerRow;
  const fixedWudcWrites = wudc.rowsWritten - scaledWudcWrites;

  // For reads, isolate fixed host/flush overhead from submission/status/inbox-scan reads.
  const fixedWudcReads =
    wudc.counts.usageFlushReads +
    wudc.counts.inboxPulls + // 1-row tournaments auth lookup per inbox pull
    wudc.counts.acks * 2 + // auth + update row lookup
    wudc.counts.permits * 2; // auth + permit row lookup
  const scaledWudcReads = Math.max(0, wudc.rowsRead - fixedWudcReads);

  const bp1000Requests = Math.round(
    roomScale * (submitRouteReq + wudc.counts.statusChecks + wudc.counts.heads) +
      wudc.counts.permits +
      wudc.counts.inboxPulls +
      wudc.counts.acks,
  );
  const bp1000Writes = Math.round(roomScale * scaledWudcWrites + fixedWudcWrites);
  const bp1000Reads = Math.round(roomScale * scaledWudcReads + fixedWudcReads);
  const bp1000ShareWrites = defaultShares(2250).shareWrites;

  const scenarios: ScenarioSummary[] = [
    makeScenario({
      name: "1 × WUDC (replayed)",
      enforced: true,
      requests: wudc.requests,
      rowsWritten: wudc.rowsWritten,
      rowsRead: wudc.rowsRead,
      allocatedShareWrites: wudc.defaultShareWrites,
      notes: `Replayed end-to-end (${wudc.durationMs}ms); fits defaultShares(900)`,
    }),
    makeScenario({
      name: "1 × 100-team (replayed)",
      enforced: true,
      requests: small100.requests,
      rowsWritten: small100.rowsWritten,
      rowsRead: small100.rowsRead,
      allocatedShareWrites: small100.defaultShareWrites,
      notes: `Replayed end-to-end (${small100.durationMs}ms); shareRequests overridden to ${small100.effectiveShareRequests}`,
    }),
    makeScenario({
      name: "3 × WUDC (capacity)",
      enforced: true,
      requests: wudc.requests * 3,
      rowsWritten: wudc.rowsWritten * 3,
      rowsRead: computeConcurrentReads(wudc, wudc3Interleaved),
      allocatedShareWrites: wudc.defaultShareWrites * 3,
      notes: "3× WUDC req/writes; real 3-way interleaved inbox read model",
    }),
    makeScenario({
      name: "15 × 100-team (capacity)",
      enforced: true,
      requests: small100.requests * 15,
      rowsWritten: small100.rowsWritten * 15,
      rowsRead: computeConcurrentReads(small100, small100x15Interleaved),
      allocatedShareWrites: small100.defaultShareWrites * 15,
      notes: "15× 100-team req/writes; real 15-way synchronized interleaved inbox reads",
    }),
    makeScenario({
      name: "1 × 1000-team BP (report)",
      enforced: false,
      requests: bp1000Requests,
      rowsWritten: bp1000Writes,
      rowsRead: bp1000Reads,
      allocatedShareWrites: bp1000ShareWrites,
      notes: "Report only; 2.5× WUDC room-scaled + fixed host polling (solo day)",
    }),
  ];

  const findings: string[] = [
    `Composite-PK inserts without WITHOUT ROWID write 2 rows (row + PK autoindex): permits insert = 2 (update = 1), heads insert = 2, usage 1st flush of day = 2 (subsequent flushes = 1). Design section 13 estimated 1 each.`,
    `1 × 100-team measured ${small100.requests.toLocaleString("en-US")} requests and ${small100.rowsWritten.toLocaleString("en-US")} writes vs design's ~4,200 writes and defaultShares(225) = (${small100.defaultShareRequests.toLocaleString("en-US")} req, ${small100.defaultShareWrites.toLocaleString("en-US")} writes): fixed 10h 30s host polling (${small100.counts.inboxPulls} pulls + ${small100.counts.acks} acks + ${small100.counts.usageFlushes} flushes) does not scale down 4× with room count, so a 100-team day uses ${small100.requests} of its ${small100.defaultShareRequests} default requests (the request formula is 2,000 + 12 × P for this reason) and ${small100.rowsWritten} of ${small100.defaultShareWrites} writes.`,
    `1 × WUDC measured ${wudc.requests.toLocaleString("en-US")} requests and ${wudc.rowsWritten.toLocaleString("en-US")} writes (1 isolate, ${wudc.counts.acks} acks, ${wudc.counts.usageFlushes} flushes) vs design's ~10,850 requests and ~16,750 writes (which assumed 1,200 acks and 1,000 multi-isolate flushes).`,
  ];

  let staggeredReadsTotal: number | undefined;
  if (small100x15Interleaved.staggeredFourRoundInboxReads !== undefined) {
    const staggeredTotalReads =
      15 *
        (small100.rowsRead -
          (small100.breakdown["GET /v1/host/inbox"]?.rowsRead ?? 0)) +
      15 *
        14 *
        (small100.counts.acks + small100.counts.permits + small100.counts.heads) +
      small100x15Interleaved.staggeredFourRoundInboxReads;
    const staggeredPct = ((staggeredTotalReads / FREE_DAILY_READS) * 100).toFixed(1);
    findings.push(
      `Staggered schedules (15 × 100-team, each 6 min after the last): ${staggeredTotalReads.toLocaleString("en-US")} rows read (${staggeredPct}% of 5M). Hosts start each pull at the page's \`scanned\` rowid, so quiet pulls do not re-read other tournaments' rows.`,
    );
    staggeredReadsTotal = staggeredTotalReads;
  }

  const assumptions: string[] = [
    "3 × WUDC and 15 × 100-team requests and rows written are multiplied from the single-tournament Miniflare replays.",
    "1 × 1000-team BP (250 rooms, 2,250 participants) is extrapolated as 2.5× WUDC participant/room traffic + 1× fixed host polling/acks/flushes.",
    "Capacity rows_read models concurrent synchronized 4-round schedules via real 1-round N-way interleaved Miniflare inbox scans (× 4 rounds); host auth reads 1 tournaments row through the key_hash index (migration 0003).",
    "Usage flushes reflect a single Worker isolate (~600 flushes/tournament over 10h); multi-isolate edge routing can add up to ~400 extra flush writes per active tournament-day.",
    "Rate-limit bindings (RL_LINK 10/60s, RL_IP 20/60s) are evaluated against the simulated 10-hour clock rather than wall-clock replay time.",
  ];

  const perRoutePassed = perRoute.every(
    (r) => r.measuredWrites === r.expectedWrites,
  );
  const scenariosPassed = scenarios.every((s) => s.passed);

  return {
    limits: {
      requests: FREE_DAILY_REQUESTS,
      rowsWritten: FREE_DAILY_WRITES,
      rowsRead: FREE_DAILY_READS,
      failRatio: BUDGET_MAX_RATIO,
      maxAllocatedShareWrites: ALLOCATED_SHARE_WRITES_CAP,
    },
    perRoute,
    replays: { wudc, small100 },
    interleaved: {
      wudc3: wudc3Interleaved,
      small100x15: small100x15Interleaved,
    },
    scenarios,
    ...(staggeredReadsTotal !== undefined ? { staggeredReads: staggeredReadsTotal } : {}),
    findings,
    assumptions,
    overallPassed:
      perRoutePassed &&
      scenariosPassed &&
      (staggeredReadsTotal === undefined ||
        staggeredReadsTotal <= FREE_DAILY_READS * BUDGET_MAX_RATIO),
  };
}
