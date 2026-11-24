import {
  bucketForRowId,
  computeRowId,
  sealRound,
  type RoundBundleRow,
} from "@simpletab/core/bundle";
import { deriveKeys, newLink, type DerivedKeys, type GeneratedLink } from "@simpletab/core/crypto";
import { SCHEMA_VERSION } from "@simpletab/core/wire";
import type {
  BallotCollectionMode,
  FormsFile,
  MotionsFile,
  TournamentManifest,
} from "../src/manifest";

export interface RoundFixture {
  link: GeneratedLink;
  keys: DerivedKeys;
  bucketIndex: number;
  manifest: TournamentManifest;
  formsFile: FormsFile;
  motionsFile?: MotionsFile;
  buckets: Map<number, Uint8Array>;
  row: RoundBundleRow;
}

export async function createRoundFixture(options: {
  slug?: string;
  cdnHost?: string;
  ballotsOrigin?: string;
  roundId?: string;
  roundSeq?: number;
  roundName?: string;
  passcode?: string;
  usesPasscodes?: boolean;
  mode?: BallotCollectionMode;
  ballotDeadline?: string;
  feedbackDeadline?: string;
  timeZone?: string;
  format?: "bp" | "australs";
  includeMotion?: boolean;
  forms?: string[];
  extraFormsFile?: Partial<FormsFile>;
} = {}): Promise<RoundFixture> {
  const slug = options.slug ?? "wudc-2027";
  const cdnHost = options.cdnHost ?? "wudc2027.pages.dev";
  const ballotsOrigin = options.ballotsOrigin ?? "https://ballots.simpletab.org";
  const roundId = options.roundId ?? "round-1";
  const roundSeq = options.roundSeq ?? 1;
  const roundName = options.roundName ?? "Round 1";
  const format = options.format ?? "bp";

  const link = newLink("adjudicator", cdnHost, ballotsOrigin, slug);
  const keys = await deriveKeys(link.secret, slug, options.passcode);

  const row: RoundBundleRow = {
    room: "Room 101",
    venue: "Main Hall",
    side: format === "bp" ? undefined : undefined,
    panel: [
      { name: "Alice Chair", role: "Chair" },
      { name: "Bob Panel", role: "Panellist" },
    ],
    forms: options.forms ?? ["ballot-1", "feedback-1", "checkin-1"],
  };

  const buckets = await sealRound({
    roundSeq,
    roundId,
    rows: [
      {
        lookupId: link.lookupId,
        keys: { fileKey: keys.fileKey, lookupKey: keys.lookupKey },
        row,
      },
    ],
  });

  const rowId = await computeRowId(keys.lookupKey, roundId);
  const bucketIndex = bucketForRowId(rowId);

  const bucketPaths: Record<string, string> = {};
  for (let b = 0; b < 32; b++) {
    bucketPaths[String(b)] = `rounds/${roundSeq}/${b}.deadbeef.bin`;
  }

  const motionsFile: MotionsFile | undefined = options.includeMotion
    ? {
        schema: SCHEMA_VERSION,
        roundId,
        roundSeq,
        motions: [
          {
            id: "m1",
            text: "This House believes that offline-first software beats cloud-first software.",
            infoSlide: "Consider debate venues with unreliable Wi-Fi.",
          },
        ],
      }
    : undefined;

  const formsFile: FormsFile = {
    schema: SCHEMA_VERSION,
    roundId,
    roundSeq,
    format,
    stage: "preliminary",
    preferences:
      format === "bp"
        ? {
            teamsInDebate: 4,
            substantiveSpeakers: 2,
            replyScoresEnabled: false,
            minSpeakerScore: 68,
            maxSpeakerScore: 84,
            stepSpeakerScore: 1,
          }
        : {
            teamsInDebate: 2,
            substantiveSpeakers: 3,
            replyScoresEnabled: true,
            minSpeakerScore: 68,
            maxSpeakerScore: 84,
            stepSpeakerScore: 1,
            minReplyScore: 34,
            maxReplyScore: 42,
            stepReplyScore: 0.5,
            sideNames: "aff-neg",
          },
    forms: {
      "ballot-1":
        format === "bp"
          ? {
              id: "ballot-1",
              kind: "ballot",
              mode: "consensus",
              sides: {
                OG: {
                  teamId: "t-og",
                  teamName: "Oxford A",
                  speakers: [
                    { id: "og1", name: "OG Speaker 1" },
                    { id: "og2", name: "OG Speaker 2" },
                  ],
                },
                OO: {
                  teamId: "t-oo",
                  teamName: "Cambridge A",
                  speakers: [
                    { id: "oo1", name: "OO Speaker 1" },
                    { id: "oo2", name: "OO Speaker 2" },
                  ],
                },
                CG: {
                  teamId: "t-cg",
                  teamName: "Dhaka A",
                  speakers: [
                    { id: "cg1", name: "CG Speaker 1" },
                    { id: "cg2", name: "CG Speaker 2" },
                  ],
                },
                CO: {
                  teamId: "t-co",
                  teamName: "BUET A",
                  speakers: [
                    { id: "co1", name: "CO Speaker 1" },
                    { id: "co2", name: "CO Speaker 2" },
                  ],
                },
              },
            }
          : {
              id: "ballot-1",
              kind: "ballot",
              mode: "consensus",
              sides: {
                AFF: {
                  teamId: "t-aff",
                  teamName: "Sydney A",
                  speakers: [
                    { id: "a1", name: "Aff 1" },
                    { id: "a2", name: "Aff 2" },
                    { id: "a3", name: "Aff 3" },
                  ],
                },
                NEG: {
                  teamId: "t-neg",
                  teamName: "Monash A",
                  speakers: [
                    { id: "n1", name: "Neg 1" },
                    { id: "n2", name: "Neg 2" },
                    { id: "n3", name: "Neg 3" },
                  ],
                },
              },
            },
      "feedback-1": {
        id: "feedback-1",
        kind: "feedback",
        targetType: "adjudicator",
        targets: [{ id: "adj-1", name: "Alice Chair", role: "Chair" }],
        questions: [
          {
            id: "q-text",
            label: "Comments",
            type: "text",
            required: false,
          },
          {
            id: "q-scale",
            label: "Clarity",
            type: "integer_scale",
            required: true,
            min: 1,
            max: 5,
          },
        ],
      },
      "checkin-1": {
        id: "checkin-1",
        kind: "checkin",
        roundId,
        roundName,
      },
    },
    ...options.extraFormsFile,
  };

  const manifest: TournamentManifest = {
    schema: SCHEMA_VERSION,
    slug,
    tournamentName: "WUDC 2027",
    timeZone: options.timeZone ?? "Asia/Dhaka",
    publishedAt: "2026-11-24T10:00:00.000Z",
    ballotCollectionMode: options.mode ?? "online",
    ...(options.usesPasscodes !== undefined ? { usesPasscodes: options.usesPasscodes } : {}),
    currentRoundSeq: roundSeq,
    rounds: [
      {
        roundId,
        roundSeq,
        roundName,
        stage: "preliminary",
        open: true,
        buckets: bucketPaths,
        formsFile: `forms/${roundSeq}.cafebabe.json`,
        ...(motionsFile ? { motionsFile: `motions/${roundSeq}.json` } : {}),
        ...(options.ballotDeadline ? { ballotDeadline: options.ballotDeadline } : {}),
        ...(options.feedbackDeadline ? { feedbackDeadline: options.feedbackDeadline } : {}),
      },
    ],
  };

  return {
    link,
    keys,
    bucketIndex,
    manifest,
    formsFile,
    motionsFile,
    buckets,
    row,
  };
}

export function createCdnFetchMock(
  fixture: RoundFixture,
  apiHandler?: (url: string, init?: RequestInit) => Promise<Response>,
): typeof fetch {
  const cdnPrefix = `https://${fixture.link.cdnHost}/`;
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url === `${cdnPrefix}manifest.json`) {
      return new Response(JSON.stringify(fixture.manifest), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.startsWith(`${cdnPrefix}forms/`)) {
      return new Response(JSON.stringify(fixture.formsFile), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.startsWith(`${cdnPrefix}motions/`) && fixture.motionsFile) {
      return new Response(JSON.stringify(fixture.motionsFile), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.startsWith(`${cdnPrefix}rounds/`)) {
      const match = /rounds\/\d+\/(\d+)\./.exec(url);
      const b = match ? Number(match[1]) : -1;
      const bytes = fixture.buckets.get(b);
      if (!bytes) {
        return new Response("Not found", { status: 404 });
      }
      const copy = new Uint8Array(bytes.byteLength);
      copy.set(bytes);
      return new Response(copy.buffer, {
        status: 200,
        headers: { "Content-Type": "application/octet-stream" },
      });
    }
    if (apiHandler) {
      return apiHandler(url, init);
    }
    return new Response("Unexpected fetch", { status: 500 });
  };
}
