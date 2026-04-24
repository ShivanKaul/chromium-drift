# Chromium Version Dashboard

What Chromium version is each major browser on?

https://chromium-version-dashboard.pages.dev

## Tracked browsers

| Browser | Precision | Source |
|---|---|---|
| Chrome Stable (baseline) | Full version | ChromiumDash API (live) |
| Brave Release | Full version | versions.brave.com (live) |
| Edge | Full version | Microsoft Edge Updates API (live) |
| Vivaldi Release | Full version | Linux .deb binary via CI |
| Opera | Full version | Linux .deb binary via CI |
| ChatGPT Atlas | Full version | macOS DMG plist via CI |
| Perplexity Comet | Major only | uptodown.com (live) |

### How each version is fetched

#### Live fetchers 

Chromium versions for these browsers are fetched live on page load:

- **Chrome Stable**: Calls `chromiumdash.appspot.com/fetch_releases` for the latest macOS stable release. The JSON response includes the full version and milestone directly.

- **Brave Release**: Fetches `versions.brave.com/latest/brave-versions.json`, finds the first entry with `channel === "release"`, and reads `dependencies.chrome` for the Chromium version.

- **Edge**: Calls `edgeupdates.microsoft.com/api/products`, filters for the "Stable" product and a macOS release.

- **Perplexity Comet**: Scrapes Uptodown's download page for Comet. Comet's version string uses the Chromium major as its first component (e.g., `145.2.7632.5936` = Chromium 145). No first-party API exists.

#### CI-detected versions 

Chromium versions for these are extracted from local binaries. The CI is run daily via GitHub Actions, results stored in `ci-versions.json`:

- **Vivaldi Release**: Downloads the Vivaldi Linux .deb package, extracts the `vivaldi-bin` binary, and uses `strings` to find the embedded Chromium version. 

- **Opera**: Downloads the Opera Linux .deb package, extracts the `opera` binary, and uses `strings` to find the embedded `Chrome/X.X.X.X` UA string.

- **ChatGPT Atlas**: Fetches the Sparkle appcast to find the latest DMG URL, downloads the DMG, extracts the inner Chromium app's `Info.plist` using 7z, and reads `CFBundleShortVersionString`.

## How it works

`index.html` is a static page that calls `/api` on load. `/api` is a Cloudflare Pages Function (`functions/api.js`) that returns version data as NDJSON. Chrome, Edge, Brave, and Comet are fetched live from public APIs. Vivaldi, Opera, and Atlas are read from `ci-versions.json`, which is updated daily by GitHub Actions. Manual overrides in `manual-versions.json` take priority over both.

### CI automation

A GitHub Actions workflow (`.github/workflows/update-versions.yml`) runs daily. It downloads browser binaries, extracts the Chromium version using `strings` (for .deb packages) or plist extraction (for Atlas DMG), writes the results to `ci-versions.json`, and commits if anything changed. Can also be triggered manually via `workflow_dispatch`.

## Local development

I'm hosting the website on Cloudflare Pages.

```bash
./dev.sh
```
