// read-overrides.js -- Find fetcher-down issues also labeled accept-regression,
// and write their browser keys to accepted-regressions.json so update-versions.js
// can skip its regression guard for them this run.
//
// Usage: node .github/read-overrides.js
// Requires: GITHUB_TOKEN, GITHUB_REPOSITORY.

import { writeFileSync } from "node:fs";

const token = process.env.GITHUB_TOKEN;
const repo = process.env.GITHUB_REPOSITORY;
if (!token || !repo) {
  console.error("GITHUB_TOKEN and GITHUB_REPOSITORY are required");
  process.exit(1);
}

const OVERRIDE_LABEL = "accept-regression";
const outPath = new URL("../accepted-regressions.json", import.meta.url).pathname;

const r = await fetch(
  "https://api.github.com/repos/" + repo +
    "/issues?state=open&labels=fetcher-down," + OVERRIDE_LABEL + "&per_page=100",
  {
    headers: {
      Authorization: "Bearer " + token,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  }
);
if (!r.ok) {
  throw new Error("GitHub API " + r.status + ": " + (await r.text()).slice(0, 300));
}
const issues = await r.json();

const keys = [...new Set(
  issues.flatMap((i) =>
    [...(i.body || "").matchAll(/<!-- fetcher-failure:(\S+) -->/g)].map((m) => m[1])
  )
)];

writeFileSync(outPath, JSON.stringify(keys) + "\n");
console.log(
  keys.length
    ? "Accepted regressions (labeled " + OVERRIDE_LABEL + "): " + keys.join(", ")
    : "No " + OVERRIDE_LABEL + " issues found"
);
