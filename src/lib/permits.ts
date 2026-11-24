import {
  parsePermitUpload,
  type PermitEntry,
  type PermitUpload,
} from "@simpletab/core/wire";

export interface LoadedPermit {
  permit: PermitUpload;
  entriesByLookupId: ReadonlyMap<string, PermitEntry>;
}

interface PermitRow {
  version: number;
  open: number;
  body: string;
}

const MAX_PERMIT_CACHE_ENTRIES = 128;
const permitCache = new Map<string, LoadedPermit>();

function cacheKey(slug: string, roundId: string, version: number): string {
  return `${slug}\0${roundId}\0${version}`;
}

function buildLoadedPermit(permit: PermitUpload): LoadedPermit {
  const entriesByLookupId = new Map<string, PermitEntry>();
  for (const entry of permit.entries) {
    entriesByLookupId.set(entry.lookupId, entry);
  }
  return { permit, entriesByLookupId };
}

function setCachedPermit(slug: string, permit: PermitUpload, loaded: LoadedPermit): void {
  const roundPrefix = `${slug}\0${permit.roundId}\0`;
  for (const existingKey of permitCache.keys()) {
    if (existingKey.startsWith(roundPrefix)) {
      permitCache.delete(existingKey);
    }
  }

  if (permitCache.size >= MAX_PERMIT_CACHE_ENTRIES) {
    const oldestKey = permitCache.keys().next().value;
    if (oldestKey !== undefined) {
      permitCache.delete(oldestKey);
    }
  }

  permitCache.set(cacheKey(slug, permit.roundId, permit.version), loaded);
}

export function cacheRoundPermit(slug: string, permit: PermitUpload): LoadedPermit {
  const loaded = buildLoadedPermit(permit);
  setCachedPermit(slug, permit, loaded);
  return loaded;
}

export async function loadRoundPermit(
  db: D1Database,
  slug: string,
  roundId: string,
): Promise<LoadedPermit | null> {
  const row = await db
    .prepare(
      `SELECT version, open, body
       FROM permits
       WHERE slug = ? AND round_id = ?`,
    )
    .bind(slug, roundId)
    .first<PermitRow>();

  if (!row) {
    return null;
  }

  const key = cacheKey(slug, roundId, row.version);
  const cached = permitCache.get(key);
  if (cached) {
    // Refresh LRU order and ensure open flag reflects the row.
    permitCache.delete(key);
    const synced: LoadedPermit =
      cached.permit.open === (row.open === 1)
        ? cached
        : {
            permit: { ...cached.permit, open: row.open === 1 },
            entriesByLookupId: cached.entriesByLookupId,
          };
    permitCache.set(key, synced);
    return synced;
  }

  let rawJson: unknown;
  try {
    rawJson = JSON.parse(row.body);
  } catch {
    return null;
  }

  const parsed = parsePermitUpload(rawJson);
  if (!parsed.ok) {
    return null;
  }

  const permit: PermitUpload = {
    ...parsed.value,
    open: row.open === 1,
    version: row.version,
  };
  const loaded = buildLoadedPermit(permit);
  setCachedPermit(slug, permit, loaded);
  return loaded;
}

export function clearPermitCache(): void {
  permitCache.clear();
}
