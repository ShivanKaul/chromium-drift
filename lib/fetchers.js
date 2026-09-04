// Shared browser fetcher functions used by both the Cloudflare Pages API
// (functions/api.js) and the CI snapshot script (.github/snapshot-versions.js).

export const FETCH_TIMEOUT = 25000;
export const FETCH_RETRIES = 3;
export const FETCH_RETRY_DELAY = 1500;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchOnce(url, opts, timeout) {
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

export async function f(url, opts = {}, timeout = FETCH_TIMEOUT, retries = FETCH_RETRIES) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fetchOnce(url, opts, timeout);
    } catch (err) {
      lastErr = err;
      if (attempt < retries) await sleep(FETCH_RETRY_DELAY * (attempt + 1));
    }
  }
  throw lastErr;
}

export function ok(browser, chromiumVersion, chromiumMajor, source, sourceUrl = null) {
  return { browser, chromiumVersion, chromiumMajor, source, sourceUrl, error: null };
}

// --- Chrome ---
export async function chrome() {
  const u = "https://versionhistory.googleapis.com/v1/chrome/platforms/mac/channels/stable/versions/all/releases?filter=endtime=none&order_by=version%20desc";
  const r = await f(u);
  const d = await r.json();
  // "Pinnable" versions are the full releases we're expecting, rather than anything from a rollout or A/B testing
  // Not documented in the official reference, but thankfully Google open sourced this API
  // https://github.com/googleapis/google-api-go-client/blob/dfa9e13aa3e07a6283a6497f744ba5c4785a54fc/versionhistory/v1/versionhistory-api.json#L474-L477
  const v = d.releases.find((v) => v.pinnable).version;
  if (!v) throw new Error("No \"pinnable\" Chrome release found. Something may be wrong");
  const m = parseInt(v, 10);
  return ok("Chrome Stable", v, m, "source: public API (versionhistory.googleapis.com, macOS)", u);
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
  const items = [...xml.matchAll(
    /<item>[\s\S]*?<sparkle:version>(\d+)<\/sparkle:version>[\s\S]*?<\/item>/g
  )];
  if (!items.length) throw new Error("No items in appcast");
  items.sort((a, b) => Number(b[1]) - Number(a[1]));
  // Some releases omit the Chromium version, so use the newest one that names it.
  let cm = null;
  for (const [item] of items) {
    cm = item.match(/Chromium\s+(\d+\.\d+\.\d+\.\d+)/i);
    if (cm) break;
  }
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
  { name: "Dia", key: "dia" },
  { name: "Helium", key: "helium" },
];
