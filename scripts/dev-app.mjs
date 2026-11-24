import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.resolve(__dirname, "../app/dist");
const port = Number(process.env.PORT ?? 8788);

execFileSync(process.execPath, [path.join(__dirname, "build-app.mjs")], {
  stdio: "inherit",
});

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".map": "application/json; charset=utf-8",
};

const server = http.createServer((req, res) => {
  const reqUrl = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
  let rel = reqUrl.pathname === "/" ? "/index.html" : reqUrl.pathname;
  if (rel.startsWith("/t/")) {
    rel = "/index.html";
  }
  const safePath = path.normalize(rel).replace(/^(\.\.[/\\])+/, "");
  const fullPath = path.join(distDir, safePath);
  const target = fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()
    ? fullPath
    : path.join(distDir, "index.html");
  const ext = path.extname(target);
  res.writeHead(200, { "Content-Type": MIME[ext] ?? "application/octet-stream" });
  fs.createReadStream(target).pipe(res);
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Phone app dev server listening on http://127.0.0.1:${port}`);
});
