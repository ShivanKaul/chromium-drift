# Contributing

Thanks for your interest in contributing to Chromium Drift!

## Issues

Bug reports, feature suggestions, and requests to track new browsers are all welcome as [GitHub issues](https://github.com/ShivanKaul/chromium-drift/issues).

## Pull requests

- Every PR must link to an existing GitHub issue. If there isn't one yet, please open an issue first so we can discuss the approach before you write code.
- PRs for bug fixes, improved detection logic, and UI/UX improvements are welcome.
- PRs to add new browsers are **not being accepted right now**. I'm still iterating on how version fetching and the site are structured. Feel free to open an issue to suggest a browser.

## Running locally

```bash
# Dev server (Cloudflare Pages + Functions)
npx wrangler pages dev .

# Tests 
node test/test.js

# Accessibility audit (Lighthouse against a local stubbed /api)
node test/a11y.js
```

The accessibility audit must score 100. It runs in CI, and you can install it as
a pre-commit hook that only fires when `index.html` is staged:

```bash
git config core.hooksPath .githooks
```

Bypass it for a single commit with `SKIP_A11Y=1 git commit ...`.
