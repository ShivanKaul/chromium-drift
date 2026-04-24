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

function ok(browser, chromiumVersion, chromiumMajor, source) {
  return { browser, chromiumVersion, chromiumMajor, source, error: null };
}

// --- Chrome ---
async function chrome() {
  // fetch_releases includes early stable rollouts, so we check the latest
  // milestone's schedule to see if stable_date has passed. If not, we use
  // the previous milestone.
  const r = await f(
    "https://chromiumdash.appspot.com/fetch_releases?channel=Stable&platform=Windows&num=10"
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
    return ok("Chrome Stable", latest.version, latest.milestone, "via public API (chromiumdash.appspot.com)");
  }
  // Latest is still early stable; use previous milestone
  const prev = releases.find((rel) => rel.milestone < latest.milestone);
  if (prev) return ok("Chrome Stable", prev.version, prev.milestone, "public API (chromiumdash.appspot.com)");
  return ok("Chrome Stable", latest.version, latest.milestone, "via public API (chromiumdash.appspot.com)");
}

// --- Edge ---
async function edge() {
  const r = await f("https://edgeupdates.microsoft.com/api/products");
  const d = await r.json();
  const s = d.find((p) => p.Product === "Stable");
  if (!s) throw new Error("no Stable");
  const rel =
    s.Releases.find((r) => r.Platform === "Windows" && r.Architecture === "x64") ||
    s.Releases[0];
  if (!rel) throw new Error("no release");
  const major = parseInt(rel.ProductVersion, 10);
  return ok("Edge", null, major, "via public API (edgeupdates.microsoft.com)");
}

// --- Brave ---
async function brave() {
  const r = await f("https://versions.brave.com/latest/brave-versions.json");
  const data = await r.json();
  for (const info of Object.values(data)) {
    if (info.channel !== "release") continue;
    const ver = info.dependencies?.chrome;
    if (ver) return ok("Brave Release", ver, parseInt(ver, 10), "via public API (versions.brave.com)");
  }
  throw new Error("no release channel found");
}

// --- Vivaldi ---
async function vivaldi() {
  const r = await f("https://update.vivaldi.com/update/1.0/public/appcast.x64.xml");
  const xml = await r.text();
  const nm = xml.match(/<sparkle:releaseNotesLink>([^<]+)<\/sparkle:releaseNotesLink>/i);
  if (!nm) throw new Error("no notes link");
  const nr = await f(nm[1].trim(), {}, 10000);
  const html = await nr.text();
  const cm = html.match(/Chromium[^\d]{0,60}(\d+\.\d+\.\d+\.\d+)/i);
  if (cm) return ok("Vivaldi Release", cm[1], parseInt(cm[1], 10), "release notes (update.vivaldi.com)");
  throw new Error("not found in notes");
}

// --- Opera ---
// Opera has no reliable programmatic feed for its Chromium version.
// Relies on manual override in manual-versions.json.
async function opera() {
  throw new Error("no automated source; needs manual override");
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
      return ok("Comet Release", null, major, "uptodown.com");
  }
  throw new Error("not found");
}

// --- Handler ---
const fetchers = [
  { name: "Chrome Stable", key: "chrome", fn: chrome },
  { name: "Edge", key: "edge", fn: edge },
  { name: "Brave Release", key: "brave", fn: brave },
  { name: "Vivaldi Release", key: "vivaldi", fn: vivaldi },
  { name: "Opera", key: "opera", fn: opera },
  { name: "Comet Release", key: "comet", fn: comet },
];

function fromOverride(name, entry) {
  return ok(
    name,
    entry.chromiumVersion || null,
    entry.chromiumMajor,
    "manual override" + (entry.lastUpdated ? " (" + entry.lastUpdated + ")" : "")
  );
}

export async function onRequestGet(context) {
  let overrides = {};
  try {
    const mr = await context.env.ASSETS.fetch(
      new URL("/manual-versions.json", context.request.url)
    );
    if (mr.ok) overrides = await mr.json();
  } catch (_) {}

  const results = await Promise.allSettled(
    fetchers.map((x) => {
      const ov = overrides[x.key];
      if (ov?.chromiumMajor) return Promise.resolve(fromOverride(x.name, ov));
      return x.fn();
    })
  );
  const data = results.map((r, i) => {
    if (r.status === "fulfilled") return r.value;
    return {
      browser: fetchers[i].name,
      chromiumVersion: null,
      chromiumMajor: null,
      source: null,
      error: r.reason?.message || "Unknown error",
    };
  });
  return new Response(JSON.stringify({ data, fetchedAt: Date.now() }), {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "public, s-maxage=1800, max-age=300",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
