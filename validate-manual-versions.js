// Validates manual-versions.json schema.
// Each key must be either an empty object or have both chromiumMajor (number) and lastUpdated (string).

import { readFile } from "node:fs/promises";

const raw = await readFile("manual-versions.json", "utf8");
const data = JSON.parse(raw);
let errors = 0;

for (const [key, entry] of Object.entries(data)) {
  const keys = Object.keys(entry);
  if (keys.length === 0) continue;

  const problems = [];
  if (typeof entry.chromiumMajor !== "number") {
    problems.push("chromiumMajor must be a number");
  }
  if (typeof entry.lastUpdated !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(entry.lastUpdated)) {
    problems.push("lastUpdated must be a YYYY-MM-DD string");
  }
  if (problems.length) {
    console.error("  FAIL  " + key + ": " + problems.join("; "));
    errors++;
  } else {
    console.log("  OK    " + key);
  }
}

if (errors) {
  console.error("\n" + errors + " invalid entry/entries in manual-versions.json");
  process.exit(1);
} else {
  console.log("\nmanual-versions.json is valid");
}
