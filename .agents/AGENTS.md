# Project Rules

This file defines custom rules and guidelines for AI agents working in this repository.

## Overview

**Intention** is a browser extension that puts an AI coach between you and distracting websites. It supports Chrome, Firefox, and Safari (macOS + iOS). There is no build system, bundler, or `package.json` — everything is vanilla JavaScript, HTML, and CSS (Manifest V3).

## Repository Layout

```
intention/
├── Intention Chrome/          # Chrome (and Chromium-based browsers)
├── Intention Firefox/         # Firefox (Desktop + Android)
├── Intention Apple/           # Safari wrapper (Xcode project)
│   ├── Shared (Extension)/Resources/   # ← shared web extension source (mirrors Chrome/Firefox)
│   ├── Shared (App)/                   # Native "enable extension" landing page
│   ├── iOS (App)/  /  iOS (Extension)/
│   ├── macOS (App)/ / macOS (Extension)/
│   └── Intention Safari.xcodeproj
├── .github/workflows/         # CI + Release workflows
├── icon.svg / icon_glyph.svg  # Source icons
└── README.md
```

### Key source files (per platform)

| File | Role |
|------|------|
| `manifest.json` | Extension manifest (MV3). Chrome and Firefox differ (gecko settings, background script format). |
| `background.js` | Service worker / background script — LLM calls, alarm management, grant logic. |
| `content.js` | Content script — injects the overlay UI onto blocked pages. Contains a duplicate of `content.css` as an inline `OVERLAY_CSS` JS string constant. |
| `content.css` | Overlay styles (also injected via manifest `content_scripts.css`). |
| `options.html` / `options.css` / `options.js` | Settings page — provider config, blocklist, coaching. |
| `coaching.html` / `coaching.js` | Standalone coaching chat page. Has **inline `<style>` block** that duplicates some overlay CSS. |
| `prompts.js` | System prompt construction for the AI coach. |
| `providers.js` | LLM provider adapters (Anthropic, OpenAI, Groq, Gemini). |
| `tracking.js` | Time-tracking and usage statistics. |

## Critical Rule: Cross-Platform Sync

All source files **except `manifest.json`** must be kept identical across:
- `Intention Chrome/`
- `Intention Firefox/`
- `Intention Apple/Shared (Extension)/Resources/`

The CI workflow enforces this via `diff`. When editing any shared file, **always apply the same change to all three copies**. The two `manifest.json` files differ intentionally (Firefox has `browser_specific_settings.gecko`; Firefox uses `background.scripts[]` array instead of `service_worker`).

## Coding Guidelines

- **No build system.** All files are loaded directly by the browser. Do not introduce bundlers, transpilers, or `package.json` unless explicitly asked.
- **Vanilla JS only.** No frameworks, no TypeScript. Use `const`/`let`, template literals, and modern DOM APIs.
- **Keep code clean, modular, and well-documented.** Follow existing patterns.
- **CSS duplication awareness.** `content.js` contains a full copy of the overlay CSS as the `OVERLAY_CSS` string constant. `coaching.html` contains inline `<style>` blocks with similar styles. When modifying overlay styles, update **both** `content.css` and the `OVERLAY_CSS` constant in `content.js`, and check `coaching.html` inline styles.

## Styling Conventions

- **Font**: Arvo (Google Fonts), with fallback `Georgia, 'Times New Roman', serif`.
- **Design language**: Dark glassmorphic — dark backgrounds (`#0f1115`), light text (`#e7e7ea`), translucent panels, subtle borders (`rgba(255,255,255,0.1)`).
- **Overlay isolation**: The content overlay uses `all: initial` on `#intention-root` and max `z-index` (`2147483647`) to avoid style leakage from host pages.
- **Font loading in content scripts**: Arvo is dynamically injected into host pages via `<link>` elements in `injectOverlayStyle()` (with a guard to prevent duplicates).
- **Options/coaching pages**: Load Arvo via `<link>` tags with `preconnect` hints in the HTML `<head>`.

## Building Locally

Run `./build.sh` from the repo root. It performs pre-flight checks (cross-platform sync, manifest validation, JS syntax) then produces zipped extension packages in `build/`.

| Command | What it builds |
|---------|---------------|
| `./build.sh` | Chrome + Firefox zips |
| `./build.sh --all` | Chrome + Firefox zips + Safari Xcode build |
| `./build.sh --safari` | Safari Xcode build only |

Output: `build/intention-chrome-v{VERSION}.zip`, `build/intention-firefox-v{VERSION}.zip`, and optionally the Safari `.app`.

## CI/CD

### CI (`ci.yml`) — runs on push/PR to `main`
1. Validates JSON manifests with `jq`
2. Checks JS syntax with `node --check`
3. Verifies all required files exist in Chrome and Firefox directories
4. Confirms cross-platform file sync (Chrome ↔ Firefox ↔ Apple)

### Release (`release.yml`) — runs on `v*` tag push
1. Zips `Intention Chrome/` and `Intention Firefox/` with versioned filenames
2. Creates a GitHub Release with auto-generated notes and both zips as assets

**To release**: `git tag v2.0.1 && git push origin v2.0.1`

## Environment & Secrets

- API keys are stored in `env.txt` (gitignored). See `.env.template` for the expected format.
- The extension uses `chrome.storage.local` at runtime; `env.txt` is only for development/testing.

## Apple-Specific Notes

- The `Shared (App)/` directory is a native landing page ("enable the extension") using system fonts and a strict CSP (`default-src 'self'`). It does not use Arvo or external fonts.
- To regenerate the Safari wrapper from Chrome sources: `xcrun safari-web-extension-converter "./Intention Chrome" --project-location . --app-name "Intention Safari"`
