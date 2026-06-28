// Shared browser fetcher functions used by both the Cloudflare Pages API
// (functions/api.js) and the CI snapshot script (.github/snapshot-versions.js).

export const FETCH_TIMEOUT = 12000;

export async function f(url, opts = {}, timeout = FETCH_TIMEOUT) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeout);
  try {
    const r = await fetch(url, {
      ...opts,
      signal: ac.signal,
    });
    if (!r.ok) throw new Error("HTTP " + r.status);
    return r;
  } finally {
    clearTimeout(t);
  }
}

export function ok(browser, chromiumVersion, chromiumMajor, source, sourceUrl = null) {
  return { browser, chromiumVersion, chromiumMajor, source, sourceUrl, error: null };
}

// --- Chrome ---
export async function chrome() {
  // fetch_releases includes early stable rollouts, so we check the latest
  // milestone's schedule to see if stable_date has passed. If not, we use
  // the previous milestone.
  const r = await f(
    "https://chromiumdash.appspot.com/fetch_releases?channel=Stable&platform=Mac&num=10"
  );
  const releases = await r.json();
  if (!releases.length) throw new Error("empty");

  const latest = releases[0];
  const sched = await f(
    "https://chromiumdash.appspot.com/fetch_milestone_schedule?mstone=" + latest.milestone
  );
  const data = await sched.json();
  const stableDate = data.mstones?.[0]?.stable_date;

  // Chrome rolls out gradually, so wait until the day after the official
  // stable_date (in Pacific Time) before treating the new milestone as current.
  const stableDatePassed = !stableDate || (() => {
    // Get today's date in Pacific Time as YYYY-MM-DD
    const todayPT = new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
    // The stable_date from the API is a date string (e.g. "2026-05-05").
    // We require todayPT to be strictly after the stable_date.
    return todayPT > stableDate.slice(0, 10);
  })();
  if (stableDatePassed) {
    return ok("Chrome Stable", latest.version, latest.milestone, "source: public API (chromiumdash.appspot.com, macOS)", "https://chromiumdash.appspot.com/fetch_releases?channel=Stable&platform=Mac&num=10");
  }
  // Latest is still early stable; use previous milestone
  const prev = releases.find((rel) => rel.milestone < latest.milestone);
  if (prev) return ok("Chrome Stable", prev.version, prev.milestone, "source: public API (chromiumdash.appspot.com, macOS)", "https://chromiumdash.appspot.com/fetch_releases?channel=Stable&platform=Mac&num=10");
  return ok("Chrome Stable", latest.version, latest.milestone, "source: public API (chromiumdash.appspot.com, macOS)", "https://chromiumdash.appspot.com/fetch_releases?channel=Stable&platform=Mac&num=10");
}

// --- Edge ---
export async function edge() {
  const r = await f("https://edgeupdates.microsoft.com/api/products");
  const d = await r.json();
  const s = d.find((p) => p.Product === "Stable");
  if (!s) throw new Error("no Stable");
  const rel =
    s.Releases.find((r) => r.Platform === "MacOS") ||
    s.Releases[0];
  if (!rel) throw new Error("no release");
  const major = parseInt(rel.ProductVersion, 10);
  return ok("Edge Stable", rel.ProductVersion, major, "source: public API (edgeupdates.microsoft.com, macOS)", "https://edgeupdates.microsoft.com/api/products");
}

// --- Brave ---
export async function brave() {
  const r = await f("https://versions.brave.com/latest/brave-versions.json");
  const data = await r.json();
  for (const info of Object.values(data)) {
    if (info.channel !== "release") continue;
    const ver = info.dependencies?.chrome;
    if (ver) return ok("Brave Release", ver, parseInt(ver, 10), "source: public API (versions.brave.com)", "https://versions.brave.com/latest/brave-versions.json");
  }
  throw new Error("no release channel found");
}

// --- Comet ---
export async function comet() {
  const r = await f("https://www.perplexity.ai/rest/browser/update2", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      request: {
        protocol: "4.0",
        os: { platform: "win", arch: "x64" },
        apps: [{
          appid: "{42e10078-e377-4166-965f-c14ad958a146}",
          version: "0.0.0.0",
          updatechecks: [{}],
        }],
      },
    }),
  });
  const text = await r.text();
  const json = JSON.parse(text.replace(/^\)\]\}'/, ""));
  const ver = json?.response?.apps?.[0]?.updatecheck?.nextversion;
  if (!ver) throw new Error("no version in update response");
  const major = parseInt(ver, 10);
  return ok("Comet", ver, major, "source: Omaha update API (perplexity.ai)");
}

// --- Arc ---
export async function arc() {
  const r = await f("https://releases.arc.net/updates.xml");
  const xml = await r.text();
  // Each appcast item description mentions the Chromium version (Arc is in
  // maintenance mode, so every release is a Chromium security update).
  const items = [...xml.matchAll(
    /<item>[\s\S]*?<sparkle:version>(\d+)<\/sparkle:version>[\s\S]*?<\/item>/g
  )];
  if (!items.length) throw new Error("No items in appcast");
  items.sort((a, b) => Number(b[1]) - Number(a[1]));
  const latest = items[0][0];
  const cm = latest.match(/Chromium\s+(\d+\.\d+\.\d+\.\d+)/i);
  if (!cm) throw new Error("Chromium version not found in appcast");
  return ok("Arc", cm[1], parseInt(cm[1], 10), "source: Sparkle appcast (releases.arc.net)", "https://releases.arc.net/updates.xml");
}

// --- Browser lists ---

export const fetchers = [
  { name: "Chrome Stable", key: "chrome", fn: chrome },
  { name: "Edge Stable", key: "edge", fn: edge },
  { name: "Brave Release", key: "brave", fn: brave },
  { name: "Comet", key: "comet", fn: comet },
  { name: "Arc", key: "arc", fn: arc },
];

export const ciBrowsers = [
  { name: "Vivaldi Stable", key: "vivaldi" },
  { name: "Opera Stable", key: "opera" },
  { name: "ChatGPT Atlas", key: "atlas" },
  { name: "Dia", key: "dia" },
  { name: "Helium", key: "helium" },
];
