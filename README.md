# Chromium Version Dashboard

Which Chromium version is each major browser on?

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
| Arc | Full version | Sparkle appcast (live) |
| Dia | Full version | macOS ZIP binary via CI |

## Docs

- [How it works](docs/how-it-works.md): architecture, CI automation, local development
- [How each browser version extraction/fetching is handled](docs/version-fetching.md): live fetching vs. CI-detected versions
