import "fake-indexeddb/auto";
import { webcrypto } from "node:crypto";
import { CompressionStream, DecompressionStream } from "node:stream/web";

if (!globalThis.crypto || !globalThis.crypto.subtle) {
  Object.defineProperty(globalThis, "crypto", {
    value: webcrypto,
    configurable: true,
  });
}

if (typeof window !== "undefined" && (!window.crypto || !window.crypto.subtle)) {
  Object.defineProperty(window, "crypto", {
    value: globalThis.crypto,
    configurable: true,
  });
}

if (typeof globalThis.CompressionStream === "undefined") {
  Object.defineProperty(globalThis, "CompressionStream", {
    value: CompressionStream,
    configurable: true,
  });
}

if (typeof globalThis.DecompressionStream === "undefined") {
  Object.defineProperty(globalThis, "DecompressionStream", {
    value: DecompressionStream,
    configurable: true,
  });
}
