# Intention — Testing & Dev Tooling

This directory holds the automated test suite and a browser-based dev harness
for the Intention extension. The extension ships three byte-identical source
variants (Chrome / Firefox / Apple); the tests load the real source files
unmodified and assert their behavior.

## Setup

```bash
npm install
```

Node 18+ is required (the loader uses `node:vm` and `structuredClone`).

## How the tests load the source

The extension source files attach functions/consts to the global scope (no
`module.exports` / `export`) and must stay identical across the three variants
(enforced by `build.sh` and `.github/workflows/ci.yml`). So the tests **do not**
import them and **do not** modify them. Instead, [`load.js`](./load.js) reads a
source file and evaluates it inside a `node:vm` context with injected mocks for
`chrome` (incl. an in-memory `chrome.storage.local`) and `fetch`, then reads the
resulting functions/consts back off the context. See `loadPrompts`,
`loadTracking`, `loadProviders`, `makeMockChrome`, `makeMockFetch`.

## Running tests

```bash
npm test          # vitest run (one-shot)
npm run test:watch # vitest watch mode
```

Test files:

- `prompts.test.js` — prompt composition, `{{placeholder}}` substitution
  (incl. stripping unknown keys to empty), per-`changeType` settings prompts,
  tool schemas.
- `tracking.test.js` — `dateKey`/`daysAgoKeys`, `recordGrant`,
  `recordSessionMinutes`, `getStatsForDomain`/`getStatsSummary` aggregation,
  backed by the mock `chrome.storage.local`.
- `providers.test.js` — request shape + response parsing for Anthropic,
  OpenAI-compatible (OpenAI/Groq), and Gemini, plus `callLLM` dispatch, backed
  by the mock `fetch`.
- `parity.test.js` — loads `prompts.js` and `tracking.js` from **all three**
  variant directories and asserts identical behavior (a sync guard on top of
  the byte-diff check in CI/build).

## Overlay dev harness

A standalone page to iterate on the coaching overlay UI without loading the
extension. It renders the same `#intention-root` markup content.js produces,
loads each variant's **real** `content.css`, and drives it with a mock `chrome`
and a fake LLM. Includes a side-by-side mode to compare the three variants'
`content.css` visually.

```bash
npm run harness   # serves tests/harness on http://localhost:8080
```

Open <http://localhost:8080>. Use the toolbar to switch variant / mode (gate
vs. check-in), reload the overlay, or toggle the 3-up comparison view.

## Live-loading the extension in a browser

### Chrome (and Chromium-based browsers)

```bash
npm run dev:chrome    # web-ext run --target chromium --source-dir "Intention Chrome"
```

This auto-launches Google Chrome with a fresh profile, loads the unpacked
extension, and reloads it on source changes. (web-ext auto-detects Chrome; pass
`--chromium-binary "<path>"` if yours is in a non-standard location.)

Prefer to load it by hand instead? `npm run dev:chrome:manual` prints these steps:

1. Open `chrome://extensions`
2. Enable **Developer mode** (top-right)
3. Click **Load unpacked**
4. Select the **`Intention Chrome`** folder in this repo
5. After any source change, click the reload icon on the card

### Firefox (Desktop)

Requires Firefox installed (`brew install --cask firefox`). Then:

```bash
npm run dev:firefox   # web-ext run --source-dir "Intention Firefox"
```

This launches Firefox with the extension temporarily installed and auto-reloads
on source changes.

### Safari (macOS + iOS) via Xcode

1. Open `Intention Apple/Intention Safari.xcodeproj` in Xcode.
2. Pick a macOS or iOS target and hit **Run**.
3. Enable **Intention** in Safari → Settings → Extensions (iOS: Settings → Apps
   → Safari → Extensions).

To regenerate the wrapper from the latest Chrome sources:

```bash
xcrun safari-web-extension-converter "./Intention Chrome" --project-location . --app-name "Intention Safari"
```

## CI

`.github/workflows/ci.yml` runs `npm ci && npm test` before the JSON/JS/sync
validation. `build.sh` also runs `npm test` in its preflight when Node and
`node_modules` are available.
