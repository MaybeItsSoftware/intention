# Privacy Policy — Intention

_Last updated: 2026-07-02_

**Intention** is a browser extension. This policy describes what data it touches and where that data goes. There is no backend operated by the developer — the extension talks directly from your browser to (a) your own device's local storage and (b) the LLM provider you configure, using an API key you supply.

## What the developer collects

Nothing. The developer of Intention does not operate any server, does not receive analytics, crash reports, or usage data, and cannot see your blocklist, your conversations with the coach, or your API key.

## What the extension stores locally

Using `chrome.storage.local` (or the equivalent Firefox API), on your device only:

- Your blocklist of domains and per-domain limits.
- Your LLM provider choice and the API key you enter.
- Your "about you" context (the profile the coach uses), and its edit history.
- Daily/weekly/all-time usage statistics per blocked domain (minutes spent, grants given, reasons given).

This data is never synced to a developer-controlled server. If your browser has its own sync feature enabled for extension storage, that sync is between your own browser profiles via your browser vendor's account (Google/Mozilla), not something Intention initiates.

## What is sent to a third party

When you open a blocked site and talk to your coach, or complete onboarding, the extension sends an HTTPS request **directly from your browser to the LLM provider you selected** (Anthropic, OpenAI, Groq, or Google Gemini), authenticated with the API key you provided. That request includes:

- Your chat messages to the coach.
- Your saved "about you" context.
- Usage stats needed for the coach's judgment: which domain you're on, minutes spent today/this week/all-time on that domain, and today's grant count.

This is governed by the privacy policy of whichever provider you chose — Intention has no visibility into how that provider handles the request once sent. No other network requests are made by the extension.

## Data collection categories (Firefox disclosure)

For the Firefox Add-ons store's data collection disclosure, Intention declares:

- **Browsing activity** — domain names and time-on-site are read from your local usage stats and included in coach requests.
- **Personal communications** — your chat messages with the coach are transmitted to the LLM provider you configured.

Both are sent only to the third-party LLM provider you chose, using your own API key — never to the developer.

## Your controls

- Change or remove your API key, blocklist, or context at any time from the extension's Options page.
- Uninstalling the extension deletes all locally stored data (blocklist, stats, context, key) per your browser's standard extension-storage cleanup behavior.
- There is no account, no telemetry opt-out needed, and no developer-side data to request deletion of, because none is collected.

## Changes to this policy

If the extension's data flows change (e.g. a new provider integration), this file will be updated and the version history is visible in the project's git log.

## Contact

Questions about this policy: open an issue on the project's GitHub repository.
