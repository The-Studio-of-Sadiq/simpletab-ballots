import {
  BundleFormatError,
  bucketForRowId,
  computeRowId,
  openRow,
  type RoundBundleRow,
} from "@simpletab/core/bundle";
import {
  deriveKeys,
  parseLink,
  type DerivedKeys,
  type LinkError,
  type ParsedLink,
} from "@simpletab/core/crypto";
import {
  parseFormsFile,
  parseManifest,
  parseMotionsFile,
  resolveCdnUrl,
  type FormsFile,
  type MotionsFile,
  type RoundManifestEntry,
  type TournamentManifest,
} from "./manifest";

export type OpenRoundResult =
  | { status: "ok"; keys: DerivedKeys; row: RoundBundleRow }
  | { status: "passcode_required" }
  | { status: "bucket_missing"; message: string };

/**
 * Parses a participant link from `window.location.href`.
 * In local dev (`http://localhost` / `http://127.0.0.1`), upgrades protocol to `https:`
 * solely for calling core's strict `parseLink` validator.
 */
export function parseParticipantUrl(
  href: string,
): { ok: true; value: ParsedLink } | { ok: false; error: LinkError | Error } {
  try {
    const url = new URL(href);
    const normalized =
      url.protocol === "http:" &&
      (url.hostname === "localhost" || url.hostname === "127.0.0.1")
        ? `https://${url.host}${url.pathname}${url.search}${url.hash}`
        : href;
    return parseLink(normalized);
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err : new Error("Invalid URL"),
    };
  }
}

export async function loadManifest(
  cdnHost: string,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<TournamentManifest> {
  const url = resolveCdnUrl(cdnHost, "manifest.json");
  const response = await fetchImpl(url, { method: "GET", cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Failed to fetch manifest.json (HTTP ${response.status})`);
  }
  const parsed = parseManifest(await response.json());
  if (!parsed.ok) {
    throw new Error(`Invalid manifest.json: ${parsed.errors.join("; ")}`);
  }
  return parsed.value;
}

export async function openParticipantRound(params: {
  link: ParsedLink;
  round: RoundManifestEntry;
  passcode?: string;
  fetchImpl?: typeof fetch;
}): Promise<OpenRoundResult> {
  const fetchImpl = params.fetchImpl ?? globalThis.fetch;
  const keys = await deriveKeys(
    params.link.secret,
    params.link.slug,
    params.passcode,
  );
  const rowId = await computeRowId(keys.lookupKey, params.round.roundId);
  const bucketIndex = bucketForRowId(rowId);
  const bucketPath = params.round.buckets[String(bucketIndex)];
  if (!bucketPath) {
    return {
      status: "bucket_missing",
      message: `Bucket ${bucketIndex} missing from round manifest`,
    };
  }

  const bucketUrl = resolveCdnUrl(params.link.cdnHost, bucketPath);
  const response = await fetchImpl(bucketUrl, { method: "GET" });
  if (!response.ok) {
    return {
      status: "bucket_missing",
      message: `Failed to fetch round bucket (HTTP ${response.status})`,
    };
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  try {
    const row = await openRow(
      bytes,
      { fileKey: keys.fileKey, lookupKey: keys.lookupKey },
      params.round.roundId,
    );
    if (row === null) {
      return { status: "passcode_required" };
    }
    return { status: "ok", keys, row };
  } catch (err) {
    if (err instanceof BundleFormatError && err.code === "DECRYPTION_FAILED") {
      return { status: "passcode_required" };
    }
    throw err;
  }
}

export async function loadForms(
  cdnHost: string,
  formsFile: string,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<FormsFile> {
  const url = resolveCdnUrl(cdnHost, formsFile);
  const response = await fetchImpl(url, { method: "GET" });
  if (!response.ok) {
    throw new Error(`Failed to fetch forms file (HTTP ${response.status})`);
  }
  const parsed = parseFormsFile(await response.json());
  if (!parsed.ok) {
    throw new Error(`Invalid forms file: ${parsed.errors.join("; ")}`);
  }
  return parsed.value;
}

export async function loadMotions(
  cdnHost: string,
  motionsFile: string,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<MotionsFile> {
  const url = resolveCdnUrl(cdnHost, motionsFile);
  const response = await fetchImpl(url, { method: "GET", cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Failed to fetch motions file (HTTP ${response.status})`);
  }
  const parsed = parseMotionsFile(await response.json());
  if (!parsed.ok) {
    throw new Error(`Invalid motions file: ${parsed.errors.join("; ")}`);
  }
  return parsed.value;
}
