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
  const r = await f(
    "https://chromiumdash.appspot.com/fetch_releases?channel=Stable&platform=Windows&num=1"
  );
  const d = await r.json();
  if (!d.length) throw new Error("empty");
  return ok("Chrome Stable", d[0].version, d[0].milestone, "chromiumdash.appspot.com");
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
  return ok("Edge", null, major, "edgeupdates.microsoft.com");
}

// --- Brave ---
async function brave() {
  const r = await f("https://versions.brave.com/latest/brave-versions.json");
  const data = await r.json();
  for (const info of Object.values(data)) {
    if (info.channel !== "release") continue;
    const ver = info.dependencies?.chrome;
    if (ver) return ok("Brave Release", ver, parseInt(ver, 10), "versions.brave.com");
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
  if (cm) return ok("Vivaldi Release", cm[1], parseInt(cm[1], 10), "update.vivaldi.com");
  throw new Error("not found in notes");
}

// --- Opera ---
async function opera() {
  const r = await f("https://ftp.opera.com/pub/opera/desktop/");
  const html = await r.text();
  const re = /href="(\d+)\.\d+\.\d+\.\d+\/"/g;
  let max = 0, m;
  while ((m = re.exec(html)) !== null) {
    const v = parseInt(m[1], 10);
    if (v > max) max = v;
  }
  if (!max) throw new Error("no versions");
  return ok("Opera", null, max + 16, "ftp.opera.com (major +16 offset)");
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
      return ok("Comet Release", null, major, "uptodown.com (version scheme)");
  }
  throw new Error("not found");
}

// --- Handler ---
const fetchers = [
  { name: "Chrome Stable", fn: chrome },
  { name: "Edge", fn: edge },
  { name: "Brave Release", fn: brave },
  { name: "Vivaldi Release", fn: vivaldi },
  { name: "Opera", fn: opera },
  { name: "Comet Release", fn: comet },
];

export async function onRequestGet() {
  const results = await Promise.allSettled(fetchers.map((x) => x.fn()));
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
