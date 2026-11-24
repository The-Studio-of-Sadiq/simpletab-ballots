import path from "node:path";
import { fileURLToPath } from "node:url";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const coreSrcPath = path.resolve(__dirname, "../simpletab/packages/core/src");

export default defineConfig(async () => {
  const migrations = await readD1Migrations(path.resolve(__dirname, "migrations"));

  return {
    test: {
      projects: [
        {
          resolve: {
            alias: {
              "@": coreSrcPath,
              "@simpletab/core": coreSrcPath,
            },
          },
          plugins: [
            cloudflareTest({
              wrangler: {
                configPath: "./wrangler.toml",
              },
              miniflare: {
                compatibilityDate: "2026-08-22",
                bindings: {
                  TEST_MIGRATIONS: migrations,
                },
              },
            }),
          ],
          test: {
            name: "worker",
            include: ["test/**/*.test.ts"],
          },
        },
        {
          resolve: {
            alias: {
              "@": coreSrcPath,
              "@simpletab/core": coreSrcPath,
            },
          },
          test: {
            name: "app",
            environment: "jsdom",
            setupFiles: ["app/test/setup.ts"],
            include: ["app/test/**/*.test.ts"],
          },
        },
      ],
    },
  };
});
