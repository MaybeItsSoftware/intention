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

A context that loads more than one file — `loadBackground`, `loadPrompts`,
`loadBilling`, and the options/content loaders — gets each file evaluated as
its **own** script into the **same** context, which is exactly what the browser
does with `importScripts` and a page's `<script>` tags: one shared global
scope, but every file keeps its own identity. `filesForContext(context)` reads
that list out of the shipped manifest or HTML, and `evaluateScripts` runs it.
(`bundleForContext` still joins the same files into one string, for the tests
that assert about the source *text* rather than running it.)

Each script is evaluated under its real path as a `file:` URL, because that is
what V8 keys coverage to — see "Coverage" below.

`loadBackground` also hands back the registered alarm and tab-removal listeners
so tests can fire them like the browser would.

## Running tests

```bash
npm test           # vitest run (one-shot)
npm run test:watch # vitest watch mode
npm run test:coverage # with coverage, and the thresholds enforced
```

## Coverage

`vitest.config.js` holds the setup and the reasoning. The short version: the
source is evaluated in `vm` contexts rather than imported, so it only appears
in the report because every script is run under its own `file:` URL — with a
bare path (or as one concatenated bundle) V8's records cannot be resolved back
to a file, and the whole extension reads as 0% covered while the suite drives
it. What is measured is `Intention Chrome/*.js` (the variant the tests run,
byte-identical to `shared/`) plus `server/src`. Thresholds are a floor set just
under the current number; raise them when it rises.

`npm run test:coverage` writes a browsable report to `coverage/index.html`.

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
- `background.test.js` — session/chat-history/alarm keying (`sessionKeyFor`,
  `activeSession`), the check-in alarm, and the `mutateStorage` queue that
  keeps concurrent read-modify-write cycles from clobbering each other. Covers
  both sender shapes: `{tab:{id}}` from the extensions, and the tab-less sender
  the native hosts send (Android's `BackgroundJsHelper`, iOS's
  `BackgroundJSHost`) — which nothing else in the suite can exercise.
- `server.test.js` — the backend (`server/`): entitlement tokens, the verify/
  refresh/redeem routes, the daily quota, and the coaching proxy's validation.
  Store verification is injected, so it needs no network or credentials.
- `gate-conversation.test.js` — `gate-ui.js`'s `createGateConversation`: the
  loop both gate hosts run. What the user sees when a reply lands, fails,
  times out, comes back locked, or is superseded by a newer one. The two hosts
  differ only in the `host` object they pass in, which is the seam these tests
  drive.
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

## Smoke test (a real browser, a real block)

```bash
npm run test:smoke          # headless
npm run test:smoke:headed   # watch it happen, and print the real system prompt
```

`tests/smoke/gate.smoke.mjs` loads the actual `Intention Chrome` directory as
an unpacked extension in Playwright's Chromium, configures it through the
extension's own `saveSettings` message, and navigates to a genuinely blocked
site. Everything the vitest suite cannot answer lives here: whether the
redirect rule is really registered, whether the gate actually replaces the
page, and — since the blocked page never loads on that path — whether the
background can still tell the coach *which* page it was.

The only thing faked is the LLM: the extension's `backendUrl` is pointed at a
local stub, which answers in the hosted route's shape (replies scriptable per
request, including tool calls) and captures the exact requests — the
cache-split `system` block array included — for assertions. No provider is
called and no credit is spent. One browser session walks the whole arc: the
gate opening the conversation itself (the marker opener request), a walk-away
(the moment, the closed tab, the recorded stat, and the prompt naming it on
the next visit), a same-day reopen replaying history with no second opener, a
`note_observation` landing in the coach's memory and resurfacing in the next
prompt, and a `grant_access` redirecting back to the site — with latency
guards on reply render and redirect.

`--print-prompt` dumps that captured prompt. It is the only way to see what the
coach is actually sent, and worth reading after any change to `prompts.js` —
two defects (a usage line reporting the cap where it claimed to report minutes,
and an empty `"Earlier today you came here for ……"`) were found that way and by
no test.

Not part of `npm test`: it needs a browser and network access. Run it before
shipping prompt or gating changes.

## CI

`.github/workflows/ci.yml` runs `npm ci`, `npm run lint` and
`npm run test:coverage` before the JSON/JS/sync validation, then the Playwright
smoke suite and the Android/Apple compiles in their own jobs. The coverage
report is kept as a build artefact. `build.sh` also runs `npm test` in its
preflight when Node and `node_modules` are available.
