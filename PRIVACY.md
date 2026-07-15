# Privacy Policy — Intention

_Last updated: 2026-07-15_

**Intention** is available as a browser extension (Chrome, Firefox, Safari) and as native Android and iOS apps. This policy covers all of them. There is no backend operated by the developer — every version of Intention talks directly from your device to (a) its own local storage and (b) the LLM provider you configure, using an API key you supply.

## What the developer collects

Nothing, on any platform. The developer of Intention does not operate any server, does not receive analytics, crash reports, or usage data, and cannot see your blocklist, your conversations with the coach, or your API key.

## What Intention stores locally

On your device only — `chrome.storage.local` (or the equivalent Firefox/Safari API) for the browser extensions, Android `SharedPreferences` for the Android app, and `UserDefaults`/App Group storage for the iOS app:

- Your blocklist of domains and/or apps (Android/iOS), and their per-item limits.
- Your LLM provider choice and the API key you enter.
- Your "about you" context (the profile the coach uses), and its edit history.
- Daily/weekly/all-time usage statistics per blocked domain or app (minutes spent, grants given, reasons given).

This data is never synced to a developer-controlled server. If your browser or OS has its own sync feature enabled (browser profile sync, iCloud, etc.), that sync is between your own devices/profiles via your own account with that vendor (Google, Mozilla, Apple), not something Intention initiates.

On iOS, the native app and its Safari Web Extension share this data (including the API key) with each other on-device via an App Group — this is local interprocess storage between the developer's own app and its own extension, not a network transfer.

## App-detection permissions (Android and iOS)

To detect when you open a blocked app, the native apps need OS-level visibility into what's running, in addition to the local storage above:

- **Android** — an Accessibility Service watches for foreground-app-changed events and reads only the **package name** of the app that came to the foreground (e.g. `com.instagram.android`). It cannot and does not read on-screen text, images, or any other screen content (`canRetrieveWindowContent` is disabled for this service). The package name is compared against your locally stored blocklist entirely on-device; nothing is transmitted. Separately, the app requests the `QUERY_ALL_PACKAGES` permission to list your installed apps so you can pick which ones to block — this list is used only to populate that picker and never leaves your device.
- **iOS** — app blocking uses Apple's Screen Time APIs (Family Controls / ManagedSettings / DeviceActivity). Your app selection is stored as an opaque token set provided by Apple's API (no bundle identifiers or app names are readable by Intention) and stays entirely on-device and inside Apple's own framework; Intention's shield/monitor extensions never see or transmit which apps you've selected.

## What is sent to a third party

When you open a blocked site or app and talk to your coach, or complete onboarding, Intention sends an HTTPS request **directly from your device to the LLM provider you selected** (Anthropic, OpenAI, Groq, or Google Gemini), authenticated with the API key you provided. That request includes:

- Your chat messages to the coach.
- Your saved "about you" context.
- Usage stats needed for the coach's judgment: which domain or app you're on (by name, e.g. "Instagram" or "example.com"), minutes spent today/this week/all-time on it, and today's grant count.

This is governed by the privacy policy of whichever provider you chose — Intention has no visibility into how that provider handles the request once sent. No other network requests are made by Intention on any platform.

## Data collection categories (store disclosures)

For app-store data-safety disclosures (Firefox Add-ons, Google Play, Apple App Store), Intention declares:

- **Browsing activity** — domain names and time-on-site are read from your local usage stats and included in coach requests.
- **App activity** (Android/iOS) — which blocked app you opened and time-on-app, read from your local usage stats and included in coach requests.
- **Personal communications** — your chat messages with the coach are transmitted to the LLM provider you configured.

All of the above are sent only to the third-party LLM provider you chose, using your own API key — never to the developer. The list of apps installed on your Android device (used only for the block-list picker, see above) is not included in any of these categories because it is never transmitted anywhere.

## Your controls

- Change or remove your API key, blocklist, or context at any time from the Options page (extension) or Settings (Android/iOS app).
- Uninstalling the extension or app deletes all locally stored data (blocklist, stats, context, key) per your browser's or OS's standard app/extension-storage cleanup behavior.
- There is no account, no telemetry opt-out needed, and no developer-side data to request deletion of, because none is collected.

## Changes to this policy

If Intention's data flows change (e.g. a new provider integration), this file will be updated and the version history is visible in the project's git log.

## Contact

Questions about this policy: open an issue on the project's GitHub repository.
