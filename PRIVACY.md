# Privacy Policy — Intention

_Last updated: 2026-07-31_

**Intention** is available as a browser extension (Chrome, Firefox, Safari) and as native Android and iOS apps. This policy covers all of them.

There are two ways the coach can run, and they have different data flows:

- **Intention Pro (the default)** — you subscribe through the App Store or Google Play, and your conversations go to Intention's own backend, which forwards them to an LLM provider under Intention's key. This is the only case where anything reaches a developer-operated server.
- **Custom API key (Settings → Advanced)** — you supply your own provider key, and your device talks to that provider directly. Intention's backend is not involved at all, and never sees anything.

## What the developer collects

**On the Custom API key path: nothing.** No server is contacted, no analytics, no crash reports.

**On the Intention Pro path**, the backend receives, for the duration of each request:

- The conversation being sent to the coach (see "What is sent" below).
- An entitlement token proving an active subscription. It identifies the subscription, not you: it holds a one-way hash of the store transaction ID, the product ID, and the expiry date. No name, email, Apple Account, or Google account reaches the backend — the stores don't share those with us.

Requests are processed and returned; conversations are not stored, not logged, and not used to train anything. A per-subscription count of messages sent today is kept in memory so a daily fair-use limit can be enforced; it resets daily and holds no message content.

## What Intention stores locally

On your device only — `chrome.storage.local` (or the equivalent Firefox/Safari API) for the browser extensions, Android `SharedPreferences` for the Android app, and `UserDefaults`/App Group storage for the iOS app:

- Your blocklist of domains and/or apps (Android/iOS), and their per-item limits.
- Your subscription status (product, expiry, and the entitlement token above), or — if you use the advanced override — your LLM provider choice and the API key you enter.
- Your "about you" context (the profile the coach uses), and its edit history.
- Daily/weekly/all-time usage statistics per blocked domain or app (minutes spent, grants given, reasons given).

This data is never synced to a developer-controlled server. If your browser or OS has its own sync feature enabled (browser profile sync, iCloud, etc.), that sync is between your own devices/profiles via your own account with that vendor (Google, Mozilla, Apple), not something Intention initiates.

On Apple platforms, the native app and its Safari Web Extension share this data (including the subscription entitlement and any API key) with each other on-device via an App Group — this is local interprocess storage between the developer's own app and its own extension, not a network transfer.

## App-detection permissions (Android and iOS)

To detect when you open a blocked app, the native apps need OS-level visibility into what's running, in addition to the local storage above:

- **Android** — an Accessibility Service watches for foreground-app-changed events and reads only the **package name** of the app that came to the foreground (e.g. `com.instagram.android`). It cannot and does not read on-screen text, images, or any other screen content (`canRetrieveWindowContent` is disabled for this service). The package name is compared against your locally stored blocklist entirely on-device; nothing is transmitted. Separately, the app requests the `QUERY_ALL_PACKAGES` permission to list your installed apps so you can pick which ones to block — this list is used only to populate that picker and never leaves your device.
- **iOS** — app blocking uses Apple's Screen Time APIs (Family Controls / ManagedSettings / DeviceActivity). Your app selection is stored as an opaque token set provided by Apple's API (no bundle identifiers or app names are readable by Intention) and stays entirely on-device and inside Apple's own framework; Intention's shield/monitor extensions never see or transmit which apps you've selected.

## What is sent, and where

When you open a blocked site or app and talk to your coach, Intention sends an HTTPS request containing:

- Your chat messages to the coach.
- Your saved "about you" context.
- Usage stats needed for the coach's judgment: which domain or app you're on (by name, e.g. "Instagram" or "example.com"), minutes spent today/this week/all-time on it, and today's grant count.

Where that request goes depends on which path you're on:

- **Intention Pro** — to Intention's backend, which forwards it to the LLM provider Intention has contracted (currently Anthropic) under Intention's own key. The provider receives the conversation; it does not receive your entitlement token or any identifier of your subscription.
- **Custom API key** — **directly from your device to the provider you selected** (Anthropic, OpenAI, Groq, or Google Gemini), authenticated with your key. Nothing passes through Intention's backend.

Either way, handling by the LLM provider is governed by that provider's privacy policy.

The store's own purchase receipt is also sent to Intention's backend once when you subscribe, and again when the subscription is re-checked, so it can be verified with Apple or Google. Apple and Google receive your payment details; Intention never does.

No other network requests are made by Intention on any platform.

## Data collection categories (store disclosures)

For app-store data-safety disclosures (Firefox Add-ons, Google Play, Apple App Store), Intention declares:

- **Browsing activity** — domain names and time-on-site are read from your local usage stats and included in coach requests.
- **App activity** (Android/iOS) — which blocked app you opened and time-on-app, read from your local usage stats and included in coach requests.
- **Personal communications** — your chat messages with the coach are transmitted to the LLM provider you configured.

On the Intention Pro path these are sent to Intention's backend and on to its LLM provider; on the Custom API key path they are sent only to the provider you chose, using your own key, and never to the developer. The list of apps installed on your Android device (used only for the block-list picker, see above) is not included in any of these categories because it is never transmitted anywhere.

## Your controls

- Change or remove your blocklist, context, or custom API key at any time from the Options page (extension) or Settings (Android/iOS app).
- Manage or cancel your subscription in the App Store or Google Play — Intention's Settings link straight to the store's own management screen.
- Uninstalling the extension or app deletes all locally stored data (blocklist, stats, context, entitlement, key) per your browser's or OS's standard app/extension-storage cleanup behavior.
- There is no account and no telemetry opt-out to make. If you want the developer-side record of a subscription removed, cancel it and open an issue — the only data held is the hashed transaction identifier described above, and it expires on its own.

## Changes to this policy

If Intention's data flows change (e.g. a new provider integration), this file will be updated and the version history is visible in the project's git log.

## Contact

Questions about this policy: open an issue on the project's GitHub repository.
