const FETCH_TIMEOUT = 12000;

async function f(url, opts = {}, timeout = FETCH_TIMEOUT) {
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

function ok(browser, chromiumVersion, chromiumMajor, source, sourceUrl = null) {
  return { browser, chromiumVersion, chromiumMajor, source, sourceUrl, error: null };
}

// --- Chrome ---
async function chrome() {
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

  if (!stableDate || new Date(stableDate).getTime() <= Date.now()) {
    return ok("Chrome Stable", latest.version, latest.milestone, "source: public API (chromiumdash.appspot.com, macOS)", "https://chromiumdash.appspot.com/fetch_releases?channel=Stable&platform=Mac&num=10");
  }
  // Latest is still early stable; use previous milestone
  const prev = releases.find((rel) => rel.milestone < latest.milestone);
  if (prev) return ok("Chrome Stable", prev.version, prev.milestone, "source: public API (chromiumdash.appspot.com, macOS)", "https://chromiumdash.appspot.com/fetch_releases?channel=Stable&platform=Mac&num=10");
  return ok("Chrome Stable", latest.version, latest.milestone, "source: public API (chromiumdash.appspot.com, macOS)", "https://chromiumdash.appspot.com/fetch_releases?channel=Stable&platform=Mac&num=10");
}

// --- Edge ---
async function edge() {
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
async function brave() {
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
async function comet() {
  const r = await f("https://comet-browser.en.uptodown.com/windows/download", {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
    },
  });
  const html = await r.text();
  const m = html.match(/(\d{3,})\.\d+\.\d+\.\d+/);
  if (m) {
    const major = parseInt(m[1], 10);
    if (major >= 100 && major <= 250)
      return ok("Comet", null, major, "source: uptodown.com download page", "https://comet-browser.en.uptodown.com/windows/download");
  }
  throw new Error("not found");
}

// --- Arc ---
async function arc() {
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

// --- Handler ---

// Browsers with live API fetchers (run at request time)
const fetchers = [
  { name: "Chrome Stable", key: "chrome", fn: chrome },
  { name: "Edge Stable", key: "edge", fn: edge },
  { name: "Brave Release", key: "brave", fn: brave },
  { name: "Comet", key: "comet", fn: comet },
  { name: "Arc", key: "arc", fn: arc },
];

// Browsers whose versions come from CI (extracted from binaries daily).
// Manual overrides in manual-versions.json take priority over CI values.
const ciBrowsers = [
  { name: "Vivaldi Stable", key: "vivaldi" },
  { name: "Opera Stable", key: "opera" },
  { name: "ChatGPT Atlas", key: "atlas" },
  { name: "Dia", key: "dia" },
  { name: "Helium", key: "helium" },
];

function fromEntry(name, entry, sourcePrefix) {
  return ok(
    name,
    entry.chromiumVersion || null,
    entry.chromiumMajor,
    "source: " + sourcePrefix + (entry.lastUpdated ? " (" + entry.lastUpdated + ")" : "")
  );
}

export async function onRequestGet(context) {
  let overrides = {};
  let ciVersions = {};
  try {
    const mr = await context.env.ASSETS.fetch(
      new URL("/manual-versions.json", context.request.url)
    );
    if (mr.ok) overrides = await mr.json();
  } catch (_) {}
  try {
    const cr = await context.env.ASSETS.fetch(
      new URL("/ci-versions.json", context.request.url)
    );
    if (cr.ok) ciVersions = await cr.json();
  } catch (_) {}

  const encoder = new TextEncoder();
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();

  const fetchedAt = Date.now();

  // Live-fetched browsers (manual override takes priority)
  const livePromises = fetchers.map((x) => {
    const ov = overrides[x.key];
    const p = ov?.chromiumMajor
      ? Promise.resolve(fromEntry(x.name, ov, "manual override"))
      : x.fn();
    return p.then(
      (result) => writer.write(encoder.encode(JSON.stringify(result) + "\n")),
      (err) =>
        writer.write(
          encoder.encode(
            JSON.stringify({
              browser: x.name,
              chromiumVersion: null,
              chromiumMajor: null,
              source: null,
              error: err?.message || "Unknown error",
            }) + "\n"
          )
        )
    );
  });

  // CI-detected browsers (manual override > CI version)
  const ciPromises = ciBrowsers.map((x) => {
    const ov = overrides[x.key];
    const ci = ciVersions[x.key];
    let result;
    if (ov?.chromiumMajor) {
      result = fromEntry(x.name, ov, "manual override");
    } else if (ci?.chromiumMajor) {
      result = fromEntry(x.name, ci, ci.source || "CI");
    } else {
      result = {
        browser: x.name,
        chromiumVersion: null,
        chromiumMajor: null,
        source: null,
        error: "no version data available",
      };
    }
    return writer.write(encoder.encode(JSON.stringify(result) + "\n"));
  });

  Promise.all([...livePromises, ...ciPromises])
    .then(() =>
      writer.write(
        encoder.encode(JSON.stringify({ fetchedAt }) + "\n")
      )
    )
    .finally(() => writer.close());

  return new Response(readable, {
    headers: {
      "Content-Type": "application/x-ndjson",
      "Cache-Control": "public, max-age=60",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
