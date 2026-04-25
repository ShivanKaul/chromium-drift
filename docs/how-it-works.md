# How it works

`index.html` is a static page that calls `/api` on load. `/api` is a Cloudflare Pages Function (`functions/api.js`) that returns version data as NDJSON. Some browser versions are fetched live from public APIs/feeds or scraped from websites. Others are read from `ci-versions.json`, which is updated daily by GitHub Actions. Manual overrides in `manual-versions.json` take priority over both.

See [version-fetching.md](version-fetching.md) for details on how each browser is handled.

## CI automation

A GitHub Actions workflow (`.github/workflows/update-versions.yml`) runs daily. It downloads browser binaries, extracts the Chromium version using `strings` or plist extraction, writes the results to `ci-versions.json`, and commits if anything changed. Can also be triggered manually via `workflow_dispatch`.

## Local development

```bash
./dev.sh
```
