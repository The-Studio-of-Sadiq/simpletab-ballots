import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const appDir = path.join(rootDir, "app");
const distDir = path.join(appDir, "dist");
const coreSrcPath = path.resolve(rootDir, "../simpletab/packages/core/src");

fs.mkdirSync(distDir, { recursive: true });

await esbuild.build({
  entryPoints: [path.join(appDir, "src/main.ts")],
  outfile: path.join(distDir, "main.js"),
  bundle: true,
  minify: true,
  sourcemap: true,
  format: "esm",
  target: ["es2022", "chrome119", "safari16.5", "firefox115"],
  alias: {
    "@": coreSrcPath,
    "@simpletab/core": coreSrcPath,
  },
});

await esbuild.build({
  entryPoints: [path.join(appDir, "src/sw.ts")],
  outfile: path.join(distDir, "sw.js"),
  bundle: true,
  minify: true,
  sourcemap: true,
  format: "iife",
  target: ["es2022"],
  alias: {
    "@": coreSrcPath,
    "@simpletab/core": coreSrcPath,
  },
});

for (const asset of ["index.html", "styles.css", "manifest.webmanifest", "icon.svg"]) {
  fs.copyFileSync(path.join(appDir, asset), path.join(distDir, asset));
}

console.log("Built phone app to app/dist/");
