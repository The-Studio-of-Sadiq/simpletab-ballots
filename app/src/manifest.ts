import type {
  DebateSide,
  FeedbackQuestion,
  TournamentFormat,
  TournamentPreferences,
} from "@/types";
import { acceptsSchema, err, ok, type Result } from "@simpletab/core/wire";

/**
 * Minimal manifest, forms, and motions contract published by the tournament host
 * (step c) to the tournament's static CDN and read by the participant phone app.
 *
 * CDN layout:
 * - `https://<cdnHost>/manifest.json` -> {@link TournamentManifest}
 * - `https://<cdnHost>/<round.buckets[b]>` (e.g. `rounds/<n>/<b>.<hash>.bin`)
 * - `https://<cdnHost>/<round.formsFile>` (e.g. `forms/<n>.<hash>.json`)
 * - `https://<cdnHost>/<round.motionsFile>` (e.g. `motions/<n>.json`, present only once released)
 */

export type BallotCollectionMode = "online" | "online_and_qr" | "qr_only";

export interface RoundManifestEntry {
  roundId: string;
  roundSeq: number;
  roundName: string;
  stage: "preliminary" | "elimination";
  open: boolean;
  /** Map of bucket index `"0"`..`"31"` to relative CDN path (`rounds/<n>/<b>.<hash>.bin`). */
  buckets: Record<string, string>;
  /** Relative CDN path to the round's form definitions (`forms/<n>.<hash>.json`). */
  formsFile: string;
  /** Relative CDN path to released motions (`motions/<n>.json`); omitted until released. */
  motionsFile?: string;
  /** Optional UTC ISO 8601 ballot closing instant. */
  ballotDeadline?: string;
  /** Optional UTC ISO 8601 feedback closing instant. */
  feedbackDeadline?: string;
}

export interface TournamentManifest {
  schema: number;
  slug: string;
  tournamentName: string;
  /** IANA time zone name (e.g. `"Asia/Dhaka"`). */
  timeZone: string;
  publishedAt: string;
  ballotCollectionMode: BallotCollectionMode;
  usesPasscodes?: boolean;
  defaultLanguage?: string;
  currentRoundSeq: number;
  rounds: RoundManifestEntry[];
  headHash?: string;
}

export interface BallotSpeakerRoster {
  id: string;
  name: string;
}

export interface BallotSideRoster {
  teamId: string;
  teamName: string;
  speakers: BallotSpeakerRoster[];
}

export interface BallotFormDefinition {
  id: string;
  kind: "ballot";
  mode: "consensus" | "voting_sheet";
  title?: string;
  intro?: string;
  /** Side rosters for this room (inline on room-specific form definitions). */
  sides?: Partial<Record<DebateSide, BallotSideRoster>>;
  /** Optional room-keyed rosters if a single form definition covers multiple rooms. */
  rooms?: Record<string, Partial<Record<DebateSide, BallotSideRoster>>>;
  votingAdjudicatorCount?: number;
}

export interface FeedbackTarget {
  id: string;
  name: string;
  role?: string;
}

export interface FeedbackFormDefinition {
  id: string;
  kind: "feedback";
  title?: string;
  introduction?: string;
  targetType: "adjudicator" | "team";
  targets?: FeedbackTarget[];
  minScore?: number;
  maxScore?: number;
  scoreStep?: number;
  questions: FeedbackQuestion[];
}

export interface CheckInFormDefinition {
  id: string;
  kind: "checkin";
  title?: string;
  roundId: string;
  roundName: string;
  prompt?: string;
}

export type FormDefinition =
  | BallotFormDefinition
  | FeedbackFormDefinition
  | CheckInFormDefinition;

export interface FormsFile {
  schema: number;
  roundId: string;
  roundSeq: number;
  format: TournamentFormat;
  stage: "preliminary" | "elimination";
  preferences?: Partial<TournamentPreferences>;
  forms: Record<string, FormDefinition>;
}

export interface MotionItem {
  id: string;
  text: string;
  infoSlide?: string;
}

export interface MotionsFile {
  schema: number;
  roundId: string;
  roundSeq: number;
  motions: MotionItem[];
}

const VALID_MODES = new Set<BallotCollectionMode>(["online", "online_and_qr", "qr_only"]);
const VALID_FORMATS = new Set<TournamentFormat>([
  "bp",
  "uadc",
  "australs",
  "wsdc",
  "custom_2team",
  "poly",
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isNonNegInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function validateRelativeCdnPath(value: unknown): value is string {
  if (!isNonEmptyString(value)) return false;
  if (value.includes("..") || value.includes("\\") || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value)) {
    return false;
  }
  return true;
}

/**
 * Resolves a relative CDN path against a validated bare `cdnHost`.
 * Rejects protocol-relative URLs and `..` path traversal.
 */
export function resolveCdnUrl(cdnHost: string, relativePath: string): string {
  if (!validateRelativeCdnPath(relativePath)) {
    throw new Error(`Invalid CDN relative path: "${relativePath}"`);
  }
  const cleanPath = relativePath.replace(/^\/+/, "");
  return `https://${cdnHost}/${cleanPath}`;
}

function parseRoundEntry(
  raw: unknown,
  path: string,
  errors: string[],
): RoundManifestEntry | null {
  if (!isPlainObject(raw)) {
    errors.push(`${path}: must be an object`);
    return null;
  }
  const start = errors.length;
  if (!isNonEmptyString(raw.roundId)) {
    errors.push(`${path}.roundId: must be a non-empty string`);
  }
  if (!isNonNegInt(raw.roundSeq)) {
    errors.push(`${path}.roundSeq: must be a non-negative integer`);
  }
  if (!isNonEmptyString(raw.roundName)) {
    errors.push(`${path}.roundName: must be a non-empty string`);
  }
  if (raw.stage !== "preliminary" && raw.stage !== "elimination") {
    errors.push(`${path}.stage: must be preliminary or elimination`);
  }
  if (typeof raw.open !== "boolean") {
    errors.push(`${path}.open: must be a boolean`);
  }
  if (!validateRelativeCdnPath(raw.formsFile)) {
    errors.push(`${path}.formsFile: must be a valid relative CDN path`);
  }
  if (raw.motionsFile !== undefined && !validateRelativeCdnPath(raw.motionsFile)) {
    errors.push(`${path}.motionsFile: must be a valid relative CDN path`);
  }
  if (raw.ballotDeadline !== undefined && !Number.isFinite(Date.parse(String(raw.ballotDeadline)))) {
    errors.push(`${path}.ballotDeadline: must be a valid ISO timestamp`);
  }
  if (raw.feedbackDeadline !== undefined && !Number.isFinite(Date.parse(String(raw.feedbackDeadline)))) {
    errors.push(`${path}.feedbackDeadline: must be a valid ISO timestamp`);
  }

  const buckets: Record<string, string> = {};
  if (!isPlainObject(raw.buckets)) {
    errors.push(`${path}.buckets: must be an object mapping bucket 0..31 to paths`);
  } else {
    for (const [k, v] of Object.entries(raw.buckets)) {
      if (!validateRelativeCdnPath(v)) {
        errors.push(`${path}.buckets[${k}]: must be a valid relative CDN path`);
      } else {
        buckets[k] = v;
      }
    }
  }

  if (errors.length > start) {
    return null;
  }

  const entry: RoundManifestEntry = {
    roundId: raw.roundId as string,
    roundSeq: raw.roundSeq as number,
    roundName: raw.roundName as string,
    stage: raw.stage as "preliminary" | "elimination",
    open: raw.open as boolean,
    buckets,
    formsFile: raw.formsFile as string,
  };
  if (typeof raw.motionsFile === "string") {
    entry.motionsFile = raw.motionsFile;
  }
  if (typeof raw.ballotDeadline === "string") {
    entry.ballotDeadline = raw.ballotDeadline;
  }
  if (typeof raw.feedbackDeadline === "string") {
    entry.feedbackDeadline = raw.feedbackDeadline;
  }
  return entry;
}

/**
 * Parses and validates a published `manifest.json` payload.
 */
export function parseManifest(input: unknown): Result<TournamentManifest> {
  if (!isPlainObject(input)) {
    return err("$: manifest must be a JSON object");
  }

  const errors: string[] = [];
  if (!acceptsSchema(input.schema)) {
    errors.push("schema: unsupported or missing schema version");
  }
  if (!isNonEmptyString(input.slug)) {
    errors.push("slug: must be a non-empty string");
  }
  if (!isNonEmptyString(input.tournamentName)) {
    errors.push("tournamentName: must be a non-empty string");
  }
  if (!isNonEmptyString(input.timeZone)) {
    errors.push("timeZone: must be a non-empty IANA time zone string");
  }
  if (!isNonEmptyString(input.publishedAt)) {
    errors.push("publishedAt: must be a non-empty string");
  }
  if (!VALID_MODES.has(input.ballotCollectionMode as BallotCollectionMode)) {
    errors.push("ballotCollectionMode: must be online, online_and_qr, or qr_only");
  }
  if (!isNonNegInt(input.currentRoundSeq)) {
    errors.push("currentRoundSeq: must be a non-negative integer");
  }

  const rounds: RoundManifestEntry[] = [];
  if (!Array.isArray(input.rounds)) {
    errors.push("rounds: must be an array");
  } else {
    for (let i = 0; i < input.rounds.length; i++) {
      const round = parseRoundEntry(input.rounds[i], `rounds[${i}]`, errors);
      if (round !== null) {
        rounds.push(round);
      }
    }
  }

  if (errors.length > 0) {
    return err(errors);
  }

  const manifest: TournamentManifest = {
    schema: input.schema as number,
    slug: input.slug as string,
    tournamentName: input.tournamentName as string,
    timeZone: input.timeZone as string,
    publishedAt: input.publishedAt as string,
    ballotCollectionMode: input.ballotCollectionMode as BallotCollectionMode,
    currentRoundSeq: input.currentRoundSeq as number,
    rounds,
  };
  if (typeof input.usesPasscodes === "boolean") {
    manifest.usesPasscodes = input.usesPasscodes;
  }
  if (typeof input.defaultLanguage === "string") {
    manifest.defaultLanguage = input.defaultLanguage;
  }
  if (typeof input.headHash === "string") {
    manifest.headHash = input.headHash;
  }
  return ok(manifest);
}

/**
 * Returns the active round entry from `manifest` matching `currentRoundSeq`.
 */
export function getCurrentRound(manifest: TournamentManifest): RoundManifestEntry | null {
  return (
    manifest.rounds.find((round) => round.roundSeq === manifest.currentRoundSeq) ??
    manifest.rounds[manifest.rounds.length - 1] ??
    null
  );
}

/**
 * Parses and validates a round's `forms/<n>.<hash>.json` file.
 */
export function parseFormsFile(input: unknown): Result<FormsFile> {
  if (!isPlainObject(input)) {
    return err("$: forms file must be a JSON object");
  }
  const errors: string[] = [];
  if (!acceptsSchema(input.schema)) {
    errors.push("schema: unsupported or missing schema version");
  }
  if (!isNonEmptyString(input.roundId)) {
    errors.push("roundId: must be a non-empty string");
  }
  if (!isNonNegInt(input.roundSeq)) {
    errors.push("roundSeq: must be a non-negative integer");
  }
  if (!VALID_FORMATS.has(input.format as TournamentFormat)) {
    errors.push("format: unsupported tournament format");
  }
  if (input.stage !== "preliminary" && input.stage !== "elimination") {
    errors.push("stage: must be preliminary or elimination");
  }
  if (!isPlainObject(input.forms)) {
    errors.push("forms: must be an object keyed by formId");
  } else {
    for (const [formId, def] of Object.entries(input.forms)) {
      if (!isPlainObject(def) || typeof def.kind !== "string") {
        errors.push(`forms.${formId}: must be a form definition object`);
      } else if (def.kind !== "ballot" && def.kind !== "feedback" && def.kind !== "checkin") {
        errors.push(`forms.${formId}.kind: unsupported kind "${String(def.kind)}"`);
      }
    }
  }

  if (errors.length > 0) {
    return err(errors);
  }

  return ok({
    schema: input.schema as number,
    roundId: input.roundId as string,
    roundSeq: input.roundSeq as number,
    format: input.format as TournamentFormat,
    stage: input.stage as "preliminary" | "elimination",
    ...(isPlainObject(input.preferences)
      ? { preferences: input.preferences as Partial<TournamentPreferences> }
      : {}),
    forms: input.forms as Record<string, FormDefinition>,
  });
}

/**
 * Parses and validates a released `motions/<n>.json` file.
 */
export function parseMotionsFile(input: unknown): Result<MotionsFile> {
  if (!isPlainObject(input)) {
    return err("$: motions file must be a JSON object");
  }
  const errors: string[] = [];
  if (!acceptsSchema(input.schema)) {
    errors.push("schema: unsupported or missing schema version");
  }
  if (!isNonEmptyString(input.roundId)) {
    errors.push("roundId: must be a non-empty string");
  }
  if (!isNonNegInt(input.roundSeq)) {
    errors.push("roundSeq: must be a non-negative integer");
  }
  const motions: MotionItem[] = [];
  if (!Array.isArray(input.motions)) {
    errors.push("motions: must be an array");
  } else {
    for (let i = 0; i < input.motions.length; i++) {
      const item = input.motions[i];
      if (!isPlainObject(item) || !isNonEmptyString(item.id) || !isNonEmptyString(item.text)) {
        errors.push(`motions[${i}]: requires non-empty id and text`);
      } else {
        motions.push({
          id: item.id,
          text: item.text,
          ...(typeof item.infoSlide === "string" ? { infoSlide: item.infoSlide } : {}),
        });
      }
    }
  }

  if (errors.length > 0) {
    return err(errors);
  }

  return ok({
    schema: input.schema as number,
    roundId: input.roundId as string,
    roundSeq: input.roundSeq as number,
    motions,
  });
}
