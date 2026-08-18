// snapshot-versions.js -- Record a daily snapshot of all browser Chromium
// versions into snapshots.ndjson.
//
// Fetches live browsers (Chrome, Edge, Brave, Comet, Arc) via the shared
// fetcher library, and reads CI-detected browsers (Vivaldi, Opera, Dia)
// from ci-versions.json.
//
// Usage: node .github/snapshot-versions.js

import { readFileSync, appendFileSync, writeFileSync, existsSync } from "node:fs";
import { fetchers, ciBrowsers } from "../lib/fetchers.js";

const ciPath = new URL("../ci-versions.json", import.meta.url).pathname;
const snapshotPath = new URL("../snapshots.ndjson", import.meta.url).pathname;
const failuresPath = new URL("../fetcher-failures.json", import.meta.url).pathname;

const ciVersions = JSON.parse(readFileSync(ciPath, "utf8"));
const today = new Date().toISOString().slice(0, 10);

const lines = existsSync(snapshotPath)
  ? readFileSync(snapshotPath, "utf8").trimEnd().split("\n").filter(Boolean)
  : [];

let existing = null;
if (lines.length) {
  try {
    const prev = JSON.parse(lines[lines.length - 1]);
    if (prev.date === today) existing = prev;
  } catch (_) {}
}

// When today's row already exists, only re-fetch the browsers still missing.
// The second scheduled run of the day can then heal a transient upstream
// outage instead of leaving a permanent null in the history.
const targets = existing
  ? fetchers.filter(({ key }) => !existing[key])
  : fetchers;

if (existing && !targets.length) {
  console.log("Snapshot for " + today + " already complete, skipping");
  // Every fetcher has a version for today, so report zero failures rather than
  // leaving a stale file that report-failures.js would misread.
  writeFileSync(failuresPath, "[]\n");
  process.exit(0);
}
if (existing) {
  console.log(
    "Backfilling " + today + ": " + targets.map((t) => t.key).join(", ")
  );
}

const snapshot = existing ? { ...existing } : { date: today };
const failures = [];

for (const { key, name, fn } of targets) {
  try {
    const result = await fn();
    snapshot[key] = result.chromiumVersion || null;
    console.log("[" + key + "] " + (result.chromiumVersion || "null"));
    if (!result.chromiumVersion) {
      failures.push({ key, name, message: "fetcher returned no version" });
    }
  } catch (e) {
    console.error("[" + key + "] FAILED: " + e.message);
    snapshot[key] = null;
    failures.push({ key, name, message: e.message });
  }
}

// Add CI-detected browsers
for (const { key } of ciBrowsers) {
  const ci = ciVersions[key];
  snapshot[key] = ci?.chromiumVersion || null;
  console.log("[" + key + "] " + (snapshot[key] || "null") + " (from CI)");
}

if (existing) {
  lines[lines.length - 1] = JSON.stringify(snapshot);
  writeFileSync(snapshotPath, lines.join("\n") + "\n");
} else {
  appendFileSync(snapshotPath, JSON.stringify(snapshot) + "\n");
}
console.log("\nSnapshot recorded for " + today);

// The workflow reads this to open one GitHub issue per broken fetcher.
writeFileSync(failuresPath, JSON.stringify(failures) + "\n");

if (failures.length) {
  console.error(failures.length + " live fetcher(s) failed");
  process.exit(1);
}
