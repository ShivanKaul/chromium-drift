# How it works

`index.html` is a static page that calls `/api` on load. `/api` is a Cloudflare Pages Function (`functions/api.js`) that returns version data as NDJSON. Chrome, Edge, Brave, Comet, and Arc are fetched live from public APIs/feeds. Vivaldi, Opera, Atlas, and Dia are read from `ci-versions.json`, which is updated daily by GitHub Actions. Manual overrides in `manual-versions.json` take priority over both.

## CI automation

A GitHub Actions workflow (`.github/workflows/update-versions.yml`) runs daily. It downloads browser binaries, extracts the Chromium version using `strings` (for .deb packages and Dia's macOS ZIP) or plist extraction (for Atlas DMG), writes the results to `ci-versions.json`, and commits if anything changed. Can also be triggered manually via `workflow_dispatch`.

## Local development

I'm hosting the website on Cloudflare Pages.

```bash
./dev.sh
```
