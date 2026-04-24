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
    return ok("Chrome Stable", latest.version, latest.milestone, "source: public API (chromiumdash.appspot.com, macOS)");
  }
  // Latest is still early stable; use previous milestone
  const prev = releases.find((rel) => rel.milestone < latest.milestone);
  if (prev) return ok("Chrome Stable", prev.version, prev.milestone, "source: public API (chromiumdash.appspot.com, macOS)");
  return ok("Chrome Stable", latest.version, latest.milestone, "source: public API (chromiumdash.appspot.com, macOS)");
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
  return ok("Edge", rel.ProductVersion, major, "source: public API (edgeupdates.microsoft.com, macOS)");
}

// --- Brave ---
async function brave() {
  const r = await f("https://versions.brave.com/latest/brave-versions.json");
  const data = await r.json();
  for (const info of Object.values(data)) {
    if (info.channel !== "release") continue;
    const ver = info.dependencies?.chrome;
    if (ver) return ok("Brave Release", ver, parseInt(ver, 10), "source: public API (versions.brave.com)");
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
  if (cm) return ok("Vivaldi Release", cm[1], parseInt(cm[1], 10), "source: scraped release notes (vivaldi.com)");
  throw new Error("not found in notes");
}

// --- Opera ---
async function opera() {
  const ua = { headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36" } };
  const r = await f("https://blogs.opera.com/desktop/", ua);
  const html = await r.text();
  // Find the latest major stable release post (e.g., /opera-130-stable/ or /opera-123/)
  const links = [...html.matchAll(/href="(https:\/\/blogs\.opera\.com\/desktop\/\d{4}\/\d{2}\/opera-(\d+)(?:-stable)?\/?)"/g)];
  if (!links.length) throw new Error("no stable post found");
  // Pick the highest Opera major version
  let best = links[0];
  for (const m of links) {
    if (parseInt(m[2], 10) > parseInt(best[2], 10)) best = m;
  }
  const pr = await f(best[1], ua, 10000);
  const page = await pr.text();
  const cm = page.match(/Chromium[^\d]{0,80}(\d+\.\d+\.\d+\.\d+)/i);
  if (cm) return ok("Opera", cm[1], parseInt(cm[1], 10), "source: scraped blog posts (blogs.opera.com)");
  // Fallback: major-only match (e.g., "Chromium 113")
  const mm = page.match(/Chromium[^\d]{0,80}(\d{3,})/i);
  if (mm) return ok("Opera", null, parseInt(mm[1], 10), "source: scraped blog posts (blogs.opera.com)");
  throw new Error("Chromium version not found in post");
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
      return ok("Comet", null, major, "source: uptodown.com download page");
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
  { name: "Comet", key: "comet", fn: comet },
];

function fromOverride(name, entry) {
  return ok(
    name,
    entry.chromiumVersion || null,
    entry.chromiumMajor,
    "source: manual override" + (entry.lastUpdated ? " (" + entry.lastUpdated + ")" : "")
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

  const encoder = new TextEncoder();
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();

  const fetchedAt = Date.now();
  const promises = fetchers.map((x) => {
    const ov = overrides[x.key];
    const p = ov?.chromiumMajor
      ? Promise.resolve(fromOverride(x.name, ov))
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

  Promise.all(promises)
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
