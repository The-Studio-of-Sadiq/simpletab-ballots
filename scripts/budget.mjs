import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const vitestBin = path.resolve(repoRoot, "node_modules/vitest/vitest.mjs");
const MARKER = "__BUDGET_REPORT_JSON__:";

function fmtInt(n) {
  return Math.round(n).toLocaleString("en-US");
}

function fmtPct(ratio) {
  return `${(ratio * 100).toFixed(1)}%`;
}

function renderTable(headers, rows, alignRightCols = new Set()) {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => String(r[i]).length)),
  );
  const pad = (val, i) => {
    const str = String(val);
    return alignRightCols.has(i) ? str.padStart(widths[i]) : str.padEnd(widths[i]);
  };
  const sep = widths.map((w) => "-".repeat(w)).join("-+-");
  const lines = [
    headers.map(pad).join(" | "),
    sep,
    ...rows.map((row) => row.map(pad).join(" | ")),
  ];
  return lines.join("\n");
}

console.log("Running Cloudflare free-tier budget replay in Miniflare...");

const child = spawn(
  process.execPath,
  [
    vitestBin,
    "run",
    "--project",
    "budget",
    "--reporter=verbose",
    "--disableConsoleIntercept",
  ],
  {
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "pipe"],
  },
);

let stdout = "";
let stderr = "";
let pendingLine = "";

child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  stdout += chunk;
  pendingLine += chunk;
  const lines = pendingLine.split(/\r?\n/);
  pendingLine = lines.pop() ?? "";
  for (const line of lines) {
    if (line.includes("[budget]")) {
      console.log(line.trim());
    }
  }
});

child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => {
  stderr += chunk;
});

child.on("error", (err) => {
  console.error("Failed to invoke Vitest:", err);
  process.exit(1);
});

child.on("close", (status) => {
  let report = null;
  for (const line of stdout.split(/\r?\n/)) {
    const idx = line.indexOf(MARKER);
    if (idx !== -1) {
      try {
        report = JSON.parse(line.slice(idx + MARKER.length));
      } catch (err) {
        console.error("Failed to parse budget report JSON:", err);
      }
    }
  }

  if (!report) {
    console.error("Budget test did not emit a structured report.");
    if (stdout.trim()) {
      console.error(stdout);
    }
    if (stderr.trim()) {
      console.error(stderr);
    }
    process.exit(status || 1);
  }

  console.log("");
  console.log("=== Per-Route D1 Rows Written (Miniflare SQLite VFS) ===");
  console.log(
    renderTable(
      ["Route", "Design", "Expected", "Measured", "Reads", "Status", "Notes"],
      report.perRoute.map((r) => [
        r.route,
        fmtInt(r.designWrites),
        fmtInt(r.expectedWrites),
        fmtInt(r.measuredWrites),
        fmtInt(r.measuredReads),
        r.measuredWrites === r.expectedWrites ? "PASS" : "FAIL",
        r.note,
      ]),
      new Set([1, 2, 3, 4]),
    ),
  );

  console.log("");
  console.log(
    `=== Free-Tier Daily Budget (Fail threshold: ${(report.limits.failRatio * 100).toFixed(0)}% of 100k req / 100k writes / 5M reads; Share cap: ${fmtInt(report.limits.maxAllocatedShareWrites)} writes) ===`,
  );
  console.log(
    renderTable(
      [
        "Scenario",
        "Requests",
        "% Req",
        "Rows Written",
        "% Wr",
        "Rows Read",
        "% Rd",
        "Share Wr",
        "Status",
      ],
      report.scenarios.map((s) => [
        s.name,
        fmtInt(s.requests),
        fmtPct(s.pctRequests),
        fmtInt(s.rowsWritten),
        fmtPct(s.pctWrites),
        fmtInt(s.rowsRead),
        fmtPct(s.pctReads),
        fmtInt(s.allocatedShareWrites),
        s.enforced ? (s.passed ? "PASS" : "FAIL") : "REPORT",
      ]),
      new Set([1, 2, 3, 4, 5, 6, 7]),
    ),
  );

  console.log("");
  console.log("=== Findings ===");
  for (const finding of report.findings) {
    console.log(`- ${finding}`);
  }

  console.log("");
  console.log("=== Assumptions ===");
  for (const assumption of report.assumptions) {
    console.log(`- ${assumption}`);
  }

  console.log("");
  const ok = status === 0 && report.overallPassed;
  if (!ok) {
    console.error("BUDGET RESULT: FAIL");
    if (status !== 0) {
      console.error("\n--- Vitest failure output ---");
      for (const line of stdout.split(/\r?\n/)) {
        if (!line.includes(MARKER)) {
          console.error(line);
        }
      }
      if (stderr.trim()) {
        console.error(stderr);
      }
    }
    process.exit(1);
  }

  console.log("BUDGET RESULT: PASS");
});
