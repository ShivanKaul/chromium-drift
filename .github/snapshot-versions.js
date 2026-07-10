// snapshot-versions.js -- Record a daily snapshot of all browser Chromium
// versions into snapshots.ndjson.
//
// Fetches live browsers (Chrome, Edge, Brave, Comet, Arc) via the shared
// fetcher library, and reads CI-detected browsers (Vivaldi, Opera, Dia)
// from ci-versions.json.
//
// Usage: node .github/snapshot-versions.js

import { readFileSync, appendFileSync, existsSync } from "node:fs";
import { fetchers, ciBrowsers } from "../lib/fetchers.js";

const ciPath = new URL("../ci-versions.json", import.meta.url).pathname;
const snapshotPath = new URL("../snapshots.ndjson", import.meta.url).pathname;

const ciVersions = JSON.parse(readFileSync(ciPath, "utf8"));
const today = new Date().toISOString().slice(0, 10);

// Check if today's snapshot already exists
if (existsSync(snapshotPath)) {
  const lines = readFileSync(snapshotPath, "utf8").trimEnd().split("\n");
  const last = lines[lines.length - 1];
  if (last) {
    try {
      const prev = JSON.parse(last);
      if (prev.date === today) {
        console.log("Snapshot for " + today + " already exists, skipping");
        process.exit(0);
      }
    } catch (_) {}
  }
}

const snapshot = { date: today };
let failures = 0;

// Fetch live browsers
for (const { key, fn } of fetchers) {
  try {
    const result = await fn();
    snapshot[key] = result.chromiumVersion || null;
    console.log("[" + key + "] " + (result.chromiumVersion || "null"));
  } catch (e) {
    console.error("[" + key + "] FAILED: " + e.message);
    snapshot[key] = null;
    failures++;
  }
}

// Add CI-detected browsers
for (const { key } of ciBrowsers) {
  const ci = ciVersions[key];
  snapshot[key] = ci?.chromiumVersion || null;
  console.log("[" + key + "] " + (snapshot[key] || "null") + " (from CI)");
}

appendFileSync(snapshotPath, JSON.stringify(snapshot) + "\n");
console.log("\nSnapshot recorded for " + today);

if (failures) {
  console.error(failures + " live fetcher(s) failed");
  process.exit(1);
}
