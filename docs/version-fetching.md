# How each version is fetched

## Live fetchers

Chromium versions for these browsers are fetched live on page load. The fetching logic lives in [`lib/fetchers.js`](https://github.com/ShivanKaul/chromium-drift/blob/main/lib/fetchers.js).

### Chrome Stable

Calls `chromiumdash.appspot.com/fetch_releases` for the latest macOS stable release. The JSON response includes the full version and milestone directly.

Because Chrome rolls out new stable versions gradually, the dashboard also checks the milestone schedule (`fetch_milestone_schedule`) and waits until the day after the official `stable_date` (in Pacific Time) before treating a new milestone as current. Until then, the previous milestone is shown.

### Brave Release

Fetches `versions.brave.com/latest/brave-versions.json`, finds the first entry with `channel === "release"`, and reads `dependencies.chrome` for the Chromium version.

### Edge Stable

Calls `edgeupdates.microsoft.com/api/products`, filters for the "Stable" product and a macOS release.

### Perplexity Comet

Queries Comet's Omaha update API at `perplexity.ai/rest/browser/update2` for Windows. This is the same protocol Comet's built-in updater uses to check for new versions.

```bash
JSON='{"request":{"protocol":"4.0","os":{"platform":"mac","arch":"arm64"},"apps":[{"appid":"{42e10078-e377-4166-965f-c14ad958a146}","version":"0.0.0.0","updatechecks":[{}]}]}}'
curl -s -X POST "https://www.perplexity.ai/rest/browser/update2" \
  -H "Content-Type: application/json" \
  -d "$JSON" | sed "s/^)]}'//" | jq -r '.response.apps[0].updatecheck.nextversion'
```

### Arc

Fetches the Sparkle appcast at `releases.arc.net/updates.xml`. Arc is in maintenance mode (Chromium security patches only), so every release description contains the full Chromium version.

## CI-detected versions

Chromium versions for these are extracted from local binaries. The CI is run daily via GitHub Actions via the [`update-versions.js`](https://github.com/ShivanKaul/chromium-drift/blob/main/.github/update-versions.js) script and the results are stored in `ci-versions.json`:

### Vivaldi Stable

Downloads the Vivaldi Linux .deb package, extracts the `vivaldi-bin` binary, and uses `strings` to find the embedded Chromium version.

### Opera Stable

Downloads the Opera Linux .deb package, extracts the `opera` binary, and uses `strings` to find the embedded `Chrome/X.X.X.X` UA string.

### ChatGPT Atlas

Fetches the Sparkle appcast to find the latest DMG URL, downloads the DMG, extracts the inner Chromium app's `Info.plist` using 7z, and reads `CFBundleShortVersionString`.

### Dia

Fetches the Sparkle appcast at `releases.diabrowser.com/BoostBrowser-updates.xml` to find the latest ZIP URL, downloads the macOS ZIP, extracts the app binary using 7z, and runs `strings` to find the embedded `Chrome/X.X.X.X` UA string.

### Helium

Tracks the Chromium version that corresponds to **shipped Linux builds**, not only the [`imputnet/helium`](https://github.com/imputnet/helium) core repo tag:

1. `GET api.github.com/repos/imputnet/helium-linux/releases/latest` for [`helium-linux` releases](https://github.com/imputnet/helium-linux/releases).

2. Read `tag_name` from that release JSON.

3. Read the `helium-chromium` submodule entry at `GET .../contents/helium-chromium?ref={tag_name}`.

4. Use that entry's `sha` (which points at the subtree in `imputnet/helium`) to fetch `raw.githubusercontent.com/imputnet/helium/{submoduleSha}/chromium_version.txt`.
