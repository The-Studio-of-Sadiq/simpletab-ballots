import { describe, expect, it } from "vitest";
import { createI18n, normalizeLocale } from "../src/i18n";
import {
  CACHE_NAME,
  handleFetch,
  handleInstall,
  shouldCacheRequest,
} from "../src/sw";

class FakeCache implements Cache {
  private readonly store = new Map<string, Response>();

  async add(request: RequestInfo | URL): Promise<void> {
    const key = typeof request === "string" ? request : request instanceof URL ? request.toString() : request.url;
    this.store.set(key, new Response("cached", { status: 200 }));
  }
  async addAll(requests: RequestInfo[]): Promise<void> {
    for (const r of requests) await this.add(r);
  }
  async delete(request: RequestInfo | URL): Promise<boolean> {
    const key = typeof request === "string" ? request : request instanceof URL ? request.toString() : request.url;
    return this.store.delete(key);
  }
  async keys(): Promise<readonly Request[]> {
    return Array.from(this.store.keys()).map((u) => new Request(`https://ballots.simpletab.org${u.startsWith("/") ? u : ""}`));
  }
  async match(request: RequestInfo | URL): Promise<Response | undefined> {
    const raw = typeof request === "string" ? request : request instanceof URL ? request.toString() : request.url;
    const direct = this.store.get(raw);
    if (direct) return direct.clone();
    try {
      const path = new URL(raw).pathname;
      const byPath = this.store.get(path);
      return byPath ? byPath.clone() : undefined;
    } catch {
      return undefined;
    }
  }
  async matchAll(): Promise<readonly Response[]> {
    return [];
  }
  async put(request: RequestInfo | URL, response: Response): Promise<void> {
    const key = typeof request === "string" ? request : request instanceof URL ? request.toString() : request.url;
    this.store.set(key, response.clone());
  }
}

class FakeCacheStorage implements CacheStorage {
  readonly caches = new Map<string, FakeCache>();
  async delete(cacheName: string): Promise<boolean> {
    return this.caches.delete(cacheName);
  }
  async has(cacheName: string): Promise<boolean> {
    return this.caches.has(cacheName);
  }
  async keys(): Promise<string[]> {
    return Array.from(this.caches.keys());
  }
  async match(request: RequestInfo | URL): Promise<Response | undefined> {
    for (const cache of this.caches.values()) {
      const hit = await cache.match(request);
      if (hit) return hit;
    }
    return undefined;
  }
  async open(cacheName: string): Promise<Cache> {
    let cache = this.caches.get(cacheName);
    if (!cache) {
      cache = new FakeCache();
      this.caches.set(cacheName, cache);
    }
    return cache;
  }
}

describe("i18n fallback and service worker shell caching", () => {
  it("formats ICU plurals and falls back to English for unsupported locales or unknown keys", () => {
    expect(normalizeLocale("fr-FR")).toBe("en");
    expect(normalizeLocale("bn-BD")).toBe("bn");

    const fr = createI18n("fr-FR");
    expect(fr.getLocale()).toBe("en");
    expect(
      fr.t("deadline.closesWithCountdown", {
        time: "2:00 PM",
        timeZone: "Asia/Dhaka",
        minutes: 1,
      }),
    ).toBe("Ballots close at 2:00 PM (Asia/Dhaka), 1 minute left");
    expect(
      fr.t("deadline.closesWithCountdown", {
        time: "2:00 PM",
        timeZone: "Asia/Dhaka",
        minutes: 5,
      }),
    ).toBe("Ballots close at 2:00 PM (Asia/Dhaka), 5 minutes left");

    // Unknown key safely returns key name.
    expect(fr.t("nonexistent.key")).toBe("nonexistent.key");

    const bn = createI18n("bn");
    expect(bn.getLocale()).toBe("bn");
    expect(bn.t("outbox.state.local_only")).toBe(
      "TODO: Saved on this phone only, don't leave",
    );
  });

  it("caches app shell assets and never caches /v1/*, /admin/*, or cross-origin CDN bundle files", async () => {
    const origin = "https://ballots.simpletab.org";
    const storage = new FakeCacheStorage();
    await handleInstall(storage, CACHE_NAME);

    expect(shouldCacheRequest(new Request(`${origin}/main.js`), origin)).toBe(true);
    expect(shouldCacheRequest(new Request(`${origin}/t/wudc-2027`), origin)).toBe(true);
    expect(shouldCacheRequest(new Request(`${origin}/v1/status?slug=x`), origin)).toBe(false);
    expect(shouldCacheRequest(new Request(`${origin}/v1/submit`, { method: "POST" }), origin)).toBe(false);
    expect(shouldCacheRequest(new Request(`${origin}/admin/usage`), origin)).toBe(false);
    expect(
      shouldCacheRequest(new Request("https://wudc2027.pages.dev/rounds/1/0.abc.bin"), origin),
    ).toBe(false);
    expect(
      shouldCacheRequest(new Request("https://wudc2027.pages.dev/manifest.json"), origin),
    ).toBe(false);

    let networkCalls = 0;
    const mockFetch = async (): Promise<Response> => {
      networkCalls += 1;
      return new Response("network", { status: 200 });
    };

    // Cached shell hit serves without network fetch.
    const shellRes = await handleFetch(
      new Request(`${origin}/main.js`),
      origin,
      storage,
      mockFetch,
      CACHE_NAME,
    );
    expect(await shellRes.text()).toBe("cached");
    expect(networkCalls).toBe(0);

    // API and CDN bundle calls bypass cache completely.
    const apiRes = await handleFetch(
      new Request(`${origin}/v1/status?slug=wudc`),
      origin,
      storage,
      mockFetch,
      CACHE_NAME,
    );
    expect(await apiRes.text()).toBe("network");
    expect(networkCalls).toBe(1);

    const cdnRes = await handleFetch(
      new Request("https://wudc2027.pages.dev/rounds/1/0.abc.bin"),
      origin,
      storage,
      mockFetch,
      CACHE_NAME,
    );
    expect(await cdnRes.text()).toBe("network");
    expect(networkCalls).toBe(2);
  });
});
