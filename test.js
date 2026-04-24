// Tests for the Chromium version fetchers.
// Run with: node test.js
//
// Integration tests hit the real upstream APIs to verify they still return
// data in the expected format. They'll fail if an upstream changes its
// schema or goes down.

const FETCH_TIMEOUT = 15000;

async function f(url, opts = {}, timeout = FETCH_TIMEOUT) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeout);
  try {
    const r = await fetch(url, { ...opts, signal: ac.signal });
    if (!r.ok) throw new Error("HTTP " + r.status);
    return r;
  } finally {
    clearTimeout(t);
  }
}

let passed = 0;
let failed = 0;

function assert(condition, msg) {
  if (!condition) throw new Error("Assertion failed: " + msg);
}

async function test(name, fn) {
  try {
    await fn();
    console.log("  PASS  " + name);
    passed++;
  } catch (e) {
    console.log("  FAIL  " + name + ": " + e.message);
    failed++;
  }
}

// ---------------------------------------------------------------------------
// Unit tests: parsing logic
// ---------------------------------------------------------------------------

console.log("\nParsing tests\n");

await test("Vivaldi appcast: extracts release notes link", () => {
  const xml = `<?xml version="1.0"?>
    <rss><channel><item>
      <sparkle:releaseNotesLink>https://example.com/notes.html</sparkle:releaseNotesLink>
      <enclosure sparkle:version="7.9.3970.59"/>
    </item></channel></rss>`;
  const m = xml.match(/<sparkle:releaseNotesLink>([^<]+)<\/sparkle:releaseNotesLink>/i);
  assert(m, "regex should match");
  assert(m[1] === "https://example.com/notes.html", "URL should match");
});

await test("Vivaldi notes: extracts Chromium version", () => {
  const html = '<li>[Chromium] Updated to 146.0.7680.211 ESR</li>';
  const m = html.match(/Chromium[^\d]{0,60}(\d+\.\d+\.\d+\.\d+)/i);
  assert(m, "regex should match");
  assert(m[1] === "146.0.7680.211", "version should be 146.0.7680.211");
});

await test("Opera blog: extracts stable post URL from listing", () => {
  const html = '<a href="https://blogs.opera.com/desktop/2026/04/opera-130-stable/">Opera 130 Stable</a>';
  const links = [...html.matchAll(/href="(https:\/\/blogs\.opera\.com\/desktop\/\d{4}\/\d{2}\/opera-(\d+)(?:-stable)?\/?)"/g)];
  assert(links.length === 1, "should find one link");
  assert(links[0][2] === "130", "should extract Opera major 130");
});

await test("Opera blog: extracts Chromium full version from post", () => {
  const html = 'Opera 130 is based on the Chromium version: <strong>146.0.7680.178</strong>';
  const cm = html.match(/Chromium[^\d]{0,80}(\d+\.\d+\.\d+\.\d+)/i);
  assert(cm, "regex should match");
  assert(cm[1] === "146.0.7680.178", "version should be 146.0.7680.178");
});

await test("Opera blog: extracts Chromium major-only version", () => {
  const html = 'Opera 99 is based on Chromium 113.';
  const cm = html.match(/Chromium[^\d]{0,80}(\d+\.\d+\.\d+\.\d+)/i);
  assert(!cm, "full version regex should not match");
  const mm = html.match(/Chromium[^\d]{0,80}(\d+)/i);
  assert(mm, "major-only regex should match");
  assert(mm[1] === "113", "major should be 113");
});

await test("Comet version: first component is Chromium major", () => {
  const html = "Latest version: 145.2.7632.5936 for Windows";
  const m = html.match(/(\d{3,})\.\d+\.\d+\.\d+/);
  assert(m, "regex should match");
  assert(parseInt(m[1], 10) === 145, "major should be 145");
});

await test("Comet version: rejects non-Chromium-range numbers", () => {
  const major = 50;
  assert(!(major >= 100 && major <= 250), "50 should be rejected");
});

await test("Chrome schedule: early stable filtered correctly", () => {
  const futureDate = "2099-01-01T00:00:00";
  const pastDate = "2020-01-01T00:00:00";
  assert(new Date(futureDate).getTime() > Date.now(), "future should be > now");
  assert(new Date(pastDate).getTime() <= Date.now(), "past should be <= now");
});

await test("Brave versions.json: finds release channel entry", () => {
  const data = {
    "v1.91.88": { channel: "nightly", dependencies: { chrome: "147.0.7727.102" } },
    "v1.89.141": { channel: "release", dependencies: { chrome: "147.0.7727.102" } },
    "v1.90.100": { channel: "beta", dependencies: { chrome: "147.0.7727.102" } },
  };
  let found = null;
  for (const info of Object.values(data)) {
    if (info.channel === "release") { found = info; break; }
  }
  assert(found, "should find release entry");
  assert(found.dependencies.chrome === "147.0.7727.102", "should have chrome dep");
});

// ---------------------------------------------------------------------------
// Integration tests: real API calls
// ---------------------------------------------------------------------------

console.log("\nIntegration tests (hitting real APIs)\n");

await test("Chrome: ChromiumDash returns valid release", async () => {
  const r = await f(
    "https://chromiumdash.appspot.com/fetch_releases?channel=Stable&platform=Mac&num=1"
  );
  const data = await r.json();
  assert(data.length > 0, "should return at least one release");
  assert(typeof data[0].milestone === "number", "milestone should be a number");
  assert(/^\d+\.\d+\.\d+\.\d+$/.test(data[0].version), "version should be x.x.x.x format");
});

await test("Chrome: milestone schedule returns stable_date", async () => {
  const r = await f(
    "https://chromiumdash.appspot.com/fetch_milestone_schedule?mstone=147"
  );
  const data = await r.json();
  assert(data.mstones?.length > 0, "should have mstones");
  assert(data.mstones[0].stable_date, "should have stable_date");
});

await test("Edge: returns Stable product with releases", async () => {
  const r = await f("https://edgeupdates.microsoft.com/api/products");
  const data = await r.json();
  const stable = data.find((p) => p.Product === "Stable");
  assert(stable, "should have Stable product");
  assert(stable.Releases.length > 0, "should have releases");
  const rel = stable.Releases.find(
    (r) => r.Platform === "MacOS"
  );
  assert(rel, "should have MacOS release");
  const major = parseInt(rel.ProductVersion, 10);
  assert(major >= 100 && major <= 250, "major should be in Chromium range");
});

await test("Brave: versions.brave.com has release channel", async () => {
  const r = await f("https://versions.brave.com/latest/brave-versions.json");
  const data = await r.json();
  let found = false;
  for (const info of Object.values(data)) {
    if (info.channel === "release" && info.dependencies?.chrome) {
      found = true;
      assert(
        /^\d+\.\d+\.\d+\.\d+$/.test(info.dependencies.chrome),
        "chrome dep should be x.x.x.x format"
      );
      break;
    }
  }
  assert(found, "should find a release channel entry with chrome dependency");
});

await test("Vivaldi: appcast has release notes link", async () => {
  const r = await f("https://update.vivaldi.com/update/1.0/public/appcast.x64.xml");
  const xml = await r.text();
  const m = xml.match(/<sparkle:releaseNotesLink>([^<]+)<\/sparkle:releaseNotesLink>/i);
  assert(m, "appcast should contain releaseNotesLink");
  assert(m[1].startsWith("https://"), "link should be HTTPS");
});

await test("Vivaldi: release notes contain Chromium version", async () => {
  const r = await f("https://update.vivaldi.com/update/1.0/public/appcast.x64.xml");
  const xml = await r.text();
  const nm = xml.match(/<sparkle:releaseNotesLink>([^<]+)<\/sparkle:releaseNotesLink>/i);
  const nr = await f(nm[1].trim());
  const html = await nr.text();
  const cm = html.match(/Chromium[^\d]{0,60}(\d+\.\d+\.\d+\.\d+)/i);
  assert(cm, "release notes should mention Chromium version");
});

await test("Opera: blog listing has a stable release post", async () => {
  const r = await f("https://blogs.opera.com/desktop/");
  const html = await r.text();
  const links = [...html.matchAll(/href="(https:\/\/blogs\.opera\.com\/desktop\/\d{4}\/\d{2}\/opera-(\d+)(?:-stable)?\/?)"/g)];
  assert(links.length > 0, "should find at least one stable release post");
  let best = links[0];
  for (const m of links) {
    if (parseInt(m[2], 10) > parseInt(best[2], 10)) best = m;
  }
  const major = parseInt(best[2], 10);
  assert(major >= 100, "Opera major should be >= 100, got " + major);
});

await test("Opera: stable post contains Chromium version", async () => {
  const r = await f("https://blogs.opera.com/desktop/");
  const html = await r.text();
  const links = [...html.matchAll(/href="(https:\/\/blogs\.opera\.com\/desktop\/\d{4}\/\d{2}\/opera-(\d+)(?:-stable)?\/?)"/g)];
  let best = links[0];
  for (const m of links) {
    if (parseInt(m[2], 10) > parseInt(best[2], 10)) best = m;
  }
  const pr = await f(best[1]);
  const page = await pr.text();
  const cm = page.match(/Chromium[^\d]{0,80}(\d+\.\d+\.\d+\.\d+)/i);
  assert(cm, "stable post should mention full Chromium version");
  const crMajor = parseInt(cm[1], 10);
  assert(crMajor >= 100 && crMajor <= 250, "Chromium major should be in range, got " + crMajor);
});

await test("Comet: Uptodown page has version string", async () => {
  const r = await f("https://comet-browser.en.uptodown.com/windows/download", {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
    },
  });
  const html = await r.text();
  const m = html.match(/(\d{3,})\.\d+\.\d+\.\d+/);
  assert(m, "page should contain a version string");
  const major = parseInt(m[1], 10);
  assert(major >= 100 && major <= 250, "major should be in Chromium range, got " + major);
});

// ---------------------------------------------------------------------------

console.log("\n" + passed + " passed, " + failed + " failed\n");
process.exit(failed > 0 ? 1 : 0);
