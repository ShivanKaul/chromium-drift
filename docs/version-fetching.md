# How each version is fetched

## Live fetchers

Chromium versions for these browsers are fetched live on page load:

### Chrome Stable

Calls `chromiumdash.appspot.com/fetch_releases` for the latest macOS stable release. The JSON response includes the full version and milestone directly.

### Brave Release

Fetches `versions.brave.com/latest/brave-versions.json`, finds the first entry with `channel === "release"`, and reads `dependencies.chrome` for the Chromium version.

### Edge Stable

Calls `edgeupdates.microsoft.com/api/products`, filters for the "Stable" product and a macOS release.

### Perplexity Comet

Scrapes [Uptodown's download page for Comet on Windows](https://comet-browser.en.uptodown.com/windows/download). Comet's version string uses the Chromium major as its first component (e.g., `145.2.7632.5936` = Chromium 145). Perplexity does not publish a version API, update feed (e.g. Sparkle appcast), or any other machine-readable source for Comet's current version. [Comet's own website](https://www.perplexity.ai/download-comet) has no version information either. I also tried downloading Comet and extracting the version in CI (like Vivaldi, Opera, etc.), but Comet's download is behind Cloudflare bot protection, which blocks automated fetches. Uptodown's download page is updated regularly, so using as a fallback.

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
