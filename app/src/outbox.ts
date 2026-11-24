import {
  base64UrlEncode,
  proof,
  type DerivedKeys,
} from "@simpletab/core/crypto";
import {
  SCHEMA_VERSION,
  parseErrorBody,
  parseStatusResponse,
  type ErrorCode,
  type Submission,
} from "@simpletab/core/wire";
import type { TranslateFn } from "./i18n";
import type { BallotCollectionMode } from "./manifest";
import { generateUlid } from "./ulid";

export type OutboxState =
  | "local_only"
  | "received_by_server"
  | "received_by_tab_room";

export interface OutboxRecord {
  submissionId: string;
  slug: string;
  roundId: string;
  lookupId: string;
  formId: string;
  type: "ballot" | "feedback" | "checkin";
  payload: Record<string, unknown>;
  state: OutboxState;
  createdAt: number;
  attempts: number;
  nextRetryAt: number | null;
  lastErrorCode?: ErrorCode;
  lastErrorMessage?: string;
  serverReceivedAt?: string;
}

export interface DraftRecord {
  key: string;
  slug: string;
  roundId: string;
  lookupId: string;
  formId: string;
  data: unknown;
  updatedAt: number;
}

export type SendOutcome =
  | { outcome: "received"; record: OutboxRecord }
  | { outcome: "quota_exhausted"; record: OutboxRecord; retryAfterSeconds?: number }
  | {
      outcome: "deadline_passed";
      record: OutboxRecord;
      deadline?: string;
      timeZone?: string;
    }
  | { outcome: "rejected"; record: OutboxRecord; code: ErrorCode; message: string }
  | { outcome: "retry_later"; record: OutboxRecord }
  | { outcome: "qr_only"; record: OutboxRecord };

const DB_NAME = "simpletab-ballots-app";
const DB_VERSION = 1;
const STORE_OUTBOX = "outbox";
const STORE_DRAFTS = "drafts";

const TERMINAL_CLIENT_ERRORS = new Set<ErrorCode>([
  "AUTH_INVALID",
  "KEY_REVOKED",
  "ROUND_CLOSED",
  "FORM_NOT_ALLOWED",
  "SCHEMA_INVALID",
  "SCHEMA_UNSUPPORTED",
  "NOT_FOUND",
]);

export function draftStorageKey(
  slug: string,
  roundId: string,
  lookupId: string,
  formId: string,
): string {
  return `${slug}:${roundId}:${lookupId}:${formId}`;
}

export function statusTextForState(state: OutboxState, t: TranslateFn): string {
  return t(`outbox.state.${state}`);
}

export function nextBackoffMs(attempts: number): number {
  return Math.min(60_000, 2_000 * 2 ** Math.min(Math.max(0, attempts - 1), 5));
}

function openOutboxDatabase(idbFactory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = idbFactory.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_OUTBOX)) {
        const store = db.createObjectStore(STORE_OUTBOX, {
          keyPath: "submissionId",
        });
        store.createIndex("byScope", ["slug", "lookupId"], { unique: false });
      }
      if (!db.objectStoreNames.contains(STORE_DRAFTS)) {
        db.createObjectStore(STORE_DRAFTS, { keyPath: "key" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Failed to open IndexedDB"));
  });
}

function idbRequest<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB request failed"));
  });
}

export interface OutboxOptions {
  idb?: IDBFactory;
  now?: () => number;
}

export class OutboxManager {
  private readonly idb: IDBFactory;
  private readonly now: () => number;
  private dbPromise: Promise<IDBDatabase> | null = null;

  constructor(options: OutboxOptions = {}) {
    this.idb = options.idb ?? globalThis.indexedDB;
    this.now = options.now ?? Date.now;
  }

  private getDb(): Promise<IDBDatabase> {
    if (!this.dbPromise) {
      this.dbPromise = openOutboxDatabase(this.idb);
    }
    return this.dbPromise;
  }

  async close(): Promise<void> {
    if (this.dbPromise) {
      const db = await this.dbPromise;
      db.close();
      this.dbPromise = null;
    }
  }

  async saveDraft(
    slug: string,
    roundId: string,
    lookupId: string,
    formId: string,
    data: unknown,
  ): Promise<void> {
    const db = await this.getDb();
    const tx = db.transaction(STORE_DRAFTS, "readwrite");
    const record: DraftRecord = {
      key: draftStorageKey(slug, roundId, lookupId, formId),
      slug,
      roundId,
      lookupId,
      formId,
      data,
      updatedAt: this.now(),
    };
    await idbRequest(tx.objectStore(STORE_DRAFTS).put(record));
  }

  async loadDraft<T>(
    slug: string,
    roundId: string,
    lookupId: string,
    formId: string,
  ): Promise<T | null> {
    const db = await this.getDb();
    const tx = db.transaction(STORE_DRAFTS, "readonly");
    const result = (await idbRequest(
      tx.objectStore(STORE_DRAFTS).get(draftStorageKey(slug, roundId, lookupId, formId)),
    )) as DraftRecord | undefined;
    return result ? (result.data as T) : null;
  }

  async clearDraft(
    slug: string,
    roundId: string,
    lookupId: string,
    formId: string,
  ): Promise<void> {
    const db = await this.getDb();
    const tx = db.transaction(STORE_DRAFTS, "readwrite");
    await idbRequest(
      tx.objectStore(STORE_DRAFTS).delete(draftStorageKey(slug, roundId, lookupId, formId)),
    );
  }

  async get(submissionId: string): Promise<OutboxRecord | null> {
    const db = await this.getDb();
    const tx = db.transaction(STORE_OUTBOX, "readonly");
    const rec = (await idbRequest(tx.objectStore(STORE_OUTBOX).get(submissionId))) as
      | OutboxRecord
      | undefined;
    return rec ?? null;
  }

  async put(record: OutboxRecord): Promise<void> {
    const db = await this.getDb();
    const tx = db.transaction(STORE_OUTBOX, "readwrite");
    await idbRequest(tx.objectStore(STORE_OUTBOX).put(record));
  }

  async listByScope(slug: string, lookupId: string): Promise<OutboxRecord[]> {
    const db = await this.getDb();
    const tx = db.transaction(STORE_OUTBOX, "readonly");
    const store = tx.objectStore(STORE_OUTBOX);
    const index = store.index("byScope");
    const records = (await idbRequest(
      index.getAll(IDBKeyRange.only([slug, lookupId])),
    )) as OutboxRecord[];
    return records.sort((a, b) => b.createdAt - a.createdAt);
  }

  async enqueue(input: {
    slug: string;
    roundId: string;
    lookupId: string;
    formId: string;
    type: "ballot" | "feedback" | "checkin";
    payload: Record<string, unknown>;
  }): Promise<OutboxRecord> {
    const nowMs = this.now();
    const record: OutboxRecord = {
      submissionId: generateUlid(nowMs),
      slug: input.slug,
      roundId: input.roundId,
      lookupId: input.lookupId,
      formId: input.formId,
      type: input.type,
      payload: input.payload,
      state: "local_only",
      createdAt: nowMs,
      attempts: 0,
      nextRetryAt: nowMs,
    };
    await this.put(record);
    return record;
  }

  async sendSubmission(
    submissionId: string,
    keys: Pick<DerivedKeys, "authKey">,
    apiOrigin: string,
    mode: BallotCollectionMode,
    fetchImpl: typeof fetch = globalThis.fetch,
  ): Promise<SendOutcome> {
    const record = await this.get(submissionId);
    if (!record) {
      throw new Error(`Outbox record not found: ${submissionId}`);
    }
    if (record.state !== "local_only") {
      return { outcome: "received", record };
    }
    if (mode === "qr_only") {
      return { outcome: "qr_only", record };
    }

    const body: Submission = {
      schema: SCHEMA_VERSION,
      slug: record.slug,
      submissionId: record.submissionId,
      type: record.type,
      roundId: record.roundId,
      lookupId: record.lookupId,
      authKey: base64UrlEncode(keys.authKey),
      proof: await proof(keys.authKey, record.submissionId, record.payload),
      payload: record.payload,
    };

    let response: Response;
    try {
      response = await fetchImpl(`${apiOrigin.replace(/\/+$/, "")}/v1/submit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (err) {
      const updated: OutboxRecord = {
        ...record,
        attempts: record.attempts + 1,
        nextRetryAt: this.now() + nextBackoffMs(record.attempts + 1),
        lastErrorMessage: err instanceof Error ? err.message : "Network error",
      };
      await this.put(updated);
      return { outcome: "retry_later", record: updated };
    }

    let jsonBody: unknown = null;
    try {
      jsonBody = await response.json();
    } catch {
      jsonBody = null;
    }

    if (response.status === 200 && jsonBody && typeof jsonBody === "object") {
      const status = (jsonBody as { status?: unknown }).status;
      if (status === "received" || status === "already_received") {
        const receivedAt = (jsonBody as { receivedAt?: unknown }).receivedAt;
        const updated: OutboxRecord = {
          ...record,
          state: "received_by_server",
          nextRetryAt: null,
          lastErrorCode: undefined,
          lastErrorMessage: undefined,
          ...(typeof receivedAt === "string" ? { serverReceivedAt: receivedAt } : {}),
        };
        await this.put(updated);
        return { outcome: "received", record: updated };
      }
    }

    const parsedErr = parseErrorBody(jsonBody);
    if (parsedErr.ok) {
      const errBody = parsedErr.value;
      if (errBody.code === "QUOTA_EXHAUSTED") {
        const updated: OutboxRecord = {
          ...record,
          attempts: record.attempts + 1,
          nextRetryAt: null,
          lastErrorCode: "QUOTA_EXHAUSTED",
          lastErrorMessage: errBody.message,
        };
        await this.put(updated);
        return {
          outcome: "quota_exhausted",
          record: updated,
          retryAfterSeconds: errBody.retryAfterSeconds,
        };
      }
      if (errBody.code === "DEADLINE_PASSED") {
        const updated: OutboxRecord = {
          ...record,
          attempts: record.attempts + 1,
          nextRetryAt: null,
          lastErrorCode: "DEADLINE_PASSED",
          lastErrorMessage: errBody.message,
        };
        await this.put(updated);
        return {
          outcome: "deadline_passed",
          record: updated,
          deadline: errBody.deadline,
          timeZone: errBody.timeZone,
        };
      }
      if (TERMINAL_CLIENT_ERRORS.has(errBody.code)) {
        const updated: OutboxRecord = {
          ...record,
          attempts: record.attempts + 1,
          nextRetryAt: null,
          lastErrorCode: errBody.code,
          lastErrorMessage: errBody.message,
        };
        await this.put(updated);
        return {
          outcome: "rejected",
          record: updated,
          code: errBody.code,
          message: errBody.message,
        };
      }
    }

    const updated: OutboxRecord = {
      ...record,
      attempts: record.attempts + 1,
      nextRetryAt: this.now() + nextBackoffMs(record.attempts + 1),
      lastErrorCode: parsedErr.ok ? parsedErr.value.code : undefined,
      lastErrorMessage: parsedErr.ok
        ? parsedErr.value.message
        : `HTTP ${response.status}`,
    };
    await this.put(updated);
    return { outcome: "retry_later", record: updated };
  }

  async retryPending(params: {
    slug: string;
    lookupId: string;
    keys: Pick<DerivedKeys, "authKey">;
    apiOrigin: string;
    mode: BallotCollectionMode;
    fetchImpl?: typeof fetch;
  }): Promise<SendOutcome[]> {
    if (params.mode === "qr_only") {
      return [];
    }
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      return [];
    }
    const nowMs = this.now();
    const records = await this.listByScope(params.slug, params.lookupId);
    const due = records.filter(
      (rec) =>
        rec.state === "local_only" &&
        rec.nextRetryAt !== null &&
        rec.nextRetryAt <= nowMs,
    );
    const outcomes: SendOutcome[] = [];
    for (const rec of due) {
      const outcome = await this.sendSubmission(
        rec.submissionId,
        params.keys,
        params.apiOrigin,
        params.mode,
        params.fetchImpl,
      );
      outcomes.push(outcome);
    }
    return outcomes;
  }

  async refreshStatus(params: {
    slug: string;
    lookupId: string;
    apiOrigin: string;
    mode: BallotCollectionMode;
    fetchImpl?: typeof fetch;
  }): Promise<OutboxRecord[]> {
    const records = await this.listByScope(params.slug, params.lookupId);
    if (params.mode === "qr_only") {
      return records;
    }

    const pendingAck = records
      .filter((rec) => rec.state !== "received_by_tab_room")
      .slice(0, 100);
    if (pendingAck.length === 0) {
      return records;
    }

    const fetchImpl = params.fetchImpl ?? globalThis.fetch;
    const idsParam = pendingAck.map((rec) => rec.submissionId).join(",");
    const url = `${params.apiOrigin.replace(/\/+$/, "")}/v1/status?slug=${encodeURIComponent(params.slug)}&lookupId=${encodeURIComponent(params.lookupId)}&ids=${encodeURIComponent(idsParam)}`;
    const response = await fetchImpl(url, { method: "GET", cache: "no-store" });
    if (!response.ok) {
      return records;
    }

    const parsed = parseStatusResponse(await response.json());
    if (!parsed.ok) {
      return records;
    }

    const byId = new Map(records.map((rec) => [rec.submissionId, rec]));
    for (const item of parsed.value.items) {
      const existing = byId.get(item.submissionId);
      if (!existing) continue;
      let nextState: OutboxState = existing.state;
      if (item.tabRoom) {
        nextState = "received_by_tab_room";
      } else if (item.server && existing.state === "local_only") {
        nextState = "received_by_server";
      }
      if (nextState !== existing.state) {
        const updated: OutboxRecord = {
          ...existing,
          state: nextState,
          nextRetryAt: null,
        };
        await this.put(updated);
        byId.set(item.submissionId, updated);
      }
    }

    return Array.from(byId.values()).sort((a, b) => b.createdAt - a.createdAt);
  }
}
