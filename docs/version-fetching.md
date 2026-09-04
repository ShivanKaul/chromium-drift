# How each version is fetched

## Live fetchers

Chromium versions for these browsers are fetched live on page load. The fetching logic lives in [`lib/fetchers.js`](https://github.com/ShivanKaul/chromium-drift/blob/main/lib/fetchers.js).

### Chrome Stable

Calls the [Chrome Version History API](https://developer.chrome.com/docs/web-platform/versionhistory/guide) for macOS stable releases. The response includes the currently served builds and their rollout `fraction`; the fetcher selects the build with the highest served fraction and uses the highest version when fractions are tied. This avoids mistaking an early rollout for the current stable release.

### Brave Release

Fetches `versions.brave.com/latest/brave-versions.json`, finds the first entry with `channel === "release"`, and reads `dependencies.chrome` for the Chromium version.

### Edge Stable

Calls `edgeupdates.microsoft.com/api/products`, filters for the "Stable" product and a macOS release.

### Perplexity Comet

Queries Comet's Omaha update API at `perplexity.ai/rest/browser/update2` for Windows. This is the same protocol Comet's built-in updater uses to check for new versions. Credit to this [Hacker News comment](https://news.ycombinator.com/item?id=48001204) for the idea.

```bash
JSON='{"request":{"protocol":"4.0","os":{"platform":"mac","arch":"arm64"},"apps":[{"appid":"{42e10078-e377-4166-965f-c14ad958a146}","version":"0.0.0.0","updatechecks":[{}]}]}}'
curl -s -X POST "https://www.perplexity.ai/rest/browser/update2" \
  -H "Content-Type: application/json" \
  -d "$JSON" | sed "s/^)]}'//" | jq -r '.response.apps[0].updatecheck.nextversion'
```

### Arc

Fetches the Sparkle appcast at `releases.arc.net/updates.xml`. Arc is in maintenance mode (Chromium security patches only), so release descriptions typically contain the full Chromium version. Some releases omit it (linking to the release-notes page instead), so the fetcher scans items newest-to-oldest and uses the most recent one that names a Chromium version.

Possible future fallback: the release-notes page is a Zendesk help center whose HTML is behind a Cloudflare bot wall (403), but its JSON API is reachable without a browser, e.g. `https://resources.arc.net/api/v2/help_center/en-us/articles/20498293324823.json`. The Chromium version can be extracted from `article.body`. We can consider this if future Arc release notes on `updates.xml` don't contain the Chromium version on bump.

## CI-detected versions

Chromium versions for these are extracted from local binaries. The CI is run daily via GitHub Actions via the [`update-versions.js`](https://github.com/ShivanKaul/chromium-drift/blob/main/.github/update-versions.js) script and the results are stored in `ci-versions.json`:

### Vivaldi Stable

Downloads the Vivaldi Linux .deb package, extracts the `vivaldi-bin` binary, and uses `strings` to find the embedded Chromium version.

### Opera Stable

Downloads the Opera Linux .deb package, extracts the `opera` binary, and uses `strings` to find the embedded `Chrome/X.X.X.X` UA string.

### Dia

Fetches the Sparkle appcast at `releases.diabrowser.com/BoostBrowser-updates.xml` to find the latest ZIP URL, downloads the macOS ZIP, extracts the app binary using 7z, and runs `strings` to find the embedded `Chrome/X.X.X.X` UA string.

### Helium

Tracks the Chromium version that corresponds to **shipped Linux builds**, not only the [`imputnet/helium`](https://github.com/imputnet/helium) core repo tag:

1. `GET api.github.com/repos/imputnet/helium-linux/releases/latest` for [`helium-linux` releases](https://github.com/imputnet/helium-linux/releases).

2. Read `tag_name` from that release JSON.

3. Read the `helium-chromium` submodule entry at `GET .../contents/helium-chromium?ref={tag_name}`.

4. Use that entry's `sha` (which points at the subtree in `imputnet/helium`) to fetch `raw.githubusercontent.com/imputnet/helium/{submoduleSha}/chromium_version.txt`.
