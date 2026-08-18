// Accessibility audit for index.html.
// Run with: node test/a11y.js [path-to-index.html]
//
// Serves the repo over a local HTTP server with a stubbed /api so the cards
// render in every color state (baseline, behind, unavailable), then runs the
// Lighthouse accessibility category against it. Nothing here touches the real
// upstream browser-version APIs, so results are deterministic.

import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";

const MIN_SCORE = Number(process.env.A11Y_MIN_SCORE || 100);
const LIGHTHOUSE = "lighthouse@13.4.1";
const ROOT = resolve(import.meta.dirname, "..");
const INDEX = process.argv[2] ? resolve(process.argv[2]) : join(ROOT, "index.html");

// One entry per delta branch in cardColorCls/dCls, so the audit sees every
// badge and card background combination the real page can produce.
const FIXTURE = [
  { browser: "Chrome Stable", chromiumVersion: "148.0.7823.61", chromiumMajor: 148, source: "stub" },
  { browser: "Brave Release", chromiumVersion: "148.0.7823.61", chromiumMajor: 148, source: "stub" },
  { browser: "Vivaldi Stable", chromiumVersion: "147.0.7712.40", chromiumMajor: 147, source: "stub" },
  { browser: "Comet", chromiumVersion: "146.0.7601.12", chromiumMajor: 146, source: "stub" },
  { browser: "Opera Stable", chromiumVersion: "145.0.7492.88", chromiumMajor: 145, source: "stub" },
  { browser: "Edge Stable", chromiumVersion: "148.0.7823.35", chromiumMajor: 148, source: "stub" },
  { browser: "Arc", chromiumVersion: "142.0.7205.10", chromiumMajor: 142, source: "stub" },
  { browser: "Dia", chromiumVersion: "147.0.7712.40", chromiumMajor: 147, source: "stub" },
  { browser: "Helium", chromiumVersion: null, chromiumMajor: null, source: null, error: "no version data available" },
];

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".ndjson": "application/x-ndjson; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

function startServer() {
  const server = createServer(async (req, res) => {
    const path = decodeURIComponent(new URL(req.url, "http://localhost").pathname);

    if (path === "/api") {
      const body =
        FIXTURE.map((e) => JSON.stringify(e)).join("\n") +
        "\n" +
        JSON.stringify({ fetchedAt: 1767225600000 }) +
        "\n";
      res.writeHead(200, { "content-type": MIME[".ndjson"] });
      res.end(body);
      return;
    }

    const file = path === "/" ? INDEX : resolve(join(ROOT, path));
    if (file !== INDEX && !file.startsWith(ROOT + sep)) {
      res.writeHead(403);
      res.end("forbidden");
      return;
    }

    try {
      const buf = await readFile(file);
      // The entry document is always HTML even when it is a temp file whose
      // name does not end in .html (BSD mktemp appends a random suffix).
      const type = file === INDEX ? MIME[".html"] : MIME[extname(file)] || "application/octet-stream";
      res.writeHead(200, { "content-type": type });
      res.end(buf);
    } catch {
      res.writeHead(404);
      res.end("not found");
    }
  });

  return new Promise((res) => {
    server.listen(0, "127.0.0.1", () => res(server));
  });
}

function runLighthouse(url) {
  return new Promise((res, rej) => {
    const child = spawn(
      "npx",
      [
        "--yes",
        "--ignore-scripts",
        LIGHTHOUSE,
        url,
        "--only-categories=accessibility",
        "--output=json",
        "--output-path=stdout",
        "--quiet",
        "--chrome-flags=--headless=new --no-sandbox --disable-gpu --disable-dev-shm-usage",
      ],
      { stdio: ["ignore", "pipe", "pipe"] }
    );

    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", rej);
    child.on("close", (code) => {
      if (!out.trim()) {
        rej(new Error("lighthouse produced no output (exit " + code + ")\n" + err.trim()));
        return;
      }
      try {
        res(JSON.parse(out));
      } catch (e) {
        rej(new Error("could not parse lighthouse output: " + e.message + "\n" + err.trim()));
      }
    });
  });
}

const server = await startServer();
const url = "http://127.0.0.1:" + server.address().port + "/";
console.log("\nAccessibility audit (" + INDEX.replace(ROOT + sep, "") + ")\n");

let report;
try {
  report = await runLighthouse(url);
} catch (e) {
  console.error("  ERROR  " + e.message + "\n");
  process.exit(1);
} finally {
  server.close();
}

if (report.runtimeError) {
  console.error("  ERROR  " + report.runtimeError.message + "\n");
  process.exit(1);
}

const score = Math.round((report.categories.accessibility.score ?? 0) * 100);
const failures = Object.values(report.audits).filter(
  (a) => a.score !== null && a.score < 1 && a.scoreDisplayMode !== "informative"
);

for (const a of failures) {
  console.log("  FAIL  " + a.id + ": " + a.title);
  const items = a.details?.items || [];
  for (const item of items.slice(0, 5)) {
    const sel = item.node?.selector || item.node?.snippet;
    if (sel) console.log("          " + sel.replace(/\s+/g, " ").slice(0, 120));
  }
  if (items.length > 5) console.log("          ...and " + (items.length - 5) + " more");
}

const manual = Object.values(report.audits).filter((a) => a.scoreDisplayMode === "manual").length;
console.log(
  "\nScore " + score + "/100 (threshold " + MIN_SCORE + "), " +
  failures.length + " failing audit" + (failures.length === 1 ? "" : "s") +
  ", " + manual + " needing manual review\n"
);

process.exit(score < MIN_SCORE ? 1 : 0);
