import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import type { Clock, Env, RateLimiterBinding } from "../../src/env";
import { handleRequest } from "../../src/worker";

export interface DbCounts {
  rowsRead: number;
  rowsWritten: number;
  queries: number;
}

export interface SqlCategoryCounts {
  usageFlushQueries: number;
  usageFlushWrites: number;
  usageFlushReads: number;
  inboxScanQueries: number;
  inboxScanReads: number;
  hostAuthQueries: number;
  hostAuthReads: number;
  hostClaimWrites: number;
}

export interface CountingD1 {
  readonly db: D1Database;
  readonly counts: DbCounts;
  readonly categories: SqlCategoryCounts;
  snapshot(): DbCounts;
  diff(before: DbCounts): DbCounts;
  reset(): void;
}

const unwrappedStatements = new WeakMap<D1PreparedStatement, D1PreparedStatement>();

type MetaRecorder = (sql: string, meta: D1Meta | undefined) => void;

class CountingPreparedStatement implements D1PreparedStatement {
  private readonly sql: string;
  private readonly inner: D1PreparedStatement;
  private readonly recordMeta: MetaRecorder;

  constructor(
    sql: string,
    inner: D1PreparedStatement,
    recordMeta: MetaRecorder,
  ) {
    this.sql = sql;
    this.inner = inner;
    this.recordMeta = recordMeta;
    unwrappedStatements.set(this, inner);
  }

  getSql(): string {
    return this.sql;
  }

  bind(...values: unknown[]): D1PreparedStatement {
    return new CountingPreparedStatement(
      this.sql,
      this.inner.bind(...values),
      this.recordMeta,
    );
  }

  async first<T = unknown>(colName: string): Promise<T | null>;
  async first<T = Record<string, unknown>>(): Promise<T | null>;
  async first<T = Record<string, unknown>>(colName?: string): Promise<T | null> {
    const result = await this.inner.all<Record<string, unknown>>();
    this.recordMeta(this.sql, result.meta);
    if (result.results.length === 0) {
      return null;
    }
    const row = result.results[0];
    if (colName !== undefined) {
      if (!Object.prototype.hasOwnProperty.call(row, colName)) {
        throw new Error(`D1_COLUMN_NOTFOUND: Column not found: ${colName}`);
      }
      return row[colName] as T;
    }
    return row as T;
  }

  async run<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    const result = await this.inner.run<T>();
    this.recordMeta(this.sql, result.meta);
    return result;
  }

  async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    const result = await this.inner.all<T>();
    this.recordMeta(this.sql, result.meta);
    return result;
  }

  async raw<T = unknown[]>(options: {
    columnNames: true;
  }): Promise<[string[], ...T[]]>;
  async raw<T = unknown[]>(options?: { columnNames?: false }): Promise<T[]>;
  async raw<T = unknown[]>(options?: {
    columnNames?: boolean;
  }): Promise<T[] | [string[], ...T[]]> {
    const result = await this.inner.all<Record<string, unknown>>();
    this.recordMeta(this.sql, result.meta);
    const rows = result.results;
    const colNames = rows.length > 0 ? Object.keys(rows[0]) : [];
    const dataRows = rows.map(
      (row) => colNames.map((col) => row[col]) as unknown as T,
    );
    if (options?.columnNames) {
      return [colNames, ...dataRows];
    }
    return dataRows;
  }
}

function emptyCategories(): SqlCategoryCounts {
  return {
    usageFlushQueries: 0,
    usageFlushWrites: 0,
    usageFlushReads: 0,
    inboxScanQueries: 0,
    inboxScanReads: 0,
    hostAuthQueries: 0,
    hostAuthReads: 0,
    hostClaimWrites: 0,
  };
}

export function createCountingDatabase(inner: D1Database): CountingD1 {
  const counts: DbCounts = {
    rowsRead: 0,
    rowsWritten: 0,
    queries: 0,
  };
  const categories: SqlCategoryCounts = emptyCategories();

  const recordMeta: MetaRecorder = (sql: string, meta: D1Meta | undefined): void => {
    counts.queries += 1;
    const read =
      meta && typeof meta.rows_read === "number" && Number.isFinite(meta.rows_read)
        ? meta.rows_read
        : 0;
    const written =
      meta && typeof meta.rows_written === "number" && Number.isFinite(meta.rows_written)
        ? meta.rows_written
        : 0;

    counts.rowsRead += read;
    counts.rowsWritten += written;

    const normalized = sql.replace(/\s+/g, " ").trim().toUpperCase();
    if (normalized.startsWith("INSERT INTO USAGE")) {
      categories.usageFlushQueries += 1;
      categories.usageFlushWrites += written;
      categories.usageFlushReads += read;
    } else if (
      normalized.startsWith("SELECT ROWID, SUBMISSION_ID") &&
      normalized.includes("FROM SUBMISSIONS WHERE ROWID >")
    ) {
      categories.inboxScanQueries += 1;
      categories.inboxScanReads += read;
    } else if (
      normalized.startsWith("SELECT SLUG, KEY_HASH") &&
      normalized.includes("WHERE KEY_HASH =")
    ) {
      categories.hostAuthQueries += 1;
      categories.hostAuthReads += read;
    } else if (
      normalized.startsWith("UPDATE TOURNAMENTS SET HOST_NUMBER")
    ) {
      categories.hostClaimWrites += written;
    }
  };

  const unwrap = (stmt: D1PreparedStatement): D1PreparedStatement =>
    unwrappedStatements.get(stmt) ?? stmt;

  const sqlOf = (stmt: D1PreparedStatement): string =>
    stmt instanceof CountingPreparedStatement ? stmt.getSql() : "";

  const db: D1Database = {
    prepare(query: string): D1PreparedStatement {
      return new CountingPreparedStatement(query, inner.prepare(query), recordMeta);
    },

    async batch<T = unknown>(
      statements: D1PreparedStatement[],
    ): Promise<D1Result<T>[]> {
      const unwrapped = statements.map(unwrap);
      const results = await inner.batch<T>(unwrapped);
      for (let i = 0; i < results.length; i++) {
        recordMeta(sqlOf(statements[i]), results[i].meta);
      }
      return results;
    },

    exec(query: string): Promise<D1ExecResult> {
      counts.queries += 1;
      return inner.exec(query);
    },

    withSession(
      constraintOrBookmark?: D1SessionBookmark | D1SessionConstraint,
    ): D1DatabaseSession {
      const session = inner.withSession(constraintOrBookmark);
      return {
        prepare(query: string): D1PreparedStatement {
          return new CountingPreparedStatement(
            query,
            session.prepare(query),
            recordMeta,
          );
        },
        async batch<T = unknown>(
          statements: D1PreparedStatement[],
        ): Promise<D1Result<T>[]> {
          const unwrapped = statements.map(unwrap);
          const results = await session.batch<T>(unwrapped);
          for (let i = 0; i < results.length; i++) {
            recordMeta(sqlOf(statements[i]), results[i].meta);
          }
          return results;
        },
        getBookmark(): D1SessionBookmark | null {
          return session.getBookmark();
        },
      };
    },

    dump(): Promise<ArrayBuffer> {
      return inner.dump();
    },
  };

  return {
    db,
    counts,
    categories,
    snapshot(): DbCounts {
      return {
        rowsRead: counts.rowsRead,
        rowsWritten: counts.rowsWritten,
        queries: counts.queries,
      };
    },
    diff(before: DbCounts): DbCounts {
      return {
        rowsRead: counts.rowsRead - before.rowsRead,
        rowsWritten: counts.rowsWritten - before.rowsWritten,
        queries: counts.queries - before.queries,
      };
    },
    reset(): void {
      counts.rowsRead = 0;
      counts.rowsWritten = 0;
      counts.queries = 0;
      Object.assign(categories, emptyCategories());
    },
  };
}

/**
 * In-memory fixed-window rate limiter matching wrangler.toml's simple limit/period
 * rules, driven by the simulated clock so fast replays do not trip wall-clock limits
 * while still verifying that realistic simulated traffic stays within rate limits.
 */
export function createSimulatedRateLimiter(
  limit: number,
  periodSeconds: number,
  now: Clock,
): RateLimiterBinding {
  const periodMs = periodSeconds * 1000;
  const windows = new Map<string, { windowId: number; count: number }>();

  return {
    async limit(options: { key: string }): Promise<{ success: boolean }> {
      const windowId = Math.floor(now() / periodMs);
      const existing = windows.get(options.key);
      if (!existing || existing.windowId !== windowId) {
        windows.set(options.key, { windowId, count: 1 });
        return { success: true };
      }
      if (existing.count >= limit) {
        return { success: false };
      }
      existing.count += 1;
      return { success: true };
    },
  };
}

export interface RouteMetrics {
  requests: number;
  rowsRead: number;
  rowsWritten: number;
  queries: number;
}

export interface BudgetHarness {
  readonly env: Env;
  readonly db: CountingD1;
  readonly routes: Map<string, RouteMetrics>;
  nowMs: number;
  fetch(
    input: string,
    init?: RequestInit,
    routeLabel?: string,
  ): Promise<{ response: Response; delta: DbCounts }>;
  totalRequests(): number;
  resetCounters(): void;
}

export function createBudgetHarness(baseEnv: Env, startMs: number): BudgetHarness {
  const countingDb = createCountingDatabase(baseEnv.DB);
  let currentMs = startMs;
  const clock: Clock = () => currentMs;

  const wrappedEnv: Env = {
    ...baseEnv,
    DB: countingDb.db,
    RL_LINK: createSimulatedRateLimiter(10, 60, clock),
    RL_IP: createSimulatedRateLimiter(20, 60, clock),
  };

  const routes = new Map<string, RouteMetrics>();

  const recordRoute = (label: string, delta: DbCounts): void => {
    let entry = routes.get(label);
    if (!entry) {
      entry = { requests: 0, rowsRead: 0, rowsWritten: 0, queries: 0 };
      routes.set(label, entry);
    }
    entry.requests += 1;
    entry.rowsRead += delta.rowsRead;
    entry.rowsWritten += delta.rowsWritten;
    entry.queries += delta.queries;
  };

  return {
    env: wrappedEnv,
    db: countingDb,
    routes,
    get nowMs(): number {
      return currentMs;
    },
    set nowMs(value: number) {
      currentMs = value;
    },
    async fetch(
      input: string,
      init?: RequestInit,
      routeLabel?: string,
    ): Promise<{ response: Response; delta: DbCounts }> {
      const request = new Request(input, init);
      const label =
        routeLabel ?? `${request.method} ${new URL(request.url).pathname}`;
      const before = countingDb.snapshot();
      const ctx = createExecutionContext();
      const response = await handleRequest(request, wrappedEnv, ctx, clock);
      await waitOnExecutionContext(ctx);
      const delta = countingDb.diff(before);
      recordRoute(label, delta);
      return { response, delta };
    },
    totalRequests(): number {
      let sum = 0;
      for (const entry of routes.values()) {
        sum += entry.requests;
      }
      return sum;
    },
    resetCounters(): void {
      countingDb.reset();
      routes.clear();
    },
  };
}
