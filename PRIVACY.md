# Privacy Policy — Intention

_Last updated: 2026-09-14_

_Published at <https://maybeitssoftware.co.uk/intention/privacy> — that URL is what the App Store and Google Play listings point at, so this file is the source of it and any change here is a change to the published policy._

**Intention** is available as a browser extension (Chrome, Firefox, Safari) and as native Android and iOS apps. This policy covers all of them.

There are two ways the coach can run, and they have different data flows:

- **Coaching credit (the default)** — you buy a one-time top-up through the App Store or Google Play, and your conversations go to Intention's own backend, which forwards them to an LLM provider under Intention's key.
- **Custom API key (Settings → Advanced on Apple builds; also offered during setup on Android and in the browser extensions)** — you supply your own provider key, and your device talks to that provider directly. Intention's backend is not involved in your conversations at all.

There is one deliberate exception to that second path, described under "Reporting a coach message" below: if you choose to report something the coach said, that report is sent to Intention no matter which path you are on. It only ever happens because you asked for it.

## What the developer collects

**On the Custom API key path: nothing, unless you report a message.** No server is contacted for your conversations, and there are no analytics and no crash reports on any path.

**On the coaching-credit path**, the backend receives, for the duration of each request:

- The conversation being sent to the coach (see "What is sent" below).
- An entitlement token proving a verified purchase. It identifies your purchase account, not you: it holds a one-way hash of a client-generated account identifier (never your name, email, Apple Account, or Google account — the stores don't share those with us) and the product ID.

Requests are processed and returned; conversations are not stored, not logged, and not used to train anything. A running coaching-credit balance (how much of your top-up is left) is stored against that same hashed identifier and decreases as the coach is used; it holds no message content, and it persists so that credit you have paid for survives a server restart.

If you ask the Chrome or Firefox extension for a recovery code — the code you write down so that credit you have paid for is still yours after a reinstall or a lost phone — the backend stores that code alongside the same hashed identifier, so that typing it back in can find your balance again. It holds nothing else: no message content, no device information, and still no name, email or store account. Generating a fresh one replaces the old code rather than adding to it, and if you would rather it did not exist, ask for it to be removed as described under "Your controls" below.

Like almost any web server, the backend also writes an access log of the requests it receives: a request id, the method, the path (never the query string), the response status, how long it took, and the client IP address. Alongside it the backend logs the few events it has to be able to account for — a coach request's token counts and what it cost, a change to a balance, and the fact that a device asked for a balance it had lost — each against the same one-way hashed identifier described above. None of it contains message content or an entitlement token. It exists to debug outages, to reconcile spend, and to spot abuse.

## What Intention stores locally

On your device only — `chrome.storage.local` (or the equivalent Firefox/Safari API) for the browser extensions, Android `SharedPreferences` for the Android app, and `UserDefaults`/App Group storage for the iOS app:

- Your blocklist of domains and/or apps (Android/iOS), and their per-item limits.
- Your coaching-credit status (product and the entitlement token above, plus a locally cached copy of your remaining balance), or — if you use the advanced override — your LLM provider choice and the API key you enter.
- Your "about you" context (the profile the coach uses), and its edit history.
- Daily/weekly/all-time usage statistics per blocked domain or app (minutes spent, grants given, reasons given).
- A visit count for the sites on the extension's built-in suggestion list, used only to put the ones you actually open at the top of that list. It is limited to that fixed list of well-known distracting sites — a site you visit that isn't on it is never counted or written down — and it is not sent anywhere, including to the native app on Apple platforms.
- If you set a cool-off in front of removing Intention (Settings → Blocking → Leaving Intention), the length you chose, the date you finished setup, and — only while one is outstanding — the fact that you have asked to remove Intention and when the wait ends. On Apple platforms the cool-off length is shared with the native app through the App Group described below, because the settings screen you change it on lives there; the request and the fifteen-minute quiet period after any leaving conversation are per-device and are not shared or synced anywhere.

This data is never synced to a developer-controlled server. Each device keeps its own settings; nothing is copied between your devices by Intention.

If your browser or OS has its own sync feature enabled (browser profile sync, iCloud, etc.), that sync is between your own devices/profiles via your own account with that vendor (Google, Mozilla, Apple), not something Intention initiates.

On Apple platforms, the native app and its Safari Web Extension share this data (including the coaching-credit entitlement and any API key) with each other on-device via an App Group — this is local interprocess storage between the developer's own app and its own extension, not a network transfer.

## App-detection permissions (Android and iOS)

To detect when you open a blocked app, the native apps need OS-level visibility into what's running, in addition to the local storage above:

- **Android** — an Accessibility Service watches for foreground-app-changed events and reads two things. First, the **package name** of the app that came to the foreground (e.g. `com.instagram.android`). Second, in a fixed list of supported browsers, the **text of the address bar** — this is how blocking a website works on Android, where Intention has no way to see inside the browser otherwise. It looks up one specific view (the address bar) by its known id in each of those browsers. Third, and **only for an app you have given a section rule to** ("block Reels but not messages"), it reads **which section of that app is on screen**. There is no address inside an app, so the only way to answer that is to look at the screen's own structure: Intention walks the visible view tree of that one app — at most 400 views, at most 12 levels deep — and reads two things off each, the **view's id** (a name the app's developers gave it, like `clips_tab`) and its **accessibility label** (the text a screen reader would announce for it, like "Reels"). It matches those against a fixed list of section names it knows; anything else is ignored and discarded. It does not read the content of what you are looking at — not posts, messages, images, form fields or passwords — it does not take screenshots, and it does not do this at all in an app you have not given a section rule to.

  All three reads are compared against your locally stored blocklist entirely on-device, and none of them is transmitted or written to disk. The one exception is a counter: when Intention repeatedly cannot tell which section is on screen — because the app has been updated and the recogniser is out of date — it records how many times that happened for that app, and when, so it can offer to turn the rule off rather than leaving you with an app that is blocked for a reason you cannot see. That counter holds a number and two dates. It contains nothing about what was on screen and it never leaves your device. Separately, the app requests the `QUERY_ALL_PACKAGES` permission to list your installed apps so you can pick which ones to block — this list is used only to populate that picker and never leaves your device.
- **iOS** — app blocking uses Apple's Screen Time APIs (Family Controls / ManagedSettings / DeviceActivity). Your app selection is stored as an opaque token set provided by Apple's API (no bundle identifiers or app names are readable by Intention) and stays entirely on-device and inside Apple's own framework; Intention's shield/monitor extensions never see or transmit which apps you've selected.

## What is sent, and where

When you open a blocked site or app and talk to your coach, Intention sends an HTTPS request containing:

- Your chat messages to the coach.
- Your saved "about you" context.
- Usage stats needed for the coach's judgment: which domain or app you're on (by name, e.g. "Instagram" or "example.com"), minutes spent today/this week/all-time on it, and today's grant count.
- A short description of the specific thing you were opening, so the coach can talk about it rather than about "a website": the address, the page title, and where one exists a one-line summary — for a video, its title and channel; for a thread, its title and forum; for a search, what you typed. Each field is truncated (the address to 500 characters, titles to 200, summaries to 400).

Where that request goes depends on which path you're on:

- **Coaching credit** — to Intention's backend, which forwards it to the LLM provider Intention has contracted (currently Anthropic) under Intention's own key. The provider receives the conversation; it does not receive your entitlement token or any identifier of your account.
- **Custom API key** — **directly from your device to the provider you selected** (Anthropic, OpenAI, Groq, or Google Gemini), authenticated with your key. No part of your conversation passes through Intention's backend, and coaching itself never contacts it on this path — including the automatic coaching-credit requests described below, which check the route and are deliberately not sent while your own key is in use. The exception is deliberate and is yours to trigger: if you hold coaching credit as well, the buttons that are *about* that credit still work and still talk to the backend when you press them. Nothing from your conversations goes with them. Your key is sent in a request header, except for Google Gemini, whose API takes it as part of the request address instead — that is Google's design, not a choice Intention makes, and it is worth knowing if you are on a network that logs URLs.

Either way, handling by the LLM provider is governed by that provider's privacy policy.

To fill in that description of what you were opening, your device may also make one request **to the site itself** — YouTube's, TikTok's or Reddit's public preview endpoint, or, for anything else, a plain cookie-less fetch of the page's `<head>` to read its title. It carries no cookies, so it always sees the logged-out version of the page, and it goes to that site, not to Intention. The result is cached only for the current browsing session and is never written to disk.

If you have told Intention to always allow particular YouTube channels, opening a YouTube video on a blocked YouTube also sends that video's address to YouTube's same public preview endpoint, so Intention can tell whose video it is before deciding whether to stop you. It goes only to YouTube, carries no cookies, happens only when you have such a list, and the answer (the channel's handle) is kept in memory only, never on disk.

The store's own purchase receipt is also sent to Intention's backend each time you buy coaching credit, so it can be verified with Apple or Google. Apple and Google receive your payment details; Intention never does.

### Requests about your coaching credit

Coaching credit involves several further requests to Intention's backend. None of them carries any part of a conversation. The two described in detail below are the ones worth spelling out, because of what they could otherwise be mistaken for; the rest are the ordinary machinery of a purchase and are listed after them.

- **Looking for credit that a reinstall left behind** (`POST /v1/entitlement/recover`). Coaching credit is attached to a random identifier your device generates once and keeps — Apple's Keychain, or the Android app-backup file described under "Your controls" — because there is no account behind it to look you up by. When this device holds no working coaching credit, and only then, the app asks the backend whether a balance is still attached to that identifier. It sends the identifier and which store you bought through, and nothing else: no name, no email, no store account, no message content. Nothing is written to the backend's records on either the hit or the miss — the identifier you sent is not stored, and a miss creates nothing at all; a hit is noted in the ordinary server log described above, as the same one-way hash the log already carries for a coach request. Its answer is either your balance or "nothing here". A "nothing here" is remembered locally for 24 hours so the question isn't repeated on every settings open, which makes this at most one request per device per day; a "here it is" ends the asking altogether. Pressing "Restore credit from a previous install" in Settings sends exactly the same request on demand.

  We spell this one out because of what it could be mistaken for. A request that goes out per install, on a schedule, carrying an identifier that survives reinstalls, is shaped like an "is this copy still out there" ping — the very thing Intention deliberately does not do (there is no analytics, no crash reporting, and no uninstall callback). It exists only to give people back credit they paid for, it is not sent on the custom-API-key path, and this paragraph is here so that the shape of it is on the record rather than left to be discovered.

- **Your recovery code** (`POST /v1/entitlement/recovery-code`). Sent when you press "Show my recovery code", when you ask for a new one, and — on the one screen that appears immediately after a purchase, where writing the code down is the whole point — when that screen opens. It is never sent merely because you opened Settings: the block is shown open (it appears only in Chrome and Firefox, where the written-down code is the only way back to your credit), but it holds the code behind that press precisely so that opening Settings is not a request. It is authenticated with the entitlement token above and sends nothing but that request; what the backend keeps as a result is described under "What the developer collects".

  If your credit was bought before this feature existed, showing the code for the first time also re-sends your store receipt to `POST /v1/entitlement/verify` — the same receipt, to the same place, as when you bought it. It is how the backend recognises the older session; it grants nothing and buys nothing.

### The page your browser opens after you remove the extension

When you remove Intention from Chrome or Firefox, the browser opens a public page on GitHub explaining what was lost and how to recover coaching credit ([docs/LEAVING.md](docs/LEAVING.md)). This happens through `chrome.runtime.setUninstallURL`, entirely inside the browser and *after* Intention is already gone: no code of ours runs, there is no callback, and the address carries no identifier of any kind. **That request goes to GitHub, not to Intention — Intention is not told that you uninstalled it, and has no way to be.**

It deliberately does not point at Intention's backend, which writes the access log described above for every request it receives. Pointing it there would have turned every removal into a logged event — an uninstall ping — which is precisely the thing this policy says Intention does not do.

The remaining coaching-credit requests, for completeness, all to the same backend and none carrying any part of a conversation:

- `POST /v1/entitlement/verify` — hands the store's receipt over to be checked with Apple or Google. Sent when you buy credit, and again if a stored entitlement stops verifying or needs re-stamping.
- `POST /v1/entitlement/refresh` — asks what your balance is now, using the token you already hold. Sent when the app has reason to think its cached copy is stale.
- `POST /v1/entitlement/redeem` — sent when you type a code in, and carries only that code.
- `POST /v1/entitlement/code` — mints the short-lived code that links a browser to credit bought in the app. Sent when you press "Link a browser".

Apart from all of the above, from the requests to the site itself described earlier, and from a report you choose to send, Intention makes no network requests on any platform.

Where "not on the custom-API-key path" is claimed above, it means the request is not made *because of* coaching: the recovery requests check the route and ask nothing on it. It does not mean the four requests in this list are unreachable — if you bought coaching credit and later switched to your own key, pressing a button that is about that credit still sends the request that button is for. Nothing about your conversations goes with it, on any path.

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
- Save a copy of your blocklist from Settings → Blocking → Leaving Intention. The file it writes stays on your device; nothing is uploaded, and it deliberately excludes your API key, your coaching credit and your usage history.
- Uninstalling the extension or app deletes all locally stored data (blocklist, stats, context, entitlement, key) per your browser's or OS's standard app/extension-storage cleanup behavior. One exception on Android: the random identifier your coaching credit is attached to is included in Android's own app backup, deliberately, so that credit you have paid for is still yours if you reinstall. It is a random value with nothing else attached to it, and clearing the app's backup through your Google account removes it.
- There is no account and no telemetry opt-out to make. If you want the developer-side record of your balance removed, open an issue — the only data held is the hashed account identifier, the remaining balance, and any recovery code you asked for, all described above.

## Changes to this policy

If Intention's data flows change (e.g. a new provider integration), this file will be updated and the version history is visible in the project's git log.

## Contact

Intention is published by **MaybeItsSoftware Ltd**, a company registered in the United Kingdom, which is the data controller for the limited processing described above.

Questions about this policy: open an issue on the project's GitHub repository, or email <privacy@maybeitssoftware.co.uk>.
