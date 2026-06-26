# Intention

**Intention** is a browser extension that puts an AI coach between you and the sites that pull you away from what you actually want to do. Instead of a hard block or a weak timer, every visit is a short conversation: why are you here, is there something you're avoiding, what would actually serve you right now? You bring your own LLM API key. Nothing leaves your machine except calls to that provider.

## How it works

1. You add sites to a blocklist (e.g. `instagram.com`, `twitter.com`).
2. When you open one, the page is paused and a chat opens. Your coach — the LLM you chose — asks what's up.
3. If you have a real, specific, time-bounded reason, it grants you some minutes. If the reason is hollow ("just checking"), it doesn't — it offers alternatives instead, drawn from what it knows about you.
4. When the time is up, it checks back in. Further grants get exponentially harder; after the daily cap the coach can't grant more, but it'll still talk to you, help you notice the pattern, and cheer you on for closing the tab.
5. Your context — who you are, what your goals are — can only be updated by talking to the coach. No text field to silently rewrite the rules in a weak moment.

## Features

- **AI gatekeeper**: the LLM decides whether to grant access, via a structured `grant_access` tool call — not free-text the page could spoof.
- **Multi-provider, bring-your-own-key**: Anthropic (Claude), OpenAI, Groq, Google Gemini. You pick the provider and model.
- **Context-via-chat guardrail**: the system prompt ("about you") is updated only through a conversation with the coach, using an `update_context` tool. Prevents trivial self-deception.
- **Time awareness**: the AI sees minutes spent today on this site, today across all blocked sites, and across the past week.
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

1. Choose a provider (Anthropic / OpenAI / Groq / Gemini) and paste an API key.
2. Tell your coach about yourself — who you are, your work, your goals, what patterns you want to stay mindful of.
3. Add starter domains to the blocklist.

After that, the options page only exposes the blocklist and provider settings directly. Updating your context is done through the **Talk with your coach** button — the coach decides when the context has improved enough to save a new version.

## Technology

- Vanilla JavaScript, Manifest V3, HTML + CSS (glassmorphic)
- `chrome.alarms`, `chrome.storage.local`, `chrome.tabs`, `chrome.runtime`
- LLM adapters: Anthropic Messages API, OpenAI (+ Groq) Chat Completions, Gemini generateContent
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
