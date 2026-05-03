// update-versions.js -- Detect Chromium versions for browsers that lack
// reliable public APIs, and write the results to manual-versions.json.
//
// Browsers handled:
//   Opera    -- download .deb, run strings on binary
//   Vivaldi  -- download .deb, run strings on binary
//   Atlas    -- download macOS DMG via Sparkle appcast, extract plist
//   Dia      -- download macOS ZIP via Sparkle appcast, run strings on binary
//   Helium   -- fetch latest GitHub release tag, read chromium_version.txt
//
// Requires: Node 20+, p7zip-full (for .deb and Atlas DMG extraction)
// Usage:    node update-versions.js

import { readFileSync, writeFileSync, mkdtempSync, rmSync, readdirSync, statSync } from "node:fs";
import { execSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Recursively find files matching a predicate. Returns an array of absolute paths.
function findFiles(dir, predicate, maxDepth = 10) {
  const results = [];
  function walk(d, depth) {
    if (depth > maxDepth) return;
    let entries;
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = join(d, e.name);
      if (e.isDirectory()) walk(full, depth + 1);
      else if (e.isFile() && predicate(full, e)) results.push(full);
    }
  }
  walk(dir, 0);
  return results;
}

const FETCH_TIMEOUT = 15_000;
const DMG_TIMEOUT = 120_000;
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36";

// Use 7zz (from 7zip package) if available, fall back to 7z (from p7zip-full).
// Ubuntu 22.04+ ships 7zz which has better DMG/HFS+ support.
let SZ;
try { execSync("7zz --help", { stdio: "ignore" }); SZ = "7zz"; }
catch { SZ = "7z"; }

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

// ---------------------------------------------------------------------------
// Helpers for .deb extraction
// ---------------------------------------------------------------------------

// Parse an apt Packages index and return the Filename for the given package.
function parseDebFilename(packagesText, packageName) {
  const blocks = packagesText.split("\n\n");
  let best = null;
  for (const block of blocks) {
    const pkg = block.match(/^Package:\s*(.+)$/m)?.[1];
    if (pkg !== packageName) continue;
    const filename = block.match(/^Filename:\s*(.+)$/m)?.[1];
    if (filename) best = filename; // last match = highest version (apt sorts ascending)
  }
  if (!best) throw new Error(packageName + " not found in Packages index");
  return best;
}

// Download a .deb file to a temp directory and return the path.
async function downloadDeb(url, label) {
  console.log("  Downloading " + label + " .deb...");
  const r = await f(url, {}, DMG_TIMEOUT);
  const buf = Buffer.from(await r.arrayBuffer());
  const tmp = mkdtempSync(join(tmpdir(), label + "-"));
  const path = join(tmp, label + ".deb");
  writeFileSync(path, buf);
  console.log("  Downloaded " + (buf.length / 1024 / 1024).toFixed(1) + " MB");
  return { path, tmp };
}

// Extract data.tar from a .deb using 7z. 7z auto-decompresses xz, so the
// result is always a plain data.tar. Works on both macOS and Linux (unlike
// BSD ar on macOS which can't handle some .deb formats).
function extractDataTar(debPath, tmpDir) {
  const dataDir = join(tmpDir, "deb-data");
  execSync(`${SZ} x -o"${dataDir}" "${debPath}" -y 2>&1`, {
    timeout: 60_000,
  });
  // 7z auto-decompresses xz, so we get data.tar (not data.tar.xz)
  const tarPath = join(dataDir, "data.tar");
  try {
    readFileSync(tarPath, { flag: "r" });
    return tarPath;
  } catch {
    // Fallback: maybe 7z kept it as data.tar.xz
    return join(dataDir, "data.tar.xz");
  }
}

// Compare two dotted version strings (e.g., "147.0.7727.117" > "146.0.7680.201").
function versionCompare(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 4; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

// Tar flag: -J for .xz, nothing for plain .tar
function tarFlag(path) {
  return path.endsWith(".xz") ? "-xJf" : "-xf";
}

// Extract Chrome/X.X.X.X from a binary inside a data.tar.
function extractChromeVersionFromDeb(dataTarPath, binaryPath) {
  const cmd =
    `tar ${tarFlag(dataTarPath)} "${dataTarPath}" --to-stdout "${binaryPath}" 2>&1` +
    ` | strings` +
    ` | grep -oE 'Chrome/[0-9]+\\.[0-9]+\\.[0-9]+\\.[0-9]+'` +
    ` | sort -t/ -k2 -V` +
    ` | tail -1` +
    ` | sed 's/Chrome\\///'`;
  const out = execSync(cmd, { encoding: "utf8", timeout: 60_000 }).trim();
  if (!out) throw new Error("Chrome version not found in binary");
  return out;
}

// Fallback: search for plausible Chromium version strings (major >= 100)
// in the binary, for browsers like Vivaldi that override Chrome/ to their
// own version.
function extractChromeVersionBroadSearch(dataTarPath, binaryPath) {
  const cmd =
    `tar ${tarFlag(dataTarPath)} "${dataTarPath}" --to-stdout "${binaryPath}" 2>&1` +
    ` | strings` +
    ` | grep -oE '\\b1[0-9]{2}\\.[0-9]+\\.[0-9]+\\.[0-9]+\\b'` +
    ` | sort -u`;
  const out = execSync(cmd, { encoding: "utf8", timeout: 60_000 }).trim();
  if (!out) throw new Error("No plausible Chromium version found");

  // Filter for versions that look like Chromium builds (third component > 1000)
  const candidates = out.split("\n").filter((v) => {
    const parts = v.split(".");
    return parts.length === 4 && parseInt(parts[2], 10) > 1000;
  });

  if (!candidates.length) throw new Error("No Chromium-like versions found");

  // Pick the highest version
  candidates.sort((a, b) => {
    const pa = a.split(".").map(Number);
    const pb = b.split(".").map(Number);
    for (let i = 0; i < 4; i++) {
      if (pa[i] !== pb[i]) return pa[i] - pb[i];
    }
    return 0;
  });
  return candidates[candidates.length - 1];
}

// ---------------------------------------------------------------------------
// Browser detectors
// ---------------------------------------------------------------------------

async function detectOpera() {
  console.log("[Opera] Fetching Packages index...");
  const r = await f(
    "https://deb.opera.com/opera-stable/dists/stable/non-free/binary-amd64/Packages"
  );
  const text = await r.text();
  const filename = parseDebFilename(text, "opera-stable");
  const url = "https://deb.opera.com/opera-stable/" + filename;

  const { path, tmp } = await downloadDeb(url, "opera");
  try {
    console.log("  Extracting Chromium version...");
    const dataTar = extractDataTar(path, tmp);
    const ver = extractChromeVersionFromDeb(
      dataTar,
      "./usr/lib/x86_64-linux-gnu/opera-stable/opera"
    );
    console.log("  Found: " + ver);
    return { chromiumVersion: ver, chromiumMajor: parseInt(ver, 10) };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

async function detectVivaldi() {
  console.log("[Vivaldi] Fetching Packages index...");
  const r = await f(
    "https://repo.vivaldi.com/archive/deb/dists/stable/main/binary-amd64/Packages"
  );
  const text = await r.text();
  const filename = parseDebFilename(text, "vivaldi-stable");
  const url = "https://repo.vivaldi.com/archive/deb/" + filename;

  const { path, tmp } = await downloadDeb(url, "vivaldi");
  try {
    console.log("  Extracting Chromium version...");
    const dataTar = extractDataTar(path, tmp);
    const binaryPath = "./opt/vivaldi/vivaldi-bin";

    // Vivaldi overrides Chrome/ with its own version in the UA string,
    // so the standard Chrome/X.X.X.X grep may return Vivaldi's version
    // (e.g., Chrome/7.9.3970.59). Try the standard approach first, and
    // if the major is < 100, fall back to broad search.
    let ver;
    try {
      ver = extractChromeVersionFromDeb(dataTar, binaryPath);
      if (parseInt(ver, 10) < 100) {
        console.log("  Chrome/ version is Vivaldi's own (" + ver + "), using broad search...");
        ver = extractChromeVersionBroadSearch(dataTar, binaryPath);
      }
    } catch {
      console.log("  Standard extraction failed, trying broad search...");
      ver = extractChromeVersionBroadSearch(dataTar, binaryPath);
    }
    console.log("  Found: " + ver);
    return { chromiumVersion: ver, chromiumMajor: parseInt(ver, 10) };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

async function detectAtlas() {
  console.log("[Atlas] Fetching Sparkle appcast...");
  const r = await f(
    "https://persistent.oaistatic.com/atlas/public/sparkle_public_appcast.xml"
  );
  const xml = await r.text();

  // Find the DMG URL from the item with the highest build number.
  // Each <item> has <sparkle:version>BUILD</sparkle:version> and
  // <enclosure url="...dmg" .../>. Pick the highest build.
  const items = [...xml.matchAll(
    /<item>[\s\S]*?<sparkle:version>(\d+)<\/sparkle:version>[\s\S]*?url="([^"]+\.dmg)"[\s\S]*?<\/item>/g
  )];
  if (!items.length) throw new Error("No DMG items in appcast");
  items.sort((a, b) => Number(b[1]) - Number(a[1]));
  const dmgUrl = items[0][2];
  console.log("  DMG URL: " + dmgUrl + " (build " + items[0][1] + ")");

  // Download the DMG
  console.log("  Downloading DMG...");
  const dmgResp = await f(dmgUrl, {}, DMG_TIMEOUT);
  const buf = Buffer.from(await dmgResp.arrayBuffer());
  const tmp = mkdtempSync(join(tmpdir(), "atlas-"));
  const dmgPath = join(tmp, "atlas.dmg");
  writeFileSync(dmgPath, buf);
  console.log("  Downloaded " + (buf.length / 1024 / 1024).toFixed(1) + " MB");

  try {
    // Extract with 7z. DMGs often have nested layers: DMG -> HFS -> files.
    // First, list contents to find the inner plist path.
    const extractDir = join(tmp, "extracted");

    // Step 1: extract the DMG (may produce an HFS image or files directly).
    // 7z may exit non-zero due to "Dangerous link path" warnings from macOS
    // installer symlinks (e.g., /Applications). This is harmless; the actual
    // files are still extracted.
    try {
      execSync(`${SZ} x -o"${extractDir}" "${dmgPath}" -y 2>&1`, {
        timeout: 60_000,
      });
    } catch (e) {
      // Only tolerate "Dangerous link path" errors
      const out = (e.stdout || e.stderr || "").toString();
      if (!out.includes("Dangerous link path")) throw e;
    }

    // Step 2: find and extract from HFS image if present
    const PLIST_SUFFIX = "/Support/ChatGPT Atlas.app/Contents/Info.plist";
    let plistContent;
    try {
      // Try to find the plist directly (if 7z extracted files)
      let plistPaths = findFiles(extractDir, (p) => p.endsWith(PLIST_SUFFIX));
      let plistPath = plistPaths[0] || null;

      if (!plistPath) {
        // Look for HFS image and extract from it
        const hfsImages = findFiles(extractDir, (p, e) =>
          e.name.endsWith(".hfs") || e.name.endsWith(".img") || e.name === "disk image"
        );
        if (hfsImages[0]) {
          const hfsDir = join(tmp, "hfs");
          spawnSync(SZ, ["x", "-o" + hfsDir, hfsImages[0], "-y"], { timeout: 60_000 });
          plistPaths = findFiles(hfsDir, (p) => p.endsWith(PLIST_SUFFIX));
          plistPath = plistPaths[0] || null;
        }

        // Also try: 7z may extract a numbered file like "2.hfs" or similar
        if (!plistPath) {
          const topEntries = readdirSync(extractDir, { withFileTypes: true });
          const largeFile = topEntries
            .filter((e) => e.isFile())
            .map((e) => {
              const full = join(extractDir, e.name);
              try { return { path: full, size: statSync(full).size }; } catch { return null; }
            })
            .filter((e) => e && e.size > 1024 * 1024)
            .sort((a, b) => b.size - a.size)[0];
          if (largeFile) {
            const hfsDir = join(tmp, "hfs2");
            spawnSync(SZ, ["x", "-o" + hfsDir, largeFile.path, "-y"], { timeout: 60_000 });
            plistPaths = findFiles(hfsDir, (p) => p.endsWith(PLIST_SUFFIX));
            plistPath = plistPaths[0] || null;
          }
        }
      }

      if (!plistPath) throw new Error("Info.plist not found in DMG");
      plistContent = readFileSync(plistPath, "utf8");
    } catch (e) {
      throw new Error("Failed to extract plist from DMG: " + e.message);
    }

    // Parse CFBundleShortVersionString from the XML plist
    const m = plistContent.match(
      /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/
    );
    if (!m) throw new Error("CFBundleShortVersionString not found in plist");
    const ver = m[1].trim();

    // Validate it looks like a Chromium version
    if (!/^\d+\.\d+\.\d+\.\d+$/.test(ver)) {
      throw new Error("Unexpected version format: " + ver);
    }
    console.log("  Found: " + ver);
    return { chromiumVersion: ver, chromiumMajor: parseInt(ver, 10) };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

async function detectDia() {
  console.log("[Dia] Fetching Sparkle appcast...");
  const r = await f("https://releases.diabrowser.com/BoostBrowser-updates.xml");
  const xml = await r.text();

  // Each <item> has a version element and <enclosure url="...zip" .../>.
  // Version tag may be <sparkle:version> or <version xmlns="...">.
  const items = [...xml.matchAll(
    /<item>[\s\S]*?<(?:sparkle:)?version[^>]*>(\d+)<\/(?:sparkle:)?version>[\s\S]*?url="([^"]+\.zip)"[\s\S]*?<\/item>/g
  )];
  if (!items.length) throw new Error("No ZIP items in appcast");
  items.sort((a, b) => Number(b[1]) - Number(a[1]));
  const zipUrl = items[0][2];
  console.log("  ZIP URL: " + zipUrl + " (build " + items[0][1] + ")");

  // Download the ZIP
  console.log("  Downloading ZIP...");
  const zipResp = await f(zipUrl, {}, DMG_TIMEOUT);
  const buf = Buffer.from(await zipResp.arrayBuffer());
  const tmp = mkdtempSync(join(tmpdir(), "dia-"));
  const zipPath = join(tmp, "dia.zip");
  writeFileSync(zipPath, buf);
  console.log("  Downloaded " + (buf.length / 1024 / 1024).toFixed(1) + " MB");

  try {
    // Extract with 7z
    const extractDir = join(tmp, "extracted");
    execSync(`${SZ} x -o"${extractDir}" "${zipPath}" -y 2>&1`, {
      timeout: 120_000,
    });

    // The real Chrome version is in a framework binary, not the main
    // executable (which contains stale Chrome/ strings). Dia uses
    // ArcCore.framework. Check each .framework for Chrome/ strings and
    // pick the highest valid Chromium version (third component > 1000).
    const fwDir = join(extractDir, "Dia.app", "Contents", "Frameworks");
    const fwEntries = readdirSync(fwDir).filter(e => e.endsWith(".framework"));
    if (!fwEntries.length) throw new Error("No frameworks found in app bundle");

    let ver;
    for (const fw of fwEntries) {
      if (!/^[\w.-]+\.framework$/.test(fw)) continue;
      const fwName = fw.replace(".framework", "");
      const binaryPath = join(fwDir, fw, fwName);
      try { readFileSync(binaryPath, { flag: "r" }); } catch { continue; }
      console.log("  Checking: " + fw);
      const result = spawnSync("strings", [binaryPath], { encoding: "utf8", timeout: 60_000, maxBuffer: 50 * 1024 * 1024 });
      if (result.status !== 0) continue;
      const matches = result.stdout.match(/Chrome\/[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+/g);
      if (!matches) continue;
      const out = [...new Set(matches.map(m => m.replace("Chrome/", "")))].join("\n");
      if (!out) continue;
      const candidates = out.split("\n").filter((v) => {
        const parts = v.split(".");
        return parts.length === 4 &&
          parseInt(parts[0], 10) >= 100 &&
          parseInt(parts[2], 10) > 1000;
      });
      for (const c of candidates) {
        if (!ver || versionCompare(c, ver) > 0) ver = c;
      }
    }

    if (!ver) throw new Error("Chrome version not found in binary");
    console.log("  Found: " + ver);
    return { chromiumVersion: ver, chromiumMajor: parseInt(ver, 10) };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

async function detectHelium() {
  console.log("[Helium] Fetching latest GitHub release...");
  const ghHeaders = {
    "User-Agent": "chromium-drift/1.0",
    "Accept": "application/vnd.github+json",
  };
  const r = await f("https://api.github.com/repos/imputnet/helium/releases/latest", { headers: ghHeaders });
  const release = await r.json();
  const tag = release.tag_name;
  if (!tag) throw new Error("no tag_name in release");
  console.log("  Latest release tag: " + tag);

  const vr = await f("https://raw.githubusercontent.com/imputnet/helium/" + tag + "/chromium_version.txt");
  const ver = (await vr.text()).trim();
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(ver)) throw new Error("invalid version format: " + ver);
  const major = parseInt(ver, 10);
  if (major < 100 || major > 250) throw new Error("major out of range: " + major);
  console.log("  Found: " + ver);
  return { chromiumVersion: ver, chromiumMajor: major };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const browsers = [
  { key: "opera", name: "Opera Stable", detect: detectOpera, source: "extracted from Linux .deb binary" },
  { key: "vivaldi", name: "Vivaldi Stable", detect: detectVivaldi, source: "extracted from Linux .deb binary" },
  { key: "atlas", name: "ChatGPT Atlas", detect: detectAtlas, source: "extracted from macOS DMG plist" },
  { key: "dia", name: "Dia", detect: detectDia, source: "extracted from macOS ZIP binary" },
  { key: "helium", name: "Helium", detect: detectHelium, source: "GitHub release chromium_version.txt" },
];

const jsonPath = new URL("../ci-versions.json", import.meta.url).pathname;
const data = JSON.parse(readFileSync(jsonPath, "utf8"));
const today = new Date().toISOString().slice(0, 10);

let changed = false;
let failures = 0;

for (const { key, name, detect, source } of browsers) {
  try {
    const result = await detect();
    const prev = data[key] || {};
    if (
      prev.chromiumMajor === result.chromiumMajor &&
      (prev.chromiumVersion || null) === (result.chromiumVersion || null)
    ) {
      console.log("[" + name + "] No change (Chromium " + result.chromiumMajor + ")\n");
      continue;
    }
    // Reject version regressions (likely a detection bug)
    if (prev.chromiumMajor) {
      const regressed = prev.chromiumVersion && result.chromiumVersion
        ? versionCompare(result.chromiumVersion, prev.chromiumVersion) < 0
        : result.chromiumMajor < prev.chromiumMajor;
      if (regressed) {
        throw new Error(
          "detected Chromium " + (result.chromiumVersion || result.chromiumMajor) +
          " is older than current " + (prev.chromiumVersion || prev.chromiumMajor)
        );
      }
    }
    const entry = { chromiumMajor: result.chromiumMajor, lastUpdated: today, source };
    if (result.chromiumVersion) entry.chromiumVersion = result.chromiumVersion;
    data[key] = entry;
    changed = true;
    console.log(
      "[" + name + "] Updated: Chromium " +
      (result.chromiumVersion || result.chromiumMajor) +
      (prev.chromiumMajor ? " (was " + prev.chromiumMajor + ")" : "") +
      "\n"
    );
  } catch (e) {
    console.error("[" + name + "] FAILED: " + e.message);
    if (e.stderr) console.error("  stderr: " + e.stderr.toString().trim());
    if (e.stdout) console.error("  stdout: " + e.stdout.toString().trim());
    console.error("");
    failures++;
  }
}

if (changed) {
  writeFileSync(jsonPath, JSON.stringify(data, null, 2) + "\n");
  console.log("Updated ci-versions.json");
} else {
  console.log("No changes to ci-versions.json");
}

if (failures) {
  console.error(failures + " browser(s) failed");
  process.exit(1);
}
