# Intention

**Intention** is a browser extension and mobile app that puts an AI coach between you and the sites and apps that pull you away from what you actually want to do. Instead of a hard block or a weak timer, every visit is a short conversation: why are you here, is there something you're avoiding, what would actually serve you right now?

The coach runs on **coaching credit**, a one-time top-up bought through the App Store or Google Play — nothing to configure, no keys to fetch, no recurring charge. Developers who would rather point it at their own LLM account can do that instead, from Settings → Advanced.

## Get Intention

* **Firefox**: [Download on the Firefox Add-on Store](https://addons.mozilla.org/en-US/firefox/addon/intentionai/)

* **Chrome**: [Download on the Chrome Web Store](https://chromewebstore.google.com/detail/intention/dbeapcoomlbnpljdnblmegniiacfoeop)


*(Safari and Android versions are currently built/run from source—see details below.)*

## How it works

1. You add sites to a blocklist (e.g. `instagram.com`, `twitter.com`).
2. When you open one, the page is paused and a chat opens. Your coach — the LLM you chose — asks what's up.
3. If you have a real, specific, time-bounded reason, it grants you some minutes. If the reason is hollow ("just checking"), it doesn't — it offers alternatives instead, drawn from what it knows about you.
4. When the time is up, it checks back in. Further grants get exponentially harder; after the daily cap the coach can't grant more, but it'll still talk to you, help you notice the pattern, and cheer you on for closing the tab.
5. Your context — who you are, what your goals are — can only be updated by talking to the coach. No text field to silently rewrite the rules in a weak moment.

## Features

- **AI gatekeeper**: the LLM decides whether to grant access, via a structured `grant_access` tool call — not free-text the page could spoof.
- **Credit-powered coach**: coaching credit is bought with Apple In-App Purchase / Google Play Billing as a repurchasable top-up and routes through Intention's backend, which holds the provider key.
- **Optional custom key**: Settings → Advanced → Custom API key points the coach at your own Anthropic, OpenAI, Groq, or Gemini account instead, bypassing the coaching-credit balance.
- **Context-via-chat guardrail**: the system prompt ("about you") is updated only through a conversation with the coach, using an `update_context` tool. Prevents trivial self-deception.
- **Time awareness**: the AI sees the current day and time, minutes spent today on this site, this site over the past week, today across all blocked sites, and across the past week.
- **Track record**: every pass records how it ended — closed early, ran the clock out, asked for more — alongside the reason given for it, and the coach sees the last week of them. "You said ten minutes and closed at four" and "that's the fourth evening running" are things it can actually say.
- **Knows where you're going**: the coach is told the specific page — video title, channel and length, thread and subreddit, Instagram/TikTok destination, or the search term you typed. When only the address is known it is told to say so and ask, rather than guess at content it hasn't seen.
- **Exponential difficulty**: scaling skepticism per grant per day, plus a hard daily cap (3). Past the cap the chat continues for motivational support, but no more time is given out.
- **Positive reinforcement tone**: the system prompt pushes the AI to be warm, curious, non-judgmental — offering concrete alternatives, naming procrastination gently, celebrating the close-tab choice.

## Installation

### Google Chrome (and Chromium-based browsers)
1. Clone or download this repository.
2. Navigate to `chrome://extensions/` and enable **Developer mode**.
3. Click **Load unpacked** and select the `Intention Chrome` subfolder.
4. Click the extension icon → **Options** (or right-click → **Options**) to run first-time setup.

### Safari (macOS + iOS)
The `Intention Apple` folder contains a pre-generated Xcode project that wraps the web extension for both macOS and iOS.

1. Open `Intention Apple/Intention Safari.xcodeproj` in Xcode.
2. Select a macOS or iOS target and hit **Run**.
3. Enable **Intention** in Safari's Extensions settings (on iOS: Settings → Apps → Safari → Extensions).

> To regenerate the wrapper from the latest Chrome sources:
> ```
> xcrun safari-web-extension-converter "./Intention Chrome" --project-location . --app-name "Intention Safari"
> ```

### Firefox (Desktop + Android)

You can install the official extension directly from the [Firefox Add-on Store](https://addons.mozilla.org/en-US/firefox/addon/intentionai/).

For development or manual installation:

**Desktop Firefox** (unsigned, temporary — for testing):
1. Go to `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on…** and choose `manifest.json` inside `Intention Firefox`.
3. The extension loads until the next restart. For permanent use, sign/distribute via [addons.mozilla.org](https://addons.mozilla.org/).

**Firefox for Android** (Nightly):
1. Install **Firefox Nightly** from the Play Store.
2. Enable the debug menu: Settings → About Firefox Nightly → tap the logo 5 times.
3. Use **Install extension from file** (Nightly) or a [custom add-on collection](https://extensionworkshop.com/documentation/develop/extensions-in-firefox-for-android/#install-and-run-your-extension-in-firefox-for-android) on AMO to load a packaged `.xpi` built from the `Intention Firefox` folder.

## First-run setup

On first open, the options page walks you through:

1. Add starter domains (and, on mobile, apps) to the blocklist.
2. Tell your coach about yourself — who you are, your work, your goals, what patterns you want to stay mindful of.
3. Turn the coach on by buying coaching credit.

After that, the options page only exposes the blocklist and access settings directly. Updating your context is done through the **Talk with your coach** button — the coach decides when the context has improved enough to save a new version.

## AI access

Three states, resolved by `resolveAIRoute()` in `background.js` on every coaching call:

| State | When | Where calls go |
|-------|------|----------------|
| `hosted` | A coaching-credit balance is available | Intention's backend (`server/`), which holds the provider key |
| `byok` | A custom API key is set in Settings → Advanced | Straight from the device to that provider |
| `locked` | Neither | Nowhere — the paywall replaces the chat, and the site stays blocked |

The purchase itself is always the platform's own: StoreKit 2 on Apple (`Intention Apple/Shared (App)/IntentionStore.swift`), Play Billing on Android (`BillingManager.kt`). Browser builds, which have no store to buy through, unlock with a short-lived code minted by the mobile app.

`server/` is the backend: it verifies App Store / Play receipts, mints entitlement tokens, and proxies coaching calls. It has no dependencies — `cd server && npm start`. See [`server/README.md`](server/README.md).

## Technology

- Vanilla JavaScript, Manifest V3, HTML + CSS (glassmorphic)
- `chrome.alarms`, `chrome.storage.local`, `chrome.tabs`, `chrome.runtime`
- StoreKit 2 (Apple) / Play Billing (Android) for in-app purchases
- LLM adapters: Intention's hosted backend, Anthropic Messages API, OpenAI (+ Groq) Chat Completions, Gemini generateContent
- Tool-use-based access grant and context update — no free-text commands

## Testing

A Vitest suite covers the prompt composition, tracking/stats, and LLM-provider
logic (loading the unmodified source files via a `node:vm` loader), plus a
parity check across the three variants and a browser-based overlay dev harness.

```bash
npm install
npm test
```

See [`tests/README.md`](tests/README.md) for the full guide (watch mode, the
overlay harness, and live-loading the extension in Firefox / Chrome / Safari).

## Building & publishing

All shared extension source lives in `shared/`. Edit there, then run `scripts/sync.sh` to propagate to the platform folders (platform manifests are generated from `shared/manifest.base.json` plus a small per-platform overlay). `./build.sh` produces versioned Chrome/Firefox zips (and, with `--all`/`--safari`, the Safari `.app` — macOS + Xcode only) into `build/`; its preflight fails if any platform folder has drifted from `shared/`. `scripts/bump-version.sh <version>` syncs the version across all platforms in one command. See [DEPLOYMENT.md](DEPLOYMENT.md) for the full Chrome Web Store / Firefox AMO / Apple App Store submission guide, including which secrets enable auto-publishing from CI. Data handling is described in [PRIVACY.md](PRIVACY.md).
