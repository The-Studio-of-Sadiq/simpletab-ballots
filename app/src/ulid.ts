const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

let lastTimestamp = -1;
const lastRandom = new Uint8Array(10);

function encodeTime(ms: number): string {
  let value = Math.max(0, Math.floor(ms));
  const chars = new Array<string>(10);
  for (let i = 9; i >= 0; i--) {
    chars[i] = CROCKFORD[value % 32];
    value = Math.floor(value / 32);
  }
  return chars.join("");
}

function incrementRandomBytes(bytes: Uint8Array): boolean {
  for (let i = bytes.length - 1; i >= 0; i--) {
    if (bytes[i] < 255) {
      bytes[i] += 1;
      return true;
    }
    bytes[i] = 0;
  }
  return false;
}

function encodeRandom80(bytes: Uint8Array): string {
  // 80 bits -> 16 Crockford base32 characters (5 bits per char).
  const out = new Array<string>(16);
  let bitBuffer = 0;
  let bitCount = 0;
  let outIndex = 0;

  for (let i = 0; i < bytes.length; i++) {
    bitBuffer = (bitBuffer << 8) | bytes[i];
    bitCount += 8;
    while (bitCount >= 5) {
      bitCount -= 5;
      out[outIndex++] = CROCKFORD[(bitBuffer >> bitCount) & 31];
    }
  }
  return out.join("");
}

/**
 * Generates a monotonic 26-character Crockford Base32 ULID matching
 * `/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/`.
 */
export function generateUlid(nowMs = Date.now()): string {
  const ts = Math.max(0, Math.floor(nowMs));
  if (ts === lastTimestamp) {
    if (!incrementRandomBytes(lastRandom)) {
      globalThis.crypto.getRandomValues(lastRandom);
    }
  } else {
    lastTimestamp = ts;
    globalThis.crypto.getRandomValues(lastRandom);
  }
  return `${encodeTime(ts)}${encodeRandom80(lastRandom)}`;
}
