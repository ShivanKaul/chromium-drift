// update-versions.js -- Detect Chromium versions for browsers that lack
// reliable public APIs, and write the results to manual-versions.json.
//
// Browsers handled:
//   Opera    -- download .deb, run strings on binary
//   Vivaldi  -- download .deb, run strings on binary
//   Atlas    -- download macOS DMG via Sparkle appcast, extract plist
//
// Requires: Node 20+, p7zip-full (for .deb and Atlas DMG extraction)
// Usage:    node update-versions.js

import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FETCH_TIMEOUT = 15_000;
const DMG_TIMEOUT = 120_000;
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36";

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
  execSync(`7z x -o"${dataDir}" "${debPath}" -y 2>/dev/null`, {
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

// Tar flag: -J for .xz, nothing for plain .tar
function tarFlag(path) {
  return path.endsWith(".xz") ? "-xJf" : "-xf";
}

// Extract Chrome/X.X.X.X from a binary inside a data.tar.
function extractChromeVersionFromDeb(dataTarPath, binaryPath) {
  const cmd =
    `tar ${tarFlag(dataTarPath)} "${dataTarPath}" --to-stdout "${binaryPath}" 2>/dev/null` +
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
    `tar ${tarFlag(dataTarPath)} "${dataTarPath}" --to-stdout "${binaryPath}" 2>/dev/null` +
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

    // Step 1: extract the DMG (may produce an HFS image or files directly)
    execSync(`7z x -o"${extractDir}" "${dmgPath}" -y 2>/dev/null`, {
      timeout: 60_000,
    });

    // Step 2: find and extract from HFS image if present
    let plistContent;
    try {
      // Try to find the plist directly (if 7z extracted files)
      const findCmd = `find "${extractDir}" -path "*/Support/ChatGPT Atlas.app/Contents/Info.plist" 2>/dev/null | head -1`;
      let plistPath = execSync(findCmd, { encoding: "utf8", timeout: 10_000 }).trim();

      if (!plistPath) {
        // Look for HFS image and extract from it
        const hfsCmd = `find "${extractDir}" -name "*.hfs" -o -name "*.img" -o -name "disk image" 2>/dev/null | head -1`;
        const hfsPath = execSync(hfsCmd, { encoding: "utf8", timeout: 10_000 }).trim();
        if (hfsPath) {
          const hfsDir = join(tmp, "hfs");
          execSync(`7z x -o"${hfsDir}" "${hfsPath}" -y 2>/dev/null`, {
            timeout: 60_000,
          });
          const findCmd2 = `find "${hfsDir}" -path "*/Support/ChatGPT Atlas.app/Contents/Info.plist" 2>/dev/null | head -1`;
          plistPath = execSync(findCmd2, { encoding: "utf8", timeout: 10_000 }).trim();
        }

        // Also try: 7z may extract a numbered file like "2.hfs" or similar
        if (!plistPath) {
          const numberedCmd = `find "${extractDir}" -maxdepth 1 -type f -size +1M 2>/dev/null | head -1`;
          const numberedFile = execSync(numberedCmd, { encoding: "utf8", timeout: 10_000 }).trim();
          if (numberedFile) {
            const hfsDir = join(tmp, "hfs2");
            execSync(`7z x -o"${hfsDir}" "${numberedFile}" -y 2>/dev/null`, {
              timeout: 60_000,
            });
            const findCmd3 = `find "${hfsDir}" -path "*/Support/ChatGPT Atlas.app/Contents/Info.plist" 2>/dev/null | head -1`;
            plistPath = execSync(findCmd3, { encoding: "utf8", timeout: 10_000 }).trim();
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

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const browsers = [
  { key: "opera", name: "Opera", detect: detectOpera, source: "extracted from Linux .deb binary" },
  { key: "vivaldi", name: "Vivaldi", detect: detectVivaldi, source: "extracted from Linux .deb binary" },
  { key: "atlas", name: "Atlas", detect: detectAtlas, source: "extracted from macOS DMG plist" },
];

const jsonPath = new URL("./ci-versions.json", import.meta.url).pathname;
const data = JSON.parse(readFileSync(jsonPath, "utf8"));
const today = new Date().toISOString().slice(0, 10);

let changed = false;

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
    console.error("[" + name + "] FAILED: " + e.message + "\n");
  }
}

if (changed) {
  writeFileSync(jsonPath, JSON.stringify(data, null, 2) + "\n");
  console.log("Updated ci-versions.json");
} else {
  console.log("No changes to ci-versions.json");
}
