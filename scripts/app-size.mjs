import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.resolve(__dirname, "../app/dist");
const MAX_GZIP_BYTES = 102_400; // 100 KB

if (!fs.existsSync(distDir)) {
  console.error("app/dist does not exist. Run `npm run app:build` first.");
  process.exit(1);
}

const jsFiles = fs
  .readdirSync(distDir)
  .filter((name) => name.endsWith(".js"))
  .sort();

if (jsFiles.length === 0) {
  console.error("No .js files found in app/dist.");
  process.exit(1);
}

let totalRaw = 0;
let totalGzip = 0;

for (const file of jsFiles) {
  const buf = fs.readFileSync(path.join(distDir, file));
  const gz = zlib.gzipSync(buf, { level: 9 });
  totalRaw += buf.byteLength;
  totalGzip += gz.byteLength;
  console.log(
    `${file}: ${buf.byteLength} B raw, ${gz.byteLength} B gzipped (${(gz.byteLength / 1024).toFixed(2)} KB)`,
  );
}

console.log(
  `Total JS: ${totalRaw} B raw, ${totalGzip} B gzipped (${(totalGzip / 1024).toFixed(2)} KB / 100.00 KB budget)`,
);

if (totalGzip > MAX_GZIP_BYTES) {
  console.error(
    `FAIL: Gzipped JS size ${totalGzip} B exceeds 100 KB budget (${MAX_GZIP_BYTES} B).`,
  );
  process.exit(1);
}
