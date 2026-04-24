# Chromium Version Dashboard

A dashboard that shows which Chromium version each major browser is currently shipping. Chrome Stable is used as the baseline; other browsers are color-coded by how many major versions behind they are. >=1 version behind lists up as a warning.

Hosted on Cloudflare Pages.

## Tracked browsers

| Browser | Precision | Source |
|---|---|---|
| Chrome Stable (baseline) | Full version | ChromiumDash API |
| Brave Release | Full version | versions.brave.com |
| Vivaldi Release | Full version | Sparkle appcast + release notes |
| Edge | Major only | Microsoft Edge Updates API |
| Opera | Full version | Opera Desktop blog scraping |
| Perplexity Comet | Major only | Uptodown.com version string |

### How each version is fetched

**Chrome Stable**: Calls `chromiumdash.appspot.com/fetch_releases` for the latest Windows stable release. The JSON response includes the full version and milestone directly.

**Brave Release**: Fetches `versions.brave.com/latest/brave-versions.json`, finds the first entry with `channel === "release"`, and reads `dependencies.chrome` for the Chromium version.

**Vivaldi Release**: Two-step. First fetches the Sparkle appcast XML at `update.vivaldi.com` to get the release notes URL. Then fetches that HTML page and regex-matches the Chromium version string (e.g., "[Chromium] Updated to 146.0.7680.211").

**Edge**: Calls `edgeupdates.microsoft.com/api/products`, filters for the "Stable" product and a Windows x64 release. Edge and Chromium share the same major version number, so the Edge version major is the Chromium major. Full Chromium build numbers differ, so only the major is reported.

**Opera**: Two-step, similar to Vivaldi. First fetches the Opera Desktop blog listing at `blogs.opera.com/desktop/` to find the latest major stable release post. Then fetches that post and regex-matches the Chromium version string (e.g., "based on the Chromium version: 146.0.7680.178").

**Perplexity Comet**: Fetches Uptodown's download page for Comet. Comet's version string uses the Chromium major as its first component (e.g., `145.2.7632.5936` = Chromium 145). No first-party API exists.

## How it works

`index.html` is a static page that calls `/api` on load. `/api` is a Cloudflare Pages Function (`functions/api.js`) that fetches version data from each browser's public endpoint in parallel and returns JSON.

Responses are cached at the Cloudflare edge for 30 minutes (`s-maxage=1800`) and in the browser for 5 minutes (`max-age=300`). The "Refresh" button appends a cache-busting query parameter.

## Local development

```bash
npx wrangler pages dev .
```
