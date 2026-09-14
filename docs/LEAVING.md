# Leaving Intention

_This is the page Intention opens in your browser after you remove it, and the
page the "Leaving Intention" card in Settings links to. It is written for
somebody who has already left, or is about to._

---

## Intention is gone from this browser.

Your blocklist, your stats and your coach's notes were stored in the browser
and went with it. There is no copy anywhere else — Intention has no account and
keeps nothing about you.

Your API key went with it too: Intention in a browser runs the coach on your
own provider key and nothing else, so paste the key in again after you
reinstall. There was no coaching credit to lose.

**In the Intention app (iPhone, iPad, Android)** your coaching credit is held
on Intention's backend against a random identifier, not against you, and it
usually survives. The app still knows the identifier the App Store or Google
Play gave it, so a reinstall on the same device asks the backend about that
identifier before it shows anybody a paywall, and the balance reappears on its
own the first time you open Settings. "Restore credit from a previous install",
in Settings → AI access, asks the same question on demand.

If your credit does not come back, open an issue on the project's GitHub
repository.

---

## What Intention actually does about removal, and what it does not

Intention is friction plus accountability. It is not a lock, and this page
exists partly so that nobody has to take that on trust.

**What happens when you go to remove it.** Loosening any rule in Intention
costs a conversation with the coach — that is the whole mechanism the product
is built on. Leaving is the biggest loosening there is, so it goes through the
same mechanism. On Chrome, Edge and Firefox, opening the page you remove
extensions from (`chrome://extensions`, `about:addons`) opens **one** Intention
tab beside it offering that conversation. On Android, opening Intention's own
App info page in Settings — or the Accessibility entry for its service — opens
that same conversation over the top of Settings, once.

That is the whole of it. It is an offer, not a checkpoint, and the section
below is how you get past it without taking the offer.

### How to actually leave

**Through the coach**, if you want to: Settings → Blocking → Leaving Intention →
**"Remove Intention"**. The conversation opens, the exit sits under it the whole
time, and if you set yourself a cool-off the wait starts when you ask. In the
Intention app, and on Apple, that button is a set of directions instead of a
button — no app can remove itself from a phone or a Mac, and a button that
removed only the Safari extension would be lying about what it did.

**Without the coach**, which involves nothing of ours and cannot be interfered
with:

- **Chrome / Edge / Brave** — `chrome://extensions` → **Remove**. Or right-click
  the toolbar icon → **Remove from Chrome**, which Intention cannot see at all.
  The tab it opens beside the extensions page is only a tab; close it and carry
  on.
- **Firefox** — `about:addons` → the **…** menu on Intention's row → **Remove**.
- **Safari on macOS** — drag Intention from `/Applications` to the Trash. To
  stop it without removing it, turn the extension off in Safari → Settings →
  Extensions.
- **iPhone / iPad** — touch and hold the app → **Remove App**. To stop the
  website blocking without removing anything, Settings → Apps → Safari →
  Extensions → Intention → off.
- **Android** — Settings → Apps → Intention → **Uninstall**, or touch and hold
  the icon → Uninstall. If the coach appears over that screen, press **Back**:
  Settings is exactly where you left it, and it will not come back for at least
  fifteen minutes. Turning the blocking off instead is Settings →
  Accessibility → **Intention App Blocker** → off.

Nothing in that list asks Intention's permission, and nothing in Intention is
capable of withholding it.

**What it never does:**

- It never navigates, reloads or closes the extensions page. You may well have
  opened it to manage a different extension — no browser API tells us whose row
  you are looking at — and taking that page away from you would not be ours to
  do.
- It never repeats. Every ending of that conversation — you leave, you stay,
  you close it, you say you were here for something else — buys **fifteen
  minutes** of complete silence, and any visit at all buys **ten**. There is no
  loop, by construction.
- It never hides the exit. **"Remove it anyway"** is enabled from the first
  moment the conversation appears. It is never on a timer, never disabled,
  never hidden, and it works whatever the coach says — including while a
  cool-off you set is still running.
- It never asks you to pay to leave. If you have run out of coaching credit,
  the leaving conversation still opens and the exit still works. Every other
  conversation in Intention shows the paywall instead; this one does not.

**What it cannot see at all**, and no extension can:

- Removing Intention from the toolbar icon's right-click menu.
- *Disabling* rather than removing. Our worker is already stopped by the time
  that happens, so there is nothing of ours left to notice it. The one API that
  could report it (`chrome.management.onDisabled`) only fires for *other*
  extensions and needs a permission that adds a frightening install-time
  warning for zero capability, so Intention does not request it.
- Deleting the browser profile.

### The cool-off

In Settings → Blocking → Leaving Intention you can put a wait in front of
removal: none, an hour, 24 hours, or 3 days. Making it **longer** saves
straight away. Making it **shorter** means convincing your coach, in exactly
the same way as any other rule you set for yourself — because shortening the
wait *while you are trying to use it up* is the weak-moment decision the
product exists to slow down.

The cool-off is not a lock either, in two separate ways. During the wait, the
settings card carries a **"Remove it now anyway"** button, and it works. And
the wait only ever stands in front of *Intention's own* button: your browser's
Remove, and your phone's Uninstall, are untouched by it and could not be
otherwise. What the wait buys you is the gap between deciding and doing, and
nothing more than that.

### Take your list with you

The same card has **"Save a copy of your list"**. It writes
`intention-list-YYYY-MM-DD.json`: your blocked sites and apps, their limits,
the answers you gave about each one, the cool-off you had set, and the "about
you" your coach was working from. It does **not** contain your API key, your
coaching credit, your usage history, your stats or any conversation.

It is a file you keep, not a restore point — there is no "load this file"
button in Intention today, so coming back means putting the list in again with
that file open beside you. Which is still the difference between a list you
have and a list you have to remember.

---

## Per platform

| Platform | What Intention can do about removal |
|---|---|
| **Chrome / Edge / Brave** | Open a tab beside `chrome://extensions`, once. Nothing else. |
| **Firefox** | The same, for `about:addons`. `management.setEnabled()` does not exist in Firefox, `about:addons` is not scriptable, and `declarativeNetRequest` cannot touch it. |
| **Safari (macOS)** | Nothing, honestly. The app is a `.app` in `/Applications` and can be dragged to the Trash; the extension toggle lives in Safari's own settings where no extension can reach it. |
| **Safari / Intention on iPhone and iPad** | Nothing. Apps are removed by touch-and-hold → Remove App. Turning the Safari extension off in Settings stops the website blocking without removing anything. |
| **Android** | The Intention app is uninstalled from Settings like any other app. |

On Apple builds the Settings card shows those instructions instead of a
"Remove Intention" button, because `chrome.management.uninstallSelf()` there
would remove the *Safari extension* and leave the app exactly where it was —
technically a removal, but not the one the button promises.

---

## If you want a real lock rather than a speed bump

Your browser has one and Intention does not. Both of these are applied **by
you, to your own machine**, from outside the extension — Intention cannot
install them, cannot check whether they are on, and cannot remove them.

**Chrome / Edge — `ExtensionInstallForcelist`.** A force-installed extension's
Remove button is greyed out.

- Windows: `HKLM\SOFTWARE\Policies\Google\Chrome\ExtensionInstallForcelist`
- macOS: an Apple configuration profile carrying the same key.

**Firefox — `policies.json` with `ExtensionSettings`.** Set
`"installation_mode": "force_installed"` for the add-on; Mozilla's own wording
is that "the extension is locked when the policy is deployed, so the user
cannot disable or remove the extension". The `BlockAboutAddons` policy removes
access to `about:addons` entirely.

Both need administrator rights on your own computer. That is the point: it is a
decision you make once, deliberately, somewhere other than in front of the
thing you are trying not to do. It is also genuinely harder to undo than
anything in this app, so make it on purpose.

Intention deliberately does **not** ship the equivalents on mobile — an Android
device-admin uninstall lock, or iOS's device-wide "Deleting Apps: Don't Allow".
The iOS one is device-wide rather than per-app (while it is on, *nothing* on
the phone can be deleted), it is not guaranteed anyway because turning off
Screen Time access drops it, and there are unresolved reports of it sticking on
after the app that set it is gone, with a device reset as the only escape.
Every other part of this design degrades gracefully; that one can leave a
stranger's phone in a bad state, so it is not in the product.

---

## Privacy

Nothing on this page is a beacon. Chrome and Firefox open it *after* Intention
is already removed, by way of `chrome.runtime.setUninstallURL` — there is no
callback, nothing of Intention's is running, and the address carries no
identifier of any kind. The request goes to GitHub, not to Intention. **We are
not told that you uninstalled it, and have no way to be.**

That URL deliberately does not point at Intention's own backend, which writes
an access-log line for every request it receives. Pointing it there would have
made every removal a logged event — an uninstall ping — and the privacy policy
forbids it.

See [PRIVACY.md](../PRIVACY.md).

---

## Thanks for trying it

If it did not work for you, the project would genuinely like to know why —
open an issue. And if it did work, and you are leaving because you do not need
it any more: that is the outcome the whole thing was built for.
