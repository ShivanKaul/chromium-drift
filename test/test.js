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

await test("Comet Omaha response: extracts version from nextversion field", () => {
  const json = { response: { apps: [{ updatecheck: { nextversion: "145.2.7632.5936" } }] } };
  const ver = json?.response?.apps?.[0]?.updatecheck?.nextversion;
  assert(ver === "145.2.7632.5936", "should extract nextversion");
  assert(parseInt(ver, 10) === 145, "major should be 145");
});

await test("Comet Omaha response: strips XSSI prefix", () => {
  const raw = ")]}'\n" + JSON.stringify({ response: { apps: [{ updatecheck: { nextversion: "145.2.7632.5936" } }] } });
  const json = JSON.parse(raw.replace(/^\)\]\}'/, ""));
  const ver = json?.response?.apps?.[0]?.updatecheck?.nextversion;
  assert(ver === "145.2.7632.5936", "should parse after stripping prefix");
});

await test("parseDebFilename: extracts filename from Packages index", () => {
  const text = [
    "Package: foo-browser",
    "Version: 1.0",
    "Filename: pool/main/foo-browser_1.0_amd64.deb",
    "",
    "Package: opera-stable",
    "Version: 130.0.5847.92",
    "Filename: pool/non-free/o/opera-stable/opera-stable_130.0.5847.92_amd64.deb",
    "",
  ].join("\n");
  const blocks = text.split("\n\n");
  let best = null;
  for (const block of blocks) {
    const pkg = block.match(/^Package:\s*(.+)$/m)?.[1];
    if (pkg !== "opera-stable") continue;
    const filename = block.match(/^Filename:\s*(.+)$/m)?.[1];
    if (filename) best = filename;
  }
  assert(best === "pool/non-free/o/opera-stable/opera-stable_130.0.5847.92_amd64.deb", "should find opera filename");
});

await test("parseDebFilename: picks last entry when multiple versions exist", () => {
  const text = [
    "Package: vivaldi-stable",
    "Version: 7.9.3970.55-1",
    "Filename: pool/main/vivaldi-stable_7.9.3970.55-1_amd64.deb",
    "",
    "Package: vivaldi-stable",
    "Version: 7.9.3970.59-1",
    "Filename: pool/main/vivaldi-stable_7.9.3970.59-1_amd64.deb",
    "",
  ].join("\n");
  const blocks = text.split("\n\n");
  let best = null;
  for (const block of blocks) {
    const pkg = block.match(/^Package:\s*(.+)$/m)?.[1];
    if (pkg !== "vivaldi-stable") continue;
    const filename = block.match(/^Filename:\s*(.+)$/m)?.[1];
    if (filename) best = filename;
  }
  assert(best === "pool/main/vivaldi-stable_7.9.3970.59-1_amd64.deb", "should pick the latest version");
});

await test("Chromium version broad search: filters by third component > 1000", () => {
  const candidates = [
    "109.236.119.2",   // IP address
    "127.0.0.1",       // localhost
    "146.0.7680.211",  // Chromium version
    "146.0.3856.109",  // Vivaldi internal version
    "185.228.168.10",  // IP address
  ].filter((v) => {
    const parts = v.split(".");
    return parts.length === 4 && parseInt(parts[2], 10) > 1000;
  });
  assert(candidates.length === 2, "should find 2 candidates (7680 and 3856)");
  assert(candidates.includes("146.0.7680.211"), "should include Chromium version");
});

await test("Atlas plist parsing: extracts CFBundleShortVersionString", () => {
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>Atlas</string>
  <key>CFBundleShortVersionString</key>
  <string>147.0.7727.24</string>
  <key>CFBundleSignature</key><string>CGPT</string>
</dict></plist>`;
  const m = plist.match(/<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/);
  assert(m, "regex should match");
  assert(m[1].trim() === "147.0.7727.24", "should extract version");
});

await test("Atlas Sparkle appcast: extracts DMG URL from highest build", () => {
  const xml = `<rss><channel>
    <item><sparkle:version>20260101000000000</sparkle:version>
      <enclosure url="https://example.com/old.dmg"/></item>
    <item><sparkle:version>20260416164957000</sparkle:version>
      <enclosure url="https://example.com/latest.dmg"/></item>
    <item><sparkle:version>20260201000000000</sparkle:version>
      <enclosure url="https://example.com/mid.dmg"/></item>
  </channel></rss>`;
  const items = [...xml.matchAll(
    /<item>[\s\S]*?<sparkle:version>(\d+)<\/sparkle:version>[\s\S]*?url="([^"]+\.dmg)"[\s\S]*?<\/item>/g
  )];
  assert(items.length === 3, "should find 3 items");
  items.sort((a, b) => Number(b[1]) - Number(a[1]));
  assert(items[0][2] === "https://example.com/latest.dmg", "should pick highest build");
});

await test("CI/manual override priority: manual overrides CI", () => {
  const overrides = { opera: { chromiumMajor: 999, lastUpdated: "2026-01-01" } };
  const ciVersions = { opera: { chromiumMajor: 146, lastUpdated: "2026-04-24", source: "extracted from Linux .deb binary" } };
  const ov = overrides["opera"];
  const ci = ciVersions["opera"];
  // manual override should win
  const result = ov?.chromiumMajor ? "manual" : ci?.chromiumMajor ? "ci" : "none";
  assert(result === "manual", "manual override should take priority");
});

await test("CI/manual override priority: CI used when no manual override", () => {
  const overrides = { opera: {} };
  const ciVersions = { opera: { chromiumMajor: 146, lastUpdated: "2026-04-24", source: "extracted from Linux .deb binary" } };
  const ov = overrides["opera"];
  const ci = ciVersions["opera"];
  const result = ov?.chromiumMajor ? "manual" : ci?.chromiumMajor ? "ci" : "none";
  assert(result === "ci", "CI version should be used when no manual override");
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

await test("Arc appcast: extracts Chromium version from description", () => {
  const xml = `<rss><channel>
    <item>
      <sparkle:version>79514</sparkle:version>
      <description><![CDATA[This update carries Arc forward to Chromium 147.0.7727.117, patching security vulnerabilities.]]></description>
      <enclosure url="https://releases.arc.net/release/Arc-1.144.0-79514.zip"/>
    </item>
    <item>
      <sparkle:version>79250</sparkle:version>
      <description><![CDATA[This release takes Arc to Chromium 147.0.7727.102.]]></description>
      <enclosure url="https://releases.arc.net/release/Arc-1.143.2-79250.zip"/>
    </item>
  </channel></rss>`;
  const items = [...xml.matchAll(
    /<item>[\s\S]*?<sparkle:version>(\d+)<\/sparkle:version>[\s\S]*?<\/item>/g
  )];
  assert(items.length === 2, "should find 2 items");
  items.sort((a, b) => Number(b[1]) - Number(a[1]));
  assert(items[0][1] === "79514", "should pick highest build");
  const cm = items[0][0].match(/Chromium\s+(\d+\.\d+\.\d+\.\d+)/i);
  assert(cm, "should find Chromium version in description");
  assert(cm[1] === "147.0.7727.117", "should extract correct version");
});

// -- update-versions.js shell safety --

await test("Framework name filter: rejects shell metacharacters", () => {
  const re = /^[\w.-]+\.framework$/;
  // Safe names
  assert(re.test("ArcCore.framework"), "ArcCore.framework should pass");
  assert(re.test("Electron_Framework.framework"), "underscores should pass");
  assert(re.test("lib-core.v2.framework"), "hyphens and dots should pass");
  // Dangerous names
  assert(!re.test('evil"; rm -rf /.framework'), "shell injection should fail");
  assert(!re.test("$(whoami).framework"), "command substitution should fail");
  assert(!re.test("`id`.framework"), "backtick injection should fail");
  assert(!re.test("../../../etc.framework"), "path traversal should fail");
  assert(!re.test("name with spaces.framework"), "spaces should fail");
  assert(!re.test(""), "empty string should fail");
});

await test("Framework name filter: rejects names without .framework suffix", () => {
  const re = /^[\w.-]+\.framework$/;
  assert(!re.test("ArcCore"), "no suffix should fail");
  assert(!re.test("ArcCore.dylib"), "wrong suffix should fail");
  assert(!re.test(".framework"), "just suffix should fail (empty base)");
});

await test("Chrome version extraction from strings output: parses correctly", () => {
  const stringsOutput = [
    "some random text",
    "Chrome/147.0.7727.117 Safari/537.36",
    "Mozilla/5.0 Chrome/147.0.7727.117",
    "not a version 999.888.777",
    "Chrome/146.0.7680.211 Safari/537.36",
  ].join("\n");
  const matches = stringsOutput.match(/Chrome\/[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+/g);
  assert(matches, "should find Chrome/ patterns");
  const versions = [...new Set(matches.map(m => m.replace("Chrome/", "")))];
  assert(versions.length === 2, "should find 2 unique versions, got " + versions.length);
  assert(versions.includes("147.0.7727.117"), "should include 147.0.7727.117");
  assert(versions.includes("146.0.7680.211"), "should include 146.0.7680.211");
});

await test("Chrome version extraction from strings output: no match returns null", () => {
  const stringsOutput = "just some random binary text\nno versions here\n";
  const matches = stringsOutput.match(/Chrome\/[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+/g);
  assert(matches === null, "should return null when no Chrome/ patterns found");
});

await test("Dia appcast: extracts ZIP URL from highest build", () => {
  const xml = `<rss><channel>
    <item><version xmlns="http://www.andymatuschak.org/xml-namespaces/sparkle">79000</version>
      <enclosure url="https://releases.diabrowser.com/release/Dia-1.26.0-79000.zip"/>
      <deltas xmlns="http://www.andymatuschak.org/xml-namespaces/sparkle"><enclosure url="https://releases.diabrowser.com/delta/Dia-from-78900-to-79000.delta"/></deltas>
    </item>
    <item><version xmlns="http://www.andymatuschak.org/xml-namespaces/sparkle">79513</version>
      <enclosure url="https://releases.diabrowser.com/release/Dia-1.28.0-79513.zip"/>
    </item>
  </channel></rss>`;
  const items = [...xml.matchAll(
    /<item>[\s\S]*?<(?:sparkle:)?version[^>]*>(\d+)<\/(?:sparkle:)?version>[\s\S]*?url="([^"]+\.zip)"[\s\S]*?<\/item>/g
  )];
  assert(items.length === 2, "should find 2 items");
  items.sort((a, b) => Number(b[1]) - Number(a[1]));
  assert(items[0][2] === "https://releases.diabrowser.com/release/Dia-1.28.0-79513.zip", "should pick highest build ZIP");
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

await test("Comet: Omaha update API returns a version", async () => {
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
  assert(ver, "should have a nextversion");
  const major = parseInt(ver, 10);
  assert(major >= 100 && major <= 250, "major should be in Chromium range, got " + major);
});

await test("Opera: .deb Packages index has opera-stable entry", async () => {
  const r = await f(
    "https://deb.opera.com/opera-stable/dists/stable/non-free/binary-amd64/Packages"
  );
  const text = await r.text();
  assert(text.includes("Package: opera-stable"), "should contain opera-stable package");
  const m = text.match(/Filename:\s*(pool\/non-free\/o\/opera-stable\/[^\n]+\.deb)/);
  assert(m, "should have a .deb filename");
});

await test("Vivaldi: .deb Packages index has vivaldi-stable entry", async () => {
  const r = await f(
    "https://repo.vivaldi.com/archive/deb/dists/stable/main/binary-amd64/Packages"
  );
  const text = await r.text();
  assert(text.includes("Package: vivaldi-stable"), "should contain vivaldi-stable package");
  const m = text.match(/Filename:\s*(pool\/main\/[^\n]+\.deb)/);
  assert(m, "should have a .deb filename");
});

await test("Atlas: Sparkle appcast has DMG enclosure", async () => {
  const r = await f(
    "https://persistent.oaistatic.com/atlas/public/sparkle_public_appcast.xml"
  );
  const xml = await r.text();
  const items = [...xml.matchAll(
    /<item>[\s\S]*?<sparkle:version>(\d+)<\/sparkle:version>[\s\S]*?url="([^"]+\.dmg)"[\s\S]*?<\/item>/g
  )];
  assert(items.length > 0, "should have at least one item with a DMG URL");
  items.sort((a, b) => Number(b[1]) - Number(a[1]));
  assert(items[0][2].startsWith("https://"), "DMG URL should be HTTPS");
});

await test("Arc: Sparkle appcast has Chromium version in description", async () => {
  const r = await f("https://releases.arc.net/updates.xml");
  const xml = await r.text();
  const items = [...xml.matchAll(
    /<item>[\s\S]*?<sparkle:version>(\d+)<\/sparkle:version>[\s\S]*?<\/item>/g
  )];
  assert(items.length > 0, "should have at least one item");
  items.sort((a, b) => Number(b[1]) - Number(a[1]));
  const cm = items[0][0].match(/Chromium\s+(\d+\.\d+\.\d+\.\d+)/i);
  assert(cm, "latest item should mention Chromium version");
  const major = parseInt(cm[1], 10);
  assert(major >= 100 && major <= 250, "Chromium major should be in range, got " + major);
});

await test("Dia: Sparkle appcast has ZIP enclosure", async () => {
  const r = await f("https://releases.diabrowser.com/BoostBrowser-updates.xml");
  const xml = await r.text();
  const items = [...xml.matchAll(
    /<item>[\s\S]*?<(?:sparkle:)?version[^>]*>(\d+)<\/(?:sparkle:)?version>[\s\S]*?url="([^"]+\.zip)"[\s\S]*?<\/item>/g
  )];
  assert(items.length > 0, "should have at least one item with a ZIP URL");
  items.sort((a, b) => Number(b[1]) - Number(a[1]));
  assert(items[0][2].startsWith("https://"), "ZIP URL should be HTTPS");
});

// ---------------------------------------------------------------------------

console.log("\n" + passed + " passed, " + failed + " failed\n");
process.exit(failed > 0 ? 1 : 0);
