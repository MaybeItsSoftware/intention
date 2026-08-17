# Privacy Policy — Intention

_Last updated: 2026-08-17_

**Intention** is available as a browser extension (Chrome, Firefox, Safari) and as native Android and iOS apps. This policy covers all of them.

There are two ways the coach can run, and they have different data flows:

- **Coaching credit (the default)** — you buy a one-time top-up through the App Store or Google Play, and your conversations go to Intention's own backend, which forwards them to an LLM provider under Intention's key. This is the only case where anything reaches a developer-operated server.
- **Custom API key (Settings → Advanced on Apple builds; also offered during setup on Android and in the browser extensions)** — you supply your own provider key, and your device talks to that provider directly. Intention's backend is not involved in your conversations at all.

There is one deliberate exception to that second path, described under "Reporting a coach message" below: if you choose to report something the coach said, that report is sent to Intention no matter which path you are on. It only ever happens because you asked for it.

## What the developer collects

**On the Custom API key path: nothing, unless you report a message.** No server is contacted for your conversations, and there are no analytics and no crash reports on any path.

**On the coaching-credit path**, the backend receives, for the duration of each request:

- The conversation being sent to the coach (see "What is sent" below).
- An entitlement token proving a verified purchase. It identifies your purchase account, not you: it holds a one-way hash of a client-generated account identifier (never your name, email, Apple Account, or Google account — the stores don't share those with us) and the product ID.

Requests are processed and returned; conversations are not stored, not logged, and not used to train anything. A running coaching-credit balance (how much of your top-up is left) is stored against that same hashed identifier and decreases as the coach is used; it holds no message content, and it persists so that credit you have paid for survives a server restart.

Like almost any web server, the backend also writes an access log of the requests it receives: a request id, the method, the path (never the query string), the response status, how long it took, and the client IP address. It contains no message content and no entitlement token. It exists to debug outages and to spot abuse.

## What Intention stores locally

On your device only — `chrome.storage.local` (or the equivalent Firefox/Safari API) for the browser extensions, Android `SharedPreferences` for the Android app, and `UserDefaults`/App Group storage for the iOS app:

- Your blocklist of domains and/or apps (Android/iOS), and their per-item limits.
- Your coaching-credit status (product and the entitlement token above, plus a locally cached copy of your remaining balance), or — if you use the advanced override — your LLM provider choice and the API key you enter.
- Your "about you" context (the profile the coach uses), and its edit history.
- Daily/weekly/all-time usage statistics per blocked domain or app (minutes spent, grants given, reasons given).
- A visit count for the sites on the extension's built-in suggestion list, used only to put the ones you actually open at the top of that list. It is limited to that fixed list of well-known distracting sites — a site you visit that isn't on it is never counted or written down — and it is not sent anywhere, including to the native app on Apple platforms.

This data is never synced to a developer-controlled server. If your browser or OS has its own sync feature enabled (browser profile sync, iCloud, etc.), that sync is between your own devices/profiles via your own account with that vendor (Google, Mozilla, Apple), not something Intention initiates.

On Apple platforms, the native app and its Safari Web Extension share this data (including the coaching-credit entitlement and any API key) with each other on-device via an App Group — this is local interprocess storage between the developer's own app and its own extension, not a network transfer.

## App-detection permissions (Android and iOS)

To detect when you open a blocked app, the native apps need OS-level visibility into what's running, in addition to the local storage above:

- **Android** — an Accessibility Service watches for foreground-app-changed events and reads two things. First, the **package name** of the app that came to the foreground (e.g. `com.instagram.android`). Second, in a fixed list of supported browsers, the **text of the address bar** — this is how blocking a website works on Android, where Intention has no way to see inside the browser otherwise. It looks up one specific view (the address bar) by its known id in each of those browsers; it does not read the page you are looking at, screenshots, form fields, passwords, or the contents of any other app. Both the package name and the host taken from the address bar are compared against your locally stored blocklist entirely on-device, and neither is transmitted, stored beyond the moment of the check, or written to disk. Separately, the app requests the `QUERY_ALL_PACKAGES` permission to list your installed apps so you can pick which ones to block — this list is used only to populate that picker and never leaves your device.
- **iOS** — app blocking uses Apple's Screen Time APIs (Family Controls / ManagedSettings / DeviceActivity). Your app selection is stored as an opaque token set provided by Apple's API (no bundle identifiers or app names are readable by Intention) and stays entirely on-device and inside Apple's own framework; Intention's shield/monitor extensions never see or transmit which apps you've selected.

## What is sent, and where

When you open a blocked site or app and talk to your coach, Intention sends an HTTPS request containing:

- Your chat messages to the coach.
- Your saved "about you" context.
- Usage stats needed for the coach's judgment: which domain or app you're on (by name, e.g. "Instagram" or "example.com"), minutes spent today/this week/all-time on it, and today's grant count.
- A short description of the specific thing you were opening, so the coach can talk about it rather than about "a website": the address, the page title, and where one exists a one-line summary — for a video, its title and channel; for a thread, its title and forum; for a search, what you typed. Each field is truncated (the address to 500 characters, titles to 200, summaries to 400).

Where that request goes depends on which path you're on:

- **Coaching credit** — to Intention's backend, which forwards it to the LLM provider Intention has contracted (currently Anthropic) under Intention's own key. The provider receives the conversation; it does not receive your entitlement token or any identifier of your account.
- **Custom API key** — **directly from your device to the provider you selected** (Anthropic, OpenAI, Groq, or Google Gemini), authenticated with your key. Nothing passes through Intention's backend. Your key is sent in a request header, except for Google Gemini, whose API takes it as part of the request address instead — that is Google's design, not a choice Intention makes, and it is worth knowing if you are on a network that logs URLs.

Either way, handling by the LLM provider is governed by that provider's privacy policy.

To fill in that description of what you were opening, your device may also make one request **to the site itself** — YouTube's, TikTok's or Reddit's public preview endpoint, or, for anything else, a plain cookie-less fetch of the page's `<head>` to read its title. It carries no cookies, so it always sees the logged-out version of the page, and it goes to that site, not to Intention. The result is cached only for the current browsing session and is never written to disk.

The store's own purchase receipt is also sent to Intention's backend each time you buy coaching credit, so it can be verified with Apple or Google. Apple and Google receive your payment details; Intention never does.

Apart from those, and from a report you choose to send, Intention makes no network requests on any platform.

## Reporting a coach message

The coach is a language model, and a language model can say something wrong, cruel, or worse. Press and hold any message the coach wrote and you can report it.

Sending a report transmits, to Intention's backend:

- the message you reported,
- the message you sent immediately before it, because a reply usually can't be judged without knowing what it answered,
- whatever note you chose to type,
- which provider and model produced it, and
- if you are on the coaching-credit path, the same hashed purchase identifier described above — so that repeated reports can be recognised as coming from one person. If you use your own API key, there is no such identifier and none is created.

Nothing else from the conversation is included. **This is the only case in which anything from a Custom API key user's conversation reaches Intention**, it only happens on that explicit action, and the app states what it is about to send before you confirm.

Reports are kept for up to 180 days and are used for one thing: working out what the coach is getting wrong and fixing it.

## Data collection categories (store disclosures)

For app-store data-safety disclosures (Firefox Add-ons, Google Play, Apple App Store), Intention declares:

- **Browsing activity** — domain names and time-on-site are read from your local usage stats and included in coach requests.
- **App activity** (Android/iOS) — which blocked app you opened and time-on-app, read from your local usage stats and included in coach requests.
- **Personal communications** — your chat messages with the coach are transmitted to the LLM provider you configured, and a message you choose to report is transmitted to Intention.

On the coaching-credit path these are sent to Intention's backend and on to its LLM provider; on the Custom API key path they are sent only to the provider you chose, using your own key, and never to the developer. The list of apps installed on your Android device (used only for the block-list picker, see above) is not included in any of these categories because it is never transmitted anywhere.

## Your controls

- Change or remove your blocklist, context, or custom API key at any time from the Options page (extension) or Settings (Android/iOS app).
- View your purchase history in the App Store or Google Play. Coaching credit is a one-time top-up, not a subscription — there's nothing recurring to manage or cancel.
- Uninstalling the extension or app deletes all locally stored data (blocklist, stats, context, entitlement, key) per your browser's or OS's standard app/extension-storage cleanup behavior. One exception on Android: the random identifier your coaching credit is attached to is included in Android's own app backup, deliberately, so that credit you have paid for is still yours if you reinstall. It is a random value with nothing else attached to it, and clearing the app's backup through your Google account removes it.
- There is no account and no telemetry opt-out to make. If you want the developer-side record of your balance removed, open an issue — the only data held is the hashed account identifier and remaining balance described above.

## Changes to this policy

If Intention's data flows change (e.g. a new provider integration), this file will be updated and the version history is visible in the project's git log.

## Contact

Questions about this policy: open an issue on the project's GitHub repository.
