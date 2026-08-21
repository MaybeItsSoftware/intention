# Project Rules

This file defines custom rules and guidelines for AI agents working in this repository.

## Overview

**Intention** is a browser extension that puts an AI coach between you and distracting websites. It supports Chrome, Firefox, and Safari (macOS + iOS), plus native Android and iOS apps. The extension itself has no build system or bundler — everything shipped to browsers is vanilla JavaScript, HTML, and CSS (Manifest V3). The root `package.json` exists only for deployment tooling (`web-ext` lint/build for Firefox); it is never loaded by the extension and must not grow into a bundler/transpiler setup for app code.

`server/` is the one exception to "no backend": it holds the LLM provider key that Apple's Guideline 3.1.1 requires us to own rather than ask users for. It is dependency-free Node (see `server/README.md`) and is not part of any client build.

## Repository Layout

```
intention/
├── shared/                    # ★ SINGLE SOURCE OF TRUTH for all shared extension code
│   ├── *.js / *.css / *.html  #   edit here, then run scripts/sync.sh
│   ├── fonts/ + icon*.png     #   shared assets
│   ├── billing.js             #   In-App Purchase layer + paywall (page-side only)
│   ├── manifest.base.json     #   common manifest keys (incl. version)
│   └── manifest.{chrome,firefox,apple}.json   # per-platform overlays (merged onto base)
├── Intention Chrome/          # Chrome (generated from shared/ — do not hand-edit shared files)
├── Intention Firefox/         # Firefox (generated from shared/)
├── Intention Apple/           # Safari wrapper (Xcode project)
│   ├── Shared (Extension)/Resources/   # ← generated from shared/
│   ├── Shared (App)/                   # Native "enable extension" landing page
│   ├── iOS (App)/  /  iOS (Extension)/
│   ├── macOS (App)/ / macOS (Extension)/
│   └── Intention Safari.xcodeproj
├── server/                    # Hosted coach backend (receipt verification + LLM proxy)
├── .github/workflows/         # CI + Release + Publish workflows
├── eslint.config.mjs          # Per-file globals, derived from the manifests (see below)
├── scripts/script-contexts.mjs      # Which shared file loads into which context — the one
│                                    #   reader of that, used by eslint AND the tests
├── scripts/check-platform-files.mjs # Every file the manifests load exists everywhere
├── scripts/sync.sh            # Propagates shared/ to all platforms (--check verifies)
├── scripts/bump-version.sh    # Bumps version in shared/manifest.base.json + Xcode + Android
├── icon.svg / icon_glyph.svg  # Source icons
├── package.json               # Dev-only: eslint, vitest, playwright, web-ext
├── PRIVACY.md                 # Privacy policy (linked from store listings)
├── DEPLOYMENT.md              # Store submission guide (secrets, checklist, release flow)
└── README.md
```

### Key source files (per platform)

| File | Role |
|------|------|
| `manifest.json` | Extension manifest (MV3). Chrome and Firefox differ (gecko settings, background script format). |
| `background.js` | Service worker / background script — LLM calls, alarm management, grant logic. |
| `content.js` | Content script — injects the overlay UI onto blocked pages. Contains a duplicate of `content.css` as an inline `OVERLAY_CSS` JS string constant. |
| `content.css` | Overlay styles (also injected via manifest `content_scripts.css`). |
| `options.html` / `options.css` / `options.js` | Settings page shell — tabs, modals, the settings view, stats. |
| `options-wizard.js` | First-run setup: draft state, step order, per-service questions, the save that ends it. |
| `options-rows.js` | The blocked-site / blocked-app row and every control on it. |
| `options-coach.js` | The coach modal (rewriting "about you") and the settings gate. |
| `options-lists.js` | Recommendation grids, app search, the wizard's own site/app lists. |
| `options-access.js` | Coaching credit: purchase, restore, paywall. |
| `coaching.html` / `coaching.js` | Standalone coaching chat page (Android, iOS, and the gate backstop). Has **inline `<style>` block** that duplicates some overlay CSS. |
| `gate-ui.js` | The parts of the gate conversation both hosts share: message bubble, typing reveal, walk-away moment, stats strip. Loaded by the content script AND `coaching.html`. |
| `rules.js` | Resolves a blocked target's rules (mode, behaviour, pass length, lenient window) — pure functions, loaded into **every** context. |
| `prompts.js` | System prompt construction for the AI coach. |
| `providers.js` | LLM provider adapters (Intention's hosted backend, Anthropic, OpenAI, Groq, Gemini) plus `entitlementIsActive()`. |
| `billing.js` | Page-side In-App Purchase layer: store-bridge calls, backend verification, and the paywall renderer. Loaded by `options.html` and `coaching.html`, not by the background worker. |
| `tracking.js` | Time-tracking and usage statistics. |

## Critical Rule: Cross-Platform Sync

`shared/` is the single source of truth for all extension source, assets, and manifests. The platform directories are generated copies:
- `Intention Chrome/`
- `Intention Firefox/`
- `Intention Apple/Shared (Extension)/Resources/`
- `Intention Android/app/src/main/assets/` (shared JS/CSS/HTML + fonts only; keeps its own `android-bridge.js` and `background.html`)

**Edit files in `shared/`, then run `scripts/sync.sh`** to propagate. Never hand-edit the platform copies of shared files — `scripts/sync.sh --check` (run by `build.sh` preflight and CI) fails the build on any drift.

Platform `manifest.json` files are generated by merging `shared/manifest.base.json` with `shared/manifest.<platform>.json` (objects merge recursively, `null` deletes a key, anything else replaces). The intentional differences live in the overlays: Firefox adds `browser_specific_settings.gecko` and uses a `background.scripts[]` array instead of `service_worker`; Apple does the same plus `persistent: false` and no `homepage_url`. To change a manifest, edit the base (common keys) or the relevant overlay, then run `scripts/sync.sh`.

## AI access and In-App Purchase

Guideline 3.1.1 forbids unlocking in-app features with an externally supplied key, so access resolves in `background.js`'s `resolveAIRoute()`:

- `hosted` — a positive coaching-credit balance; calls go to `server/` under Intention's key. **This is the default and the only thing onboarding offers on any build a store reviews.**
- `byok` — a custom API key set in Settings → Advanced. An override, never a starting state.
- `locked` — neither; the paywall replaces the chat and blocking stays on.

Coaching credit is a repurchasable consumable top-up (three tiers, £1/£2/£5), not a subscription — no expiry, no renewal, the balance itself is the only limit. A message's real cost (token usage × model pricing) is deducted from that balance on every `/v1/chat` call; see `server/src/config.js`'s `topUps`/`llm.pricing` and `server/README.md`.

Rules to keep that intact:

- **Never surface a key field, a provider name, or an external link in onboarding, the paywall, or store copy.** `BILLING_MODE` in `billing.js` decides what a build may show; `'store'` and `'managed'` builds must offer coaching credit and nothing else. Chrome/Firefox (`'byok'`) may show the key option, since no store sells anything there.
- Purchases only ever go through the native bridge (`window.intentionBilling` — StoreKit in `IntentionStore.swift`, Play Billing in `BillingManager.kt`). Never add a checkout URL.
- An entitlement is only trusted after the backend verifies the store receipt. The client never decides on its own that someone has paid.

## Coding Guidelines

- **No build system.** All files are loaded directly by the browser. Do not introduce bundlers, transpilers, or `package.json` unless explicitly asked.
- **Vanilla JS only.** No frameworks, no TypeScript. Use `const`/`let`, template literals, and modern DOM APIs.
- **Keep code clean, modular, and well-documented.** Follow existing patterns.
- **`npm run lint` before you finish.** ESLint derives each shared file's allowed globals from the manifests and pages, so `no-undef` is what catches a call into a file your context does not load — the failure mode this architecture makes easy and the browser only reports at runtime. A new shared file must be added to the manifest / page that loads it, or nothing can call it.
- **Resolve a target's rules through `rules.js`, never inline.** Which mode applies to a site, and when the coach turns strict, was once written out in four files held together by "change one, change all three" comments. They had drifted. `tests/rules.test.js` now fails if a copy comes back.
- **CSS duplication awareness.** `content.js` contains a full copy of the overlay CSS as the `OVERLAY_CSS` string constant. `coaching.html` contains inline `<style>` blocks with similar styles. When modifying overlay styles, update **both** `content.css` and the `OVERLAY_CSS` constant in `content.js`, and check `coaching.html` inline styles. `tests/parity.test.js` fails the build if the two copies drift.
- **Shared gate UI.** The message bubble, typing reveal, walk-away moment and stats strip live in `gate-ui.js` and are used by both gate hosts. Change them there, not in `content.js` or `coaching.js` — parity.test.js fails if either redeclares one.

## Styling Conventions

- **Font**: Arvo (Google Fonts), with fallback `Georgia, 'Times New Roman', serif`.
- **Design language**: Dark glassmorphic — dark backgrounds (`#0f1115`), light text (`#e7e7ea`), translucent panels, subtle borders (`rgba(255,255,255,0.1)`).
- **Overlay isolation**: The content overlay uses `all: initial` on `#intention-root` and max `z-index` (`2147483647`) to avoid style leakage from host pages.
- **Font loading in content scripts**: Arvo is dynamically injected into host pages via `<link>` elements in `injectOverlayStyle()` (with a guard to prevent duplicates).
- **Options/coaching pages**: Load Arvo via `<link>` tags with `preconnect` hints in the HTML `<head>`.

## Checking your work

| Command | What it checks |
|---------|----------------|
| `npm run lint` | ESLint. `no-undef` is the load-bearing rule: each shared file's allowed globals come from the manifests and pages, so calling something the manifest does not load alongside you fails here rather than at runtime. |
| `npm test` | The vitest suite (~730 tests, ~3s). |
| `npm run test:smoke` | Playwright against a real Chromium with the extension loaded. Slower, and the only thing that catches a broken page load — run it after touching `content.js`, `coaching.js`, `options*.js` or a `<script>` list. |
| `scripts/sync.sh --check` | Platform copies match `shared/`. |

## Building Locally

Run `./build.sh` from the repo root. It performs pre-flight checks (version sync, cross-platform file sync, manifest validation, JS syntax, `web-ext lint` if `npm install` has been run) then produces zipped extension packages in `build/`.

| Command | What it builds |
|---------|---------------|
| `./build.sh` | Chrome + Firefox zips |
| `./build.sh --all` | Chrome + Firefox zips + Safari Xcode build (macOS only) |
| `./build.sh --safari` | Safari Xcode build only (macOS only) |

Output: `build/intention-chrome-v{VERSION}.zip`, `build/intention-firefox-v{VERSION}.zip`, and optionally the Safari `.app`.

Run `npm install` once to get `web-ext` for Firefox linting (`npm run lint:firefox`) — dev tooling only, not part of the shipped extension.

## Version bumps

`scripts/bump-version.sh <version> [build_number]` updates the version in `shared/manifest.base.json` (regenerating all platform manifests via `scripts/sync.sh`), the Safari Xcode project's `MARKETING_VERSION`/`CURRENT_PROJECT_VERSION`, the Android Gradle config, and `package.json` in one command. Always use it instead of hand-editing versions — `build.sh` and CI both fail the build if the platforms drift out of sync.

## CI/CD

### CI (`ci.yml`) — runs on push/PR to `main`

Four jobs, run in parallel.

**`validate`**
1. `npm run lint` — ESLint, with each shared file's globals derived from the manifests
2. `npm test` — the vitest suite
3. Validates JSON manifests with `jq`
4. Verifies Chrome/Firefox/Safari/Android versions are in sync
5. Checks JS syntax with `node --check`
6. Runs `web-ext lint` against the Firefox extension (AMO validation)
7. `scripts/check-platform-files.mjs` — every file the manifests load exists in all four platform directories
8. Confirms cross-platform file sync (`scripts/sync.sh --check`)

**`smoke`** — the Playwright suite (`npm run test:smoke`) against a real Chromium with the extension loaded. Screenshots are kept as artefacts on failure.

**`android`** / **`apple`** — compile-only builds of the native apps, so a broken Kotlin or Swift change fails on the PR rather than in the publish workflow after a release is cut. Neither needs secrets: Android builds `assembleDebug`, Apple builds with `CODE_SIGNING_ALLOWED=NO`.

### Automated Release (`auto-release.yml`) — runs on push to `main`
1. Analyzes Conventional Commits since the last tag to calculate the next SemVer version.
2. Bumps version strings across files (using `scripts/bump-version.sh`), builds, and packages Chrome + Firefox extension zips.
3. Creates/pushes the Git tag (e.g., `v2.0.1`) and publishes a GitHub Release with both zips and `CHANGELOG.md` as assets.

### Publish (`publish-chrome.yml`, `publish-firefox.yml`, `publish-android.yml`) — each runs automatically on Automated Release completion or manual dispatch
Auto-submits to the Chrome Web Store, Firefox Add-ons (AMO), and Google Play (internal track) respectively, if the relevant repo secrets are configured; each skips gracefully (without failing) otherwise. Being separate workflows, any one store can be retried via `gh workflow run publish-<store>.yml` without re-triggering the others. See `DEPLOYMENT.md` for the secrets needed and first-submission steps for all four stores, including Safari/App Store (which has no CLI-only path).

**To release**: Commit your changes using Conventional Commits and merge/push to the `main` branch. The automated release pipeline will calculate the version bump, tag the commit, update the changelog, and draft the release.


## Environment & Secrets

- API keys are stored in `env.txt` (gitignored). See `.env.template` for the expected format.
- The extension uses `chrome.storage.local` at runtime; `env.txt` is only for development/testing.

## Apple-Specific Notes

- The `Shared (App)/` directory is a native landing page ("enable the extension") using system fonts and a strict CSP (`default-src 'self'`). It does not use Arvo or external fonts.
- To regenerate the Safari wrapper from Chrome sources: `xcrun safari-web-extension-converter "./Intention Chrome" --project-location . --app-name "Intention Safari"`
