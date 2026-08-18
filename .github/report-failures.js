// report-failures.js -- Open or update a GitHub issue for each broken fetcher,
// and close issues whose fetcher has recovered.
//
// Reads fetcher-failures.json (written by snapshot-versions.js). One issue per
// browser, deduped by the marker line in the body so repeated failures comment
// on the existing issue instead of filing a new one.
//
// Usage: node .github/report-failures.js
// Requires: GITHUB_TOKEN, GITHUB_REPOSITORY. Optional: ISSUE_ASSIGNEE, GITHUB_RUN_ID.

import { readFileSync, existsSync } from "node:fs";

const token = process.env.GITHUB_TOKEN;
const repo = process.env.GITHUB_REPOSITORY;
if (!token || !repo) {
  console.error("GITHUB_TOKEN and GITHUB_REPOSITORY are required");
  process.exit(1);
}

const assignee = process.env.ISSUE_ASSIGNEE || "";
const runId = process.env.GITHUB_RUN_ID;
const runUrl = runId
  ? "https://github.com/" + repo + "/actions/runs/" + runId
  : null;
const LABEL = "fetcher-down";
const MARKER = (key) => "<!-- fetcher-failure:" + key + " -->";

async function api(path, opts = {}) {
  const r = await fetch("https://api.github.com" + path, {
    ...opts,
    headers: {
      Authorization: "Bearer " + token,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
      ...opts.headers,
    },
  });
  if (!r.ok) {
    throw new Error("GitHub API " + r.status + " on " + path + ": " + (await r.text()).slice(0, 300));
  }
  return r.status === 204 ? null : r.json();
}

const failuresPath = new URL("../fetcher-failures.json", import.meta.url).pathname;
if (!existsSync(failuresPath)) {
  // The snapshot script died before writing its report. Treating that as "no
  // failures" would close still-broken issues, so bail out instead.
  console.error("fetcher-failures.json missing; snapshot step did not complete");
  process.exit(1);
}
const failures = JSON.parse(readFileSync(failuresPath, "utf8"));

// Ensure the label exists; ignore the 422 we get when it already does.
try {
  await api("/repos/" + repo + "/labels", {
    method: "POST",
    body: JSON.stringify({
      name: LABEL,
      color: "b60205",
      description: "An upstream version fetcher is failing",
    }),
  });
} catch (_) {}

const openIssues = await api(
  "/repos/" + repo + "/issues?state=open&labels=" + LABEL + "&per_page=100"
);

const today = new Date().toISOString().slice(0, 10);

for (const { key, name, message } of failures) {
  const marker = MARKER(key);
  const found = openIssues.find((i) => i.body?.includes(marker));

  if (found) {
    await api("/repos/" + repo + "/issues/" + found.number + "/comments", {
      method: "POST",
      body: JSON.stringify({
        body:
          "Still failing as of " + today + ".\n\n```\n" + message + "\n```\n" +
          (runUrl ? "\n[Workflow run](" + runUrl + ")" : ""),
      }),
    });
    console.log("commented on #" + found.number + " (" + key + ")");
    continue;
  }

  const body =
    name + " could not be resolved to a Chromium version, so its card on the " +
    "dashboard is showing an error and today's snapshot has a null for `" + key + "`.\n\n" +
    "```\n" + message + "\n```\n\n" +
    "First seen: " + today + "\n" +
    (runUrl ? "Workflow run: " + runUrl + "\n" : "") +
    "\nThe fetcher lives in `lib/fetchers.js`. This issue closes automatically " +
    "once the fetcher succeeds again.\n\n" +
    marker;

  const issue = await api("/repos/" + repo + "/issues", {
    method: "POST",
    body: JSON.stringify({
      title: "Version fetcher failing: " + name,
      body,
      labels: [LABEL],
      ...(assignee ? { assignees: [assignee] } : {}),
    }),
  });
  console.log("opened #" + issue.number + " (" + key + ")");
}

// Close issues for fetchers that are working again.
const failedKeys = new Set(failures.map((f) => f.key));
for (const issue of openIssues) {
  const stale = [...(issue.body || "").matchAll(/<!-- fetcher-failure:(\S+) -->/g)]
    .map((m) => m[1])
    .filter((k) => !failedKeys.has(k));
  if (!stale.length) continue;

  await api("/repos/" + repo + "/issues/" + issue.number + "/comments", {
    method: "POST",
    body: JSON.stringify({
      body: "Fetcher recovered as of " + today + ". Closing.",
    }),
  });
  await api("/repos/" + repo + "/issues/" + issue.number, {
    method: "PATCH",
    body: JSON.stringify({ state: "closed", state_reason: "completed" }),
  });
  console.log("closed #" + issue.number + " (recovered)");
}
