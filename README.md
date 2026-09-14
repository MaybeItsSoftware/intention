# Intention

**Intention** is a browser extension and mobile app that stands between you and the sites and apps that pull you away from what you actually want to do. For each one you set an **intention**: how many times a day you mean to open it, and for how long each time. Within that, opening it is one tap — no conversation, nothing to pay. Once today's opens are used, the only way to more time is to make your case to an AI coach: why are you here, what has to happen now, would walking away serve you better?

Loosening your own rules is never refused, only delayed: more opens, or removing a block, starts the next day — or now, if the coach agrees. Tightening is instant. A forgiving streak counts the days you keep every intention, with one slip a week absorbed.

The coach runs on **coaching credit**, a one-time top-up bought through the App Store or Google Play — nothing to configure, no keys to fetch, no recurring charge, and only spent when you ask it for more than you intended. Developers who would rather point it at their own LLM account can do that instead, from Settings → Advanced.

## Get Intention

* **Firefox**: [Download on the Firefox Add-on Store](https://addons.mozilla.org/en-US/firefox/addon/intentionai/)

* **Chrome**: [Download on the Chrome Web Store](https://chromewebstore.google.com/detail/intention/dbeapcoomlbnpljdnblmegniiacfoeop)


*(Safari and Android versions are currently built/run from source—see details below.)*

## How it works

1. You add sites to a blocklist (e.g. `instagram.com`, `x.com`) and, on mobile, apps. An entry can cover the whole thing or only part of it — "Reels but not messages", "all of Reddit except r/rust".
2. When you open one, the page is paused and a chat opens. Your coach — the LLM you chose — asks what's up.
3. If you have a real, specific, time-bounded reason, it grants you some minutes — either for the site, or for just the page you named, in which case leaving that page puts the block straight back. If the reason is hollow ("just checking"), it doesn't — it offers alternatives instead, drawn from what it knows about you.
4. When the time is up, it checks back in. Further grants get exponentially harder; after the daily cap the coach can't grant more, but it'll still talk to you, help you notice the pattern, and cheer you on for closing the tab.
5. Your context — who you are, what your goals are — can only be updated by talking to the coach. No text field to silently rewrite the rules in a weak moment.
6. Removing Intention is the biggest loosening there is, so it goes through the same conversation, after a cool-off if you set yourself one. Nothing in it can stop you leaving, and none of it is allowed to try — see [`docs/LEAVING.md`](docs/LEAVING.md), which is also the page the browser opens once Intention is gone.

## Features

- **AI gatekeeper**: the LLM decides whether to grant access, via a structured `grant_access` tool call — not free-text the page could spoof.
- **Credit-powered coach**: coaching credit is bought with Apple In-App Purchase / Google Play Billing as a repurchasable top-up and routes through Intention's backend, which holds the provider key.
- **Optional custom key**: Settings → Advanced → Custom API key points the coach at your own Anthropic, OpenAI, Groq, or Gemini account instead, bypassing the coaching-credit balance.
- **Context-via-chat guardrail**: the system prompt ("about you") is updated only through a conversation with the coach, using an `update_context` tool. Prevents trivial self-deception.
- **Time awareness**: the AI sees the current day and time, minutes spent today on this site, this site over the past week, today across all blocked sites, and across the past week.
- **Track record**: every pass records how it ended — closed early, ran the clock out, asked for more — alongside the reason given for it, and the coach sees the last week of them. "You said ten minutes and closed at four" and "that's the fourth evening running" are things it can actually say.
- **Blocking part of a site**: a blocklist entry carries a scope — all of it, only these parts, or everything except these parts — so "block Instagram" can mean Reels shut and messages open. Any edit that leaves less of it blocked goes through the coach; tightening saves itself. On the web the part is read off the address, so it works everywhere. Inside the Android app it is read off the app's own screen and is best-effort: a screen Intention cannot recognise blocks the whole app rather than opening it, and it says so at the gate rather than letting a rule fail quietly. Inside an iOS app it is not possible at all — Screen Time hides an app behind a shield and reports nothing about what is on it — and the row says that instead of offering a control that cannot work.
- **Page-scoped passes**: the coach can grant "this one video" rather than the whole site. The pass ends the moment the address stops matching the page it was granted for — an autoplay into the next video, a swipe back into the feed — and the gate comes back. Where the browser's rule ordering has been verified, the rest of the site keeps its blocking rule while the granted address is allowed through; everywhere else the scope is held by the overlay alone, which is how Safari holds every pass.
- **Knows where you're going**: the coach is told the specific page — video title, channel and length, thread and subreddit, Instagram/TikTok destination, or the search term you typed. When only the address is known it is told to say so and ask, rather than guess at content it hasn't seen.
- **Exponential difficulty**: scaling skepticism per grant per day, plus a hard daily cap (3). Past the cap the chat continues for motivational support, but no more time is given out.
- **Positive reinforcement tone**: the system prompt pushes the AI to be warm, curious, non-judgmental — offering concrete alternatives, naming procrastination gently, celebrating the close-tab choice.
- **A balance you can see**: the settings header carries a credit chip on every tab, and the gate says so when credit is running low. A balance survives a reinstall on the same device.
- **A way out that works**: removal routes through the coach, with an optional cool-off, an exit that is live from the first paint of that conversation, and an export of your list so leaving isn't punitive.

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

On first open, the options page asks one question per page. The bar at the top fills as you go and names the part of setup you're in ("Intentions · 2 of 4"), rather than counting every page.

1. What Intention is: pick what pulls you in, say how often you mean to open each, and past that the coach decides.
2. *(iOS)* Turn the Safari extension on. Only you can do that — iOS gives an app no way to do it for you.
3. *(mobile)* Which apps pull you in.
4. Which websites pull you in.
5. One page per app or site: how many times a day you want to open it (a big number with − and +), and for how long each time (5, 10, 15 or 30 minutes). The line underneath adds it up as a day, and "Use this for the other N" copies the answer onto the rest.
6. Whether to tell the coach what each one is for. Skip, or say yes and get one page per service — a site and its app share one — answered by tapping chips: when opening it is fair enough, and (folded away) why it's on the list.
7. What happens once an intention runs out: the coach, on coaching credit. Nothing to buy during setup.
8. Your intentions read back, and your streak starts.

After that, the options page only exposes the blocklist and access settings directly. Updating your context is done through the **Talk with your coach** button — the coach decides when the context has improved enough to save a new version.

## AI access

Three states, resolved by `resolveAIRoute()` in `background.js` on every coaching call:

| State | When | Where calls go |
|-------|------|----------------|
| `hosted` | A coaching-credit balance is available | Intention's backend (`server/`), which holds the provider key |
| `byok` | A custom API key is set in Settings → Advanced | Straight from the device to that provider |
| `locked` | Neither | Nowhere — the paywall replaces the chat, and the site stays blocked |

The purchase itself is always the platform's own: StoreKit 2 on Apple (`Intention Apple/Shared (App)/IntentionStore.swift`), Play Billing on Android (`BillingManager.kt`). Browser builds have no store to buy through and no coaching credit: the coach there runs on the user's own API key.

The balance is shown rather than implied — a credit chip in the settings header on every tab, and a line at the gate when it is running low — and it is meant to survive things going wrong. On a reinstall the app asks the backend whether a balance is held against its store account id (`POST /v1/entitlement/recover`) before showing anyone a paywall. A device that is gone takes its credit with it: there is no account behind a balance, no email and nothing to log into, which is the point and also the risk.

`server/` is the backend: it verifies App Store / Play receipts, mints entitlement tokens, and proxies coaching calls. It has no dependencies — `cd server && npm start`. See [`server/README.md`](server/README.md).

## Leaving Intention

Loosening a rule costs a conversation with the coach, and removal is the biggest loosening there is, so it goes through the same mechanism. It is also the one rule you can undo from outside Intention entirely, and the design starts from admitting that.

- **A cool-off you set yourself**, in Settings → Blocking: none, an hour, 24 hours or 3 days. Making it longer saves straight away; making it shorter costs a conversation, like every other rule you wrote for yourself in a calmer moment. It is not a lock — while the wait runs, the card carries a **Remove it now anyway** button, and it works.
- **One tab, once.** Opening `chrome://extensions` or `about:addons` opens a single Intention tab *beside* it offering that conversation. It never navigates, reloads or closes the page you opened — you may well have gone there for a different extension. Every ending of the conversation, including deciding to stay, buys fifteen minutes of silence, and any visit at all buys ten. On Android the same interposition runs when Settings shows Intention's own App info page or the accessibility entry for its service; it launches over Settings and a Back press dismisses it, which is deliberate.
- **The exit is never hidden.** "Remove it anyway" is enabled from the first paint of the conversation, is never on a timer, and works whatever the coach says and whatever the cool-off says. If you have run out of coaching credit the conversation still opens — it is the one conversation in Intention that never hands over to the paywall, because "pay us to be allowed to leave" is not a thing this product will do.
- **Take your list with you.** "Save a copy of your list" writes `intention-list-YYYY-MM-DD.json`: blocked sites and apps, their limits, your setup answers and your coach's context. Not your credit, your key, your stats or any conversation.

`chrome.runtime.setUninstallURL` points at [`docs/LEAVING.md`](docs/LEAVING.md), so that page is the last thing a user sees. It is deliberately on GitHub rather than on Intention's own backend, which logs every request it receives: pointing it there would have turned every removal into an uninstall ping.

## Privacy

[`PRIVACY.md`](PRIVACY.md) is the policy, and it is the source of what the stores link to: it is published at <https://maybeitssoftware.co.uk/intention/privacy>, which is the URL registered in both the App Store and Google Play listings. Changing that file changes the published policy, so it needs to keep pace with what the code actually does — the store data-safety declarations are checked against it.

## Technology

- Vanilla JavaScript, Manifest V3, HTML + CSS (glassmorphic)
- `chrome.alarms`, `chrome.storage.local`, `chrome.tabs`, `chrome.runtime`, `chrome.declarativeNetRequest` (blocking rules, and the per-tab allow rule a page-scoped pass rests on), `chrome.webNavigation`
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

`npm run test:smoke` is the other half: Playwright against a real Chromium with
the extension loaded, covering the gate (including a page-scoped grant), the
wizard, the leaving interposition and text contrast. It is the only thing here
that runs a browser, so anything a browser decides — rule ordering, whether an
event fires for a `chrome://` page — is verified there or not at all.

See [`tests/README.md`](tests/README.md) for the full guide (watch mode, the
overlay harness, and live-loading the extension in Firefox / Chrome / Safari).

## Building & publishing

All shared extension source lives in `shared/`. Edit there, then run `scripts/sync.sh` to propagate to the platform folders (platform manifests are generated from `shared/manifest.base.json` plus a small per-platform overlay). `./build.sh` produces versioned Chrome/Firefox zips (and, with `--all`/`--safari`, the Safari `.app` — macOS + Xcode only) into `build/`; its preflight fails if any platform folder has drifted from `shared/`. `scripts/bump-version.sh <version>` syncs the version across all platforms in one command. See [DEPLOYMENT.md](DEPLOYMENT.md) for the full Chrome Web Store / Firefox AMO / Apple App Store submission guide, including which secrets enable auto-publishing from CI. Data handling is described in [PRIVACY.md](PRIVACY.md).
