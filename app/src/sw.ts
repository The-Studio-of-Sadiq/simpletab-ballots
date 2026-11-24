export const CACHE_NAME = "simpletab-ballots-shell-v1";

export const SHELL_ASSETS: readonly string[] = [
  "/",
  "/index.html",
  "/main.js",
  "/styles.css",
  "/manifest.webmanifest",
  "/icon.svg",
];

const SHELL_ASSET_SET = new Set<string>(SHELL_ASSETS);

/**
 * Determines whether a request belongs to the static app shell.
 * Never caches API endpoints (`/v1/*`, `/admin/*`), cross-origin CDN resources
 * (round bundles, forms, motions, manifest.json), or non-GET requests.
 */
export function shouldCacheRequest(request: Request, origin: string): boolean {
  if (request.method !== "GET") {
    return false;
  }
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return false;
  }
  if (url.origin !== origin) {
    return false;
  }
  if (
    url.pathname.startsWith("/v1/") ||
    url.pathname.startsWith("/admin/") ||
    url.pathname.startsWith("/rounds/") ||
    url.pathname.startsWith("/forms/") ||
    url.pathname.startsWith("/motions/") ||
    url.pathname === "/manifest.json"
  ) {
    return false;
  }
  if (url.pathname === "/t" || url.pathname.startsWith("/t/")) {
    return true;
  }
  return SHELL_ASSET_SET.has(url.pathname);
}

export async function handleInstall(
  cacheStorage: CacheStorage,
  cacheName = CACHE_NAME,
): Promise<void> {
  const cache = await cacheStorage.open(cacheName);
  await cache.addAll([...SHELL_ASSETS]);
}

export async function handleActivate(
  cacheStorage: CacheStorage,
  cacheName = CACHE_NAME,
): Promise<void> {
  const keys = await cacheStorage.keys();
  await Promise.all(
    keys
      .filter((key) => key !== cacheName)
      .map((key) => cacheStorage.delete(key)),
  );
}

export async function handleFetch(
  request: Request,
  origin: string,
  cacheStorage: CacheStorage,
  fetchImpl: typeof fetch = globalThis.fetch,
  cacheName = CACHE_NAME,
): Promise<Response> {
  if (!shouldCacheRequest(request, origin)) {
    return fetchImpl(request);
  }

  const url = new URL(request.url);
  const cacheKey =
    url.pathname === "/t" || url.pathname.startsWith("/t/")
      ? `${origin}/index.html`
      : request.url;

  const cache = await cacheStorage.open(cacheName);
  const cached = await cache.match(cacheKey);
  if (cached) {
    return cached;
  }

  const response = await fetchImpl(request);
  if (response.ok) {
    await cache.put(cacheKey, response.clone());
  }
  return response;
}

interface SwGlobal {
  location: { origin: string };
  caches: CacheStorage;
  skipWaiting?: () => Promise<void>;
  clients?: { claim: () => Promise<void> };
  addEventListener(type: string, listener: (event: unknown) => void): void;
}

function isServiceWorkerGlobal(g: unknown): g is SwGlobal {
  return (
    typeof g === "object" &&
    g !== null &&
    "skipWaiting" in g &&
    "caches" in g &&
    typeof (g as SwGlobal).addEventListener === "function" &&
    typeof document === "undefined"
  );
}

if (isServiceWorkerGlobal(globalThis)) {
  const sw: SwGlobal = globalThis as unknown as SwGlobal;
  sw.addEventListener("install", (rawEvent: unknown) => {
    const event = rawEvent as { waitUntil(promise: Promise<unknown>): void };
    event.waitUntil(
      handleInstall(sw.caches).then(() => sw.skipWaiting?.()),
    );
  });

  sw.addEventListener("activate", (rawEvent: unknown) => {
    const event = rawEvent as { waitUntil(promise: Promise<unknown>): void };
    event.waitUntil(
      handleActivate(sw.caches).then(() => sw.clients?.claim()),
    );
  });

  sw.addEventListener("fetch", (rawEvent: unknown) => {
    const event = rawEvent as {
      request: Request;
      respondWith(response: Promise<Response>): void;
    };
    event.respondWith(
      handleFetch(event.request, sw.location.origin, sw.caches),
    );
  });
}
