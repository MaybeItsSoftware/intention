# UX backlog

Follow-up work from the onboarding + settings audit (August 2026). Everything
here was found during that audit and deliberately *not* done at the time — the
reason is recorded per item, because "we knew and chose not to" and "we missed
it" need different responses later.

Ordered roughly by what unblocks the most.

---

## 1. Decisions needed before anyone writes code

### 1.1 The second onboarding path is fully built and unreachable — DELETED

`buildSetupSystemPrompt()` and `SAVE_ONBOARDING_TOOL` (`shared/prompts.js`), the
`mode: 'setup'` branch of `handleChat` and the `save_onboarding` executor
(`shared/background.js`) implemented a *conversational* onboarding — the coach
interviewing you about your goals, triggers, sites and limits, then persisting
the result. All of it is gone, along with its tests and the `'setup'` transcript
namespace that only it wrote to.

Deleted rather than wired up, because reading the executor closely turns the
"two honest options" into one. It wrote exactly four keys — `userContext`,
`blockedDomains`, `domainLimits`, `setupComplete`. There is no way for it to
write `blockedApps`, `appLimits`, `serviceReasons` or a blocking mode, so on
Android and iOS — the two platforms where apps are most of what people block —
it would have flipped `setupComplete` on a setup that blocks no apps at all and
left the wizard with nothing to reopen. It also *replaced* `blockedDomains`
wholesale from model output rather than merging, so a second pass through it
silently dropped whatever the first agreed. It normalised domains with its own
inline `replace(/^www\./, '')` chain instead of the `normalizeDomainInput` the
rest of the product uses. And `resolveAIRoute()` returns `locked` until there is
either a key or coaching credit, both of which are set up *after* the welcome
step — so on any build a store reviews, nobody who could reach it could use it.

It never had a caller: `git log -S "mode: 'setup'"` across all history returns
only the two test files and this document. It was phantom code from the day it
landed, not a feature that lost its UI.

The one thing worth keeping from it was the question about the legitimate, brief
reasons someone might still need a blocked site — and the wizard already asks
that, per service, at `options-wizard.js` ("When do you consider yourself to have
legitimate reason to use X?"). If the conversational path is ever wanted back,
git has it; but it should be rebuilt against the wizard's storage shape rather
than restored.

### 1.2 Store copy still leads with BYOK

- `shared/manifest.base.json` — *"AI-powered focus gate. Bring your own LLM to
  coach you past distracting sites."*
- `Intention Android/fastlane/metadata/android/en-US/full_description.txt` —
  leads its Key Features with **"Bring Your Own Key (BYOK)"**.

Both contradict the README's credit-first positioning. They now *also* undersell
the browser builds, where a provider key and coaching credit are offered side by
side as equals.

Deferred because changing published store listings is a release-facing decision,
and the Play description in particular is reviewed.

---

## 2. Native copy that needs a device before it ships

Three surfaces were changed or want changing in code that cannot be run from a
dev machine without Xcode/an emulator. Changing strings you cannot see rendered
is how a label overflows its container or contradicts the button under it.

### 2.1 The iOS shield copy is committed but unverified

`Intention Apple/iOS (Shield Extension)/ShieldConfigurationExtension.swift` now
reads:

- title: `"{App} is blocked"`
- subtitle: *"You chose to block this. To ask for time, open Intention and go to
  Unlock → Ask your coach for time."*
- primary button: **"Close — ask Intention for time"** (was `"OK"`)

**This has never been rendered.** The button label in particular is much longer
than `OK` and Apple gives no guarantee about how `ShieldConfiguration.Label`
truncates. Build to a device with a shielded app and look at it before release.

Related, and unfixable: `ShieldActionExtension` can only return `.close` — a
shield cannot launch another app. The copy is the entire remedy available.

### 2.2 Android's first-ever screen is a bare permission demand

`Intention Android/app/src/main/java/.../MainActivity.kt` — before the WebView
is ever shown, a non-skippable full-screen native gate asks for Accessibility
permission:

> **Accessibility permission required**
> "Intention needs Accessibility permission to coach you when you open
> distracting apps."

A new user meets this *before any explanation of what Intention is*. On iOS the
equivalent asks (Safari extension, Screen Time) are deliberately introduced by a
welcome step that names them first, precisely so a permission prompt reads as
part of a plan rather than an app overreaching. Android has no such step.

Suggested: a short product intro ahead of the gate, reusing the welcome step's
framing. Note the gate is genuinely non-skippable — app blocking does not work
without it — so this is about sequencing, not about making it optional.

Deferred because it is Kotlin outside the shared web layer and could not be run
or screenshotted during the audit. It is squarely an onboarding problem and
should not stay deferred long.

### 2.3 The macOS host app has no onboarding at all — RESOLVED

The Mac app no longer has a page of its own. It loads the shared
`options.html` exactly as the iPhone app does, with the coach running in-app
(`BackgroundJSHost`), so a Mac user gets the real wizard on first launch — its
Safari step reads the extension's actual on/off state and opens Intention's row
in Safari's Extensions settings. The window is named "Intention", the
"Quit and Open…" button is gone, and credit is bought through the shared
paywall. `Main.html`, `Script.js` and `Style.css` are deleted.

### 3.1 "Absolute max" vs "Daily limit" vocabulary split — RESOLVED

The UI said **"Daily limit"** while the coach said **"absolute max"**, so a user
could read "Daily limit: 10 min/day" on screen and then be told by their coach
that they had hit their "absolute max".

Settled on the coach's word, since that vocabulary is also asserted throughout
`tests/prompts.test.js`: the row field, the Blocked sites subtitle and the
add-dialog field are all "absolute daily max" now, and the row's ⓘ says what it
means — the most time you could genuinely need in one day, a ceiling rather
than a target.

### 3.2 The save model is still mixed

Row limits, row modes, add/remove and preset chips save themselves. The coach
instructions and the two context questions now also save on blur. Still needing
an explicit button press: **Blocking mode** (`save-blocking-mode-btn`), **Save
context** (`save-context-btn`), and the **Advanced → custom key** fields
(`save-provider-btn`).

Nothing marks which controls are which. Either finish the move to autosave or
give the remaining three a visible dirty state. The API key field is a
reasonable permanent exception — autosaving a half-typed key is worse than not.

### 3.3 `maxGrants: 3` is written everywhere and shown nowhere

Every domain and app limit entry gets `{ maxGrants: 3, maxMinutes: 10 }`. The
daily *grant* cap is real, enforced, and central to how the coach escalates —
and it appears in no UI at any point. A user only discovers it by hitting it.

### 3.4 The coach-instructions help text dumps 15 raw template tokens

`shared/options.html` lists `{{questions}} {{usage}} {{domain}} {{grants_today}}
…` with no explanation of what any of them expand to. (Said 13 until it was
counted on the `feat/five-features` branch; it is 15 — the same stale-count
failure §7.5 is about, one file over.) It is inside an
`(advanced)` disclosure, so the audience is self-selecting — but an example of
one rendered prompt would be worth more than the list.

### 3.5 Overlay CSS is duplicated in three places

`shared/content.css`, the `OVERLAY_CSS` string constant at the top of
`shared/content.js`, and an inline `<style>` in `shared/coaching.html`. Any
overlay style change must land in all three or the gate looks different
depending on how it was reached. Worth collapsing.

### 3.6 Pre-existing `innerHTML` lint warnings

`npm run lint:firefox` reports 0 errors and **2** `UNSAFE_VAR_ASSIGNMENT`
warnings, both pre-existing: `shared/gate-ui.js:147` (`renderStatsRow`, which
interpolates background-computed minute counts into a row of stat cells) and
`shared/options.js:1322` (`renderStats`, which interpolates the same counts into
the settings stats panel). The count said 4 until it was re-measured on the
`feat/five-features` branch — see §7.5, which is also where the second line
number moved from 974. `options-rows.js:585` builds the
per-row behaviour `<option>` list with `innerHTML` too, but from a wholly
static string, so `web-ext` does not flag it and it is not part of the
baseline. The interpolated values are all internal, so this is hygiene rather
than a live hole — but it sits awkwardly next to the file's own stated
"model-authored text: `textContent` only" discipline.

---

## 4. Bigger bets

### 4.1 There is no toolbar popup

Clicking the extension icon opens the full settings page in a tab
(`chrome.action.onClicked` → `openOptionsPage`). There is no lightweight
surface for the things a focus tool is asked most often: what have I spent
today, am I currently in a pass, pause for an hour, block this site I'm on.

This is a new surface (popup HTML, manifest change, a product decision about
what belongs in it), not a repair — which is why it was left out of the audit
work.

### 4.2 Nothing can detect where users drop off

By design and by policy there is no telemetry anywhere: `PRIVACY.md` commits to
"no analytics, no crash reports" on the custom-key path and "no telemetry
opt-out to make" generally. Server-side there is operational logging only
(`request`, `llm_spend`, `balance_adjust`, errors), keyed to a non-reversible
hash.

That is a genuine product value and worth keeping. But it means every problem in
this backlog was found by reading code, and the next one will have to be too.
Nothing will surface wizard abandonment, paywall bounce, first-gate abandonment,
or iOS users failing to find the Unlock tab.

If that is ever worth changing, the smallest honest version is a **local-only**
funnel the user can see and export themselves — never transmitted — which would
at least let a bug report carry it.

---

## Working notes

- Edit `shared/` only, then `npm run sync`. `build.sh` and CI both fail on
  drift; the husky pre-commit hook runs `npm test` only, so drift passes locally
  and fails in CI.
- `tests/options-wizard.test.js` asserts that every id `options.js` looks up
  exists in `options.html`, and that every wizard step is both reachable and
  hidden by default. It is the cheapest guard against breaking the wizard's
  wiring and should be kept passing.
- `tests/options-domain.test.js` loads `options.js` in a `vm` against a thin DOM
  stub. Only *function declarations* are readable off the vm context — `const`
  and `let` stay in the script's lexical scope — so anything that needs testing
  should be a `function`, or be reached via `vm.runInContext`.

---

## 5. Closed by the August 2026 retheme

Recorded here because the reasons in §3 explained why they were left, and
someone reading this file needs to know they no longer apply.

- **3.5 (overlay CSS duplicated in three places)** — partly closed.
  `shared/content.css` and the `OVERLAY_CSS` literal in `content.js` are now
  byte-identical and `tests/parity.test.js` asserts it, so the pair cannot
  drift again. The duplication itself has to stay: Safari enforces the host
  page's CSP against extension-origin requests, which is why the overlay
  injects its own copy at runtime. **Edit `content.css`, then paste it back
  between the `OVERLAY_CSS` backticks** — and keep backticks out of that file,
  since it is pasted into a JS template literal.

  What the audit called a "deliberate superset" was in fact drift: the
  `.int-primary-btn` rule (the simple-mode "Take N minutes" button) existed
  only in the JS copy and rendered only because the runtime injection wins.

- **The paywall's two skins** — closed. `.int-pw-*` now lives in one file,
  `shared/paywall.css`, linked by both `options.html` and `coaching.html`.
  This was worse than "divergent": `coaching.html` styled twelve of the
  nineteen classes `renderPaywall()` emits, so on browser builds the
  side-by-side "own key / coaching credit" routes rendered as raw browser
  defaults on the coaching page. The stylesheet is self-contained (its own
  inputs and buttons) because `coaching.html` has no global form styling to
  inherit.

## 6. New follow-ups from the retheme

### 6.1 The Android native gate is still a dark slab

`MainActivity.kt` hardcodes `#0f1115` / `#e7e7ea` for the full-screen
accessibility-permission gate. Now that the web layer follows the system
theme, a light-mode Android user meets a near-black screen in front of a chalk
app. Not fixed here for the reason §2 gives: it is Kotlin that cannot be
rendered from a dev machine, and §2.2 already wants that screen redesigned
rather than recoloured. Do both at once, on a device.

### 6.2 The macOS host shell is untouched — RESOLVED

Deleted along with §2.3: there is no Mac-only shell left to theme.

### 6.3 The browser build's "use your own API key" route has no form on the
coaching page

Visible now that the route cards render at all: on `coaching.html` the key
route shows its description and nothing to type into, because `coaching.js`
does not pass `onSaveKey` to `renderPaywall()`. `options.html` passes it and
shows the provider select and key field. Either wire it up or say plainly that
the key is entered in settings.

Still open after `feat/five-features`, and now half-decided, which is worth
recording because the decision reads as a fix and is not one. `coaching.js`
gained a comment stating that the key field is withheld there deliberately —
same reasoning as the store redemption sheet beside it, that a blocked page is
the worst possible moment to send somebody off to fetch a credential — and that
Settings → AI access is where the route lives. That settles which of the two
options this item offered is wanted: **say plainly**, not wire up. Nobody has
said it. `buildKeyRoute` still renders a heading and a description with no
button and no field, because `coaching.js` passes neither `onSaveKey` nor
`onUseOwnKey`, so the card a browser user actually meets is inert while the
reasoning for its being inert lives in a comment they will never read. One
sentence in `buildKeyRoute`'s no-callback branch closes it.

### 6.4 Contrast is now measured, not eyeballed

`npm run test:smoke:contrast` walks every visible text node in the wizard, all
four settings tabs and the coaching page, in both themes, and fails on
anything under WCAG AA. It caught white-on-azure at 3.8:1 across every primary
button — which is why `--primary-solid` exists as a separate token from
`--primary`. Run it after any colour change; it is much faster than looking.

## 7. In flight on `feat/five-features` — what a device still has to settle

The branch shipped five things — leaving Intention, per-section blocking,
purchase recovery with a visible balance, one-screen setup, and page-scoped
passes — plus the macOS disable notice, which rode along with them. All of it
was built on a machine with no iPhone, no Android handset, no Xcode run and no
sandbox App Store account. Everything below is code that is *written and
shipping* whose behaviour nobody has watched happen. It is here rather than in
a commit message because §4.2 is still true: there is no telemetry, so nothing
will ever tell us these were wrong. Someone has to go and look.

One of the five is deliberately absent from this section: the setup wizard is
ordinary web UI, `tests/options-wizard.test.js` and
`tests/smoke/wizard.smoke.mjs` both drive it, and there is nothing about it a
device would settle that this repo cannot. Its absence is an answer, not a gap.

The items were first written while the work was in flight and re-checked
against the shipped files at the end of it; where the code moved underneath
one, the item was corrected rather than left standing (see §7.3, §7.5). The
file paths are the contract.

### 7.1 The macOS disable notice, seen and confirmed

`Intention Apple/macOS (App)/AppDelegate.swift` now imports `SafariServices`
and calls `SFSafariExtensionManager.getStateOfSafariExtension(withIdentifier:)`
from both `applicationDidFinishLaunching` and `applicationDidBecomeActive`,
behind a `stateCheckInFlight` guard so the two entry points cannot race into two
alerts on the same launch. The identifier is the existing
`extensionBundleIdentifier` constant from `Shared (App)/ViewController.swift:19`
— `uk.co.maybeitssoftware.intention.Extension`, which is the
`PRODUCT_BUNDLE_IDENTIFIER` the Xcode project sets on both extension targets.
It was read out of the project, not guessed; if the extension target is ever
renamed, this breaks silently and quietly, in the direction of saying nothing.

What it does with the answer is deliberately narrow. Two `UserDefaults` keys:
`IntentionSafariExtensionWasEnabled`, set the first time we ever see the
extension enabled, and `IntentionSafariExtensionDisableNoticeShown`, set when we
put the notice up and cleared the moment the extension comes back. So it speaks
once per *disable event* rather than once per launch, it never speaks on a fresh
install where the extension has never been on (that is the host page's job, and
a second nag over the top of the first is worse than none), and a failed query —
Safari not running, a launch-time race — is treated as no evidence at all rather
than as "it's off". The alert reads *"Intention's Safari extension is turned
off" / "Blocked sites aren't being blocked. You can turn it back on in Safari's
Extensions settings — or leave it off, and this won't ask again."* with **Open
Safari Settings** and **Leave It Off**; the first button calls
`SFSafariApplication.showPreferencesForExtension`, the same call the host page's
button makes. It is presented as a sheet on our own window when there is one and
a modal only when there is not.

**Run on a Mac, 2026-08-29, and it works.** The sheet appears attached to the
window, the two-line `informativeText` sets without clipping at the app's
default 646pt width, and the notice re-arms: re-enabling the extension and
bringing the app forward clears `…DisableNoticeShown`, so the next disable
speaks again. `getStateOfSafariExtension` returns a usable state from both
entry points. Verified against a locally built `build/Intention.app`, with the
`UserDefaults` read back out of the app's sandbox container to confirm each
transition rather than inferred from the alert alone.

One property to keep in mind rather than fix. The re-arm needs the app to come
to the *front* while the extension is enabled, because
`applicationDidBecomeActive` and `applicationDidFinishLaunching` are the only
two moments state is sampled. Someone who reads the notice, turns the extension
back on in Safari and never returns to the app has not been observed as
re-enabled, so a later disable stays quiet until the next app launch. That was
mistaken for a defect on first pass; clicking between the two apps a few times
re-arms it exactly as designed. It self-heals on launch, and the alternative —
polling, or dropping the once-per-event guard — buys a nag. Left as is.

(The host page this note once left alone is gone — see §2.3. The app now shows
the extension's real state in the settings sidebar and the wizard.)

### 7.2 Instagram and TikTok page scope ships inert on purpose

Page-scoped passes ("fifteen minutes on *this video*", not on YouTube) work by
computing a stable key for the page you are on and re-gating the moment
`location.href` moves to a different key. `SCOPE_SUPPORTED_HOSTS` in
`shared/parts.js` ships enabled for YouTube, Reddit, X/Twitter, GitHub and the
generic origin+path fallback. Instagram and TikTok are listed separately in
`SCOPE_HOSTS_TO_VERIFY` and are **inert**: they compute no key, so a pass on
those hosts stays whole-site, exactly as it is today.

They are held back because the entire feature rests on an assumption nobody
here can test: that the URL actually changes when you swipe from one reel to the
next. On both of those apps the feed is the product and the URL is decoration.
If `location.href` does not move, a page-scoped Instagram pass does not expire
when you leave the post you asked for — it silently becomes N minutes of Reels,
which is precisely the failure this feature exists to prevent, delivered under a
label that says it cannot happen. Shipping it wrong is worse than shipping it
off, because "scoped to this post" is a promise.

The device pass is small: open instagram.com, start a scoped pass on a single
post, swipe, and watch whether the gate comes back. Same for a TikTok video.
If it does, moving each host from `SCOPE_HOSTS_TO_VERIFY` into
`SCOPE_SUPPORTED_HOSTS` is a one-line change per host and the key builders
(`ig:p:<code>`, `tt:video:<id>`) are already written. If it does not, they stay
where they are permanently and the list becomes the record of why.

### 7.3 The Android in-app section catalogue is a best-effort guess

Distinguishing Reels from DMs *inside the native Instagram app* — as opposed to
on instagram.com, which the extension can read directly — means matching view
ids and content descriptions off the accessibility tree of an app we do not
control. Those ids are internal, undocumented, unversioned, and differ between
app releases and OEM skins. They cannot be harvested without a physical device
with those apps installed: no emulator image ships them, and nothing in this
repo can generate them.

It ships anyway, with the catalogue marked provisional and **every signal in it
UNVERIFIED** — each `PartSignal` in `AppParts.kt` carries an `evidence` string
that begins "UNVERIFIED — needs a device pass", and nobody has watched a single
one of them fire on real hardware.

So the shipped consequence, stated plainly because it is what a user meets:
**until that device pass lands, a section rule on an app behaves as "block the
whole app".** Both scopes fail **closed**, in both of the two ways a check can
fail — a rule naming an id this build could never produce is refused whole, and
a screen we walked and did not recognise gates as well. `only` used to fail
open, on the argument that we do know what Reels looks like and gating the whole
app takes away DMs nobody asked us to touch. That argument assumed a table that
mostly works with a miss as the rare exception; with a table unverified on every
signal the rare exception *is* the normal case, and "block only Reels" would
have meant an Instagram that never blocks at all — a silent unblock, which is
the one failure a self-control product may not have. An app that stays blocked
is noticed in seconds and is one tap from being changed, from the gate it shows
you.

Fail-closed is only honest if it is loud, and it is said in two places: a
per-target miss counter (`recordMiss`) puts a card in front of the user inside
the app once it passes `MISS_WARNING_THRESHOLD` inside `MISS_WINDOW_MS`, and
because that card lives in the app they are deliberately not opening,
`CoachingActivity` also puts one line above the coach naming why the whole app
is blocked. A section rule that never matches otherwise looks identical to one
that works, and that is the one state a user cannot debug.

Two things to settle on the device pass, not before it. First, the id table
itself: one session with each app, walking Reels, DMs, Explore and the main
feed, is enough to fill it, and it should be redone whenever either app makes a
visible redesign. Second, whether `only` should go back to failing open once
the table is trustworthy. It is a real question — a verified table changes the
premise the current answer rests on — and it is not a one-line change, because
three things say the same thing today and would all have to move in one commit:
`AppParts.verdict()`, `resolvePartVerdict` in `shared/parts.js` (which has
always failed closed in both directions, and which the Kotlin was brought into
line with rather than the other way round), and `PARTS_APP_DEGRADE` in
`shared/options-rows.js`, which is that rule written in the user's words. Two
implementations of one product promise disagreeing about what happens when they
are confused is a bug waiting to be reported as inconsistency; they agree right
now, and the device pass is the moment someone will be tempted to break that.

This also reopens a line the build plan had drawn: in-app part detection was
originally cut precisely because the ids could not be harvested. It is back in
with the catalogue explicitly marked provisional, which is a different bet from
the one that was rejected — but it is the same risk, and it does not clear until
someone runs it.

### 7.4 The Apple `appAccountToken` case question — do NOT "fix" it by normalising

`stableAccountToken()` in `Intention Apple/Shared (App)/IntentionStore.swift`
returns a `UUID`, and `.uuidString` on it is **uppercase**. That string is what
the client hands StoreKit as `appAccountToken` and what the backend turns into a
balance key via `subjectFor(platform, accountToken)`
(`server/src/tokens.js:86`) — a plain `sha256` of `"apple:<token>"`, which is
case-sensitive by construction.

If the App Store Server API ever echoes that token back **lowercase** in a
verified transaction, then two grants for the same person hash to two different
subjects and land in two different balances. That is not a risk this branch
introduces; if it is happening it has been happening in production, and the
symptom is a promo-redeemed grant that a bought top-up appears not to add to
(or vice versa) with nothing anywhere reporting an error. The new
`POST /v1/entitlement/recover` absorbs it for recovery specifically —
`accountTokenCandidates()` (`server/src/app.js:589`) tries the token as-is,
lowercased and uppercased, and returns the first that has a balance record — but
that is a plaster on one endpoint, not an answer.

Settling it needs a real sandbox purchase and the JWS it returns: read
`appAccountToken` out of the decoded payload and compare it byte-for-byte with
what the app sent. Until someone does that, this is an open question, not a
known bug.

**Whatever the answer is, `subjectFor()` must not be changed to normalise
case.** Every balance that exists today is keyed by the hash of whatever casing
was used when it was created. Lower-casing (or upper-casing) inside `subjectFor`
re-keys all of them at once and every existing user's credit disappears, with no
migration possible, because the hash is one-way and the server has never stored
the token it hashed. If the two-balance problem turns out to be real, the fix is
a *reconciliation* — find the pairs, merge the balances, keep both keys
resolving — not a normalisation. This paragraph exists because "just lowercase
it" is the obvious one-line fix and it is catastrophic.

### 7.5 §3.6's warning count was wrong — we missed it

§3.6 said `npm run lint:firefox` reports **4** `UNSAFE_VAR_ASSIGNMENT`
warnings. Re-measured on this branch with
`npx web-ext lint --source-dir="Intention Firefox" --ignore-files env.txt`, the
real figure is **0 errors, 0 notices, 2 warnings** — `gate-ui.js:147` and
`options.js:1322`. §3.6 has been corrected in place.

Re-measured again at the end of the branch, after all five features had landed:
still **2**, still those two functions. The second one is written here as
`options.js:1322` because that is where `renderStats` now sits — it was 974 when
this item was first written, and the file grew by nearly four hundred lines
underneath it. Which is the same trap one turn smaller: a baseline recorded as a
line number goes stale every time anything above it moves, and "the warning is
not on the line the backlog says" is indistinguishable from "there is a new
warning" to whoever checks next. Re-run the command rather than trusting either
number, and correct this line when it moves again.

Recording it separately because of how a stale baseline fails. Every one of the
five features on this branch adds DOM, and the whole rule about building it with
`createElement`/`textContent` is enforced by nothing except a reviewer comparing
`web-ext lint`'s warning count against a number written down here. Against "4",
a change that introduced two fresh `innerHTML` assignments would come back
clean and get waved through as "no new warnings" — the check would report
exactly what it was told to expect while the thing it exists to catch walked
past it. The baseline is **2**, and the two named lines are the only ones
allowed to be in it.

This one is "we missed it", not "we knew and chose not to": the number was
written from memory rather than from a run, and it went unchallenged through a
retheme. Anything in this file that is a *count* should be re-measured before it
is relied on.

### 7.6 Firefox's DNR rule ordering has never been checked — we knew and chose not to

`domainsNeedingRedirect()` keeps a blocked domain's priority-1 `redirect` rule
alive for the life of a **page-scoped** pass, so every other page of that site
still gates, and leans on the priority-2 `allow` session rule
(`registerSessionRule`) to let the one granted address through. That is the only
construct in the extension that needs two *kinds* of DNR rule to coexist for one
host, and it needs them resolved in one particular order.

The order is verified on Chromium only — `tests/smoke/gate.smoke.mjs` drives a
real scoped grant through a real browser and asserts the user lands on the page
the pass was granted for. **Firefox's MV3 `declarativeNetRequest` is a partial
implementation and nothing in this repo runs against it.** The comment that used
to sit in `domainsNeedingRedirect` said exactly that, about exactly this
construct, while the construct was switched on unconditionally.

So `allowOutranksRedirect()` now gates it: on Firefox a page-scoped pass drops
the domain redirect exactly as a site pass does, and the scope is enforced by
the content script's overlay alone (`sessionCoversUrl` plus the drift screen) —
which is how Safari enforces every pass today, so it is a shipped path and not a
new one. What that costs on Firefox is the *page flash*: other pages of the site
load before the overlay covers them. What it avoids is the trap — if Firefox
resolves redirect over allow, the granted page redirects to `coaching.html`,
`coaching.js` sends the user back to `grantedSession.scope.url`, and it
redirects again, for the whole length of a pass they paid a conversation for.
Between "the block is held a beat later" and "no way onto the page you were
granted", only one of those is a store-removal bug.

**To close this** someone needs a Firefox with the extension loaded — no CI
runner here has one — and has to check two things, in this order:

1. Does a priority-2 `allow` session rule beat a priority-1 `redirect` dynamic
   rule for a `main_frame` navigation?
2. Does Firefox honour a session rule's `tabIds` condition? If it does not, the
   allow rule is not per-tab and the whole scheme is wrong there for a second,
   independent reason.

Both yes, and `allowOutranksRedirect()` can return `true` for Firefox and this
item closes. Either no, and the current degrade is the permanent answer and
should be written up as intended behaviour rather than as a gap.

One trap to avoid on the way: the first version of the detector was "Chromium is
the runtime with no `browser` namespace". Chrome exposes `browser` as an alias of
`chrome`, so that test declared the one *verified* engine unverified and
degraded every scoped pass on it. The smoke suite now asserts
`allowOutranksRedirect()` directly against the browser it runs in, which is what
caught it. Any replacement detector must keep that assertion passing.

### 7.7 The Settings view ids the leaving interposition reads are not public API

`RemovalSurfaceMatcher` (`Intention Android/app/src/main/java/.../RemovalSurface.kt`)
answers one question — "is Settings showing *Intention's own* page?" — and it
answers it out of the Settings app's own view hierarchy, which is not an API
anybody promised us. The literals it rests on are `:id/entity_header_title` (an
app-details header whose *text* is the app the page is about),
`:id/uninstall_button`, and a page-level toggle bar under one of
`:id/main_switch_bar`, `:id/settings_main_switch_bar` or `:id/switch_bar` —
five ids, none of them ours. The one anchor that IS ours is the first 40
characters of our own service description, which Settings renders under that
toggle and nowhere else; it is there precisely because the ids can go missing
on a skin.
The packages it will even look inside are a fixed set —
`com.android.settings`, `com.samsung.android.settings`,
`com.miui.securitycenter`, `com.oplus.settings`, `com.coloros.settings`
(`IntentionAccessibilityService.kt`). Every one of those came from reading, not
from watching a device.

The two ways it can be wrong are not symmetric, which is why it shipped:

* **Wrong in the quiet direction** — an OEM renames the header id or the switch
  bar, or ships a Settings package not in the set, and the matcher answers
  false. Nothing happens: no conversation, no tab, no card. A user on that phone
  simply removes Intention with no offer of a chat, which is a feature that did
  not fire rather than a feature that misbehaved.
* **Wrong in the loud direction** — a shape matches on a page that is *not*
  ours, and we launch an activity over the top of somebody's Settings. That is
  the shape Play pulls accessibility apps for, and the head of `RemovalSurface.kt`
  records the version of exactly that bug this one replaced: matching our
  service label anywhere on screen matched every row of Settings →
  Accessibility, so a user who went there to set up TalkBack got walked over
  repeatedly. Both shapes are now conjunctions for that reason, and
  `LeavePolicy` puts durable floors under how often it can happen at all.

**Needs at least two devices**: something AOSP-ish (a Pixel) and a Samsung,
because One UI is the skin most likely to have renamed these and the most
widely held. Walk four screens on each — Settings → Apps → Intention, that page
scrolled to the uninstall button, Settings → Accessibility (the *list*, which
must NOT match), and the Intention App Blocker detail page under it — and check
that the conversation appears on exactly the first two and the fourth.
`RemovalSurfaceMatcherTest.kt` pins the logic against made-up nodes, which is
the half that can be tested here; whether real nodes look like those made-up
ones is the half that cannot.

### 7.8 The Play Permissions Declaration Form is out of date — RELEASE BLOCKER

This is the one item here that is not "someone should look". It is a thing that
must be done *before* the next `publish-android.yml` run, and the APK is not
publishable until it is.

`accessibility_service_description` in
`Intention Android/app/src/main/res/values/strings.xml` now names **three**
uses, where the published declaration describes one:

1. which app is in the foreground (and, in supported browsers, the address bar)
   — the original, already declared;
2. **which section of that app is on screen** (Reels rather than messages), so a
   rule that blocks only part of an app can be honoured — see §7.3;
3. **whether Settings is showing Intention's own page**, so the leaving
   conversation can be offered once before someone switches the blocking off —
   see §7.7.

Both new uses are read-only and rule-based: the service never calls
`performAction`, and the coach is never shown an accessibility node or asked
what to look for. That is the substance of what the form has to say, and it is
already written out at the head of `AppParts.kt` and in the leaving section of
`IntentionAccessibilityService.kt` — the work is transcribing it into the
console, not deciding it.

Being out of date is worse here than being thin. A user-facing description that
names a use the declaration does not is the exact mismatch a policy review
looks for, and it is now shipped in the APK's own strings where a reviewer
reads it first.

**And the store listing itself now says something untrue.**
`Intention Android/fastlane/metadata/android/en-US/full_description.txt` carries
an ACCESSIBILITY SERVICE DISCLOSURE block reading "Intention **only** monitors
the package name of the foreground app to check if it is blocked" and "It does
not read, capture, or transmit any on-screen text". The first half stopped being
true when section detection landed — `AppParts.detectPart` walks the node tree
reading view ids and content descriptions — and again with the removal
interposition, which reads node text in Settings. The second half is still true
in the part that matters, and is the sentence to keep and sharpen: nothing read
is transmitted, stored beyond a local miss counter, or shown to the model. But
"only the package name" has to go, in the same session as the declaration form.

Where it has to go is the trap. `fastlane/Fastfile` passes
`skip_upload_metadata: true` deliberately — "the store listing is edited in the
Play console, not from here" — so the file in this repo is a *copy* of the live
listing and nothing in the pipeline publishes it. Fixing the copy therefore
fixes nothing a user or a reviewer sees, and CI cannot fail on the mismatch:
the live text has to be edited by hand in the console, in the same sitting as
the declaration form, and the repo copy updated to match. Note this sits on top
of §1.2, which wants the same file rewritten for a different reason, and in the
same console.

### 7.9 Firefox: the `about:addons` interposition has never been run either

§7.6 covers what Firefox does to a page-scoped pass. This is the other half of
the same problem — the leaving feature — and it fails in the opposite,
quieter direction.

`about:addons` is in `REMOVAL_SURFACES` (`shared/background.js`) and the
listener is the same `chrome.tabs.onUpdated` one Chromium uses. Whether Firefox
populates `tab.url`/`changeInfo.url` for an `about:` page under the `tabs`
permission is **not verified**, and cannot be from here: `tests/smoke/*.mjs`
drives Playwright's Chromium, and that is the only browser any test in this
repo starts. `tests/smoke/leaving.smoke.mjs` opens with a deliberate GATE
probe for exactly this question on Chromium — its own header says that if the
probe comes back empty the honest response is to drop the interposition and
ship `setUninstallURL` plus the settings card alone — and there is no Firefox
equivalent of that probe anywhere.

If Firefox does not populate it, the Firefox build silently has no leaving
interposition: `isRemovalSurfaceUrl('')` is false, nothing opens, and every
other promise the feature makes still holds (the settings card, the cool-off,
the export, the uninstall URL). That is why it shipped registered and guarded
rather than held back. But *silently* is the problem — nothing in the product,
in CI, or in this file would report it, so it is written down here instead.

To close it: load `Intention Firefox` as a temporary add-on
(`npm run dev:firefox`), finish setup so `leaveInterposeAllowed` can return
true at all, open `about:addons`, and see whether one Intention tab appears
beside it. Ten minutes. While there, the two DNR questions in §7.6 are
answerable in the same session, and the capability check they gate —
`allowOutranksRedirect()` in `shared/background.js`, which detects Firefox by
`browser.runtime.getBrowserInfo` and returns `false` for it — is the single
function that would change if the answers are yes.

### 7.10 Safari: nobody knows whether `onHistoryStateUpdated` fires there

A page-scoped pass ends when `location.href` stops matching the key it was
granted for, and on the sites this matters most for that change happens with no
network request at all — YouTube autoplays into the next video through
`history.pushState`, which commits nothing and re-runs no content script.

There are two ways to notice it, and Safari is the reason there are two.
`chrome.webNavigation.onHistoryStateUpdated` (`shared/background.js`) is the
fast one: a message in a few milliseconds. Whether WebKit implements it at all
is unknown here — nothing in this repo runs against Safari, and the listener is
registered behind a `chrome.webNavigation?.onHistoryStateUpdated` guard
precisely so that its absence is silence rather than a thrown background
script. The slow one is a poll in the content script: `URL_WATCH_MS` (600ms
foreground) and `URL_WATCH_HIDDEN_MS` (3s hidden) in `shared/content.js`.

So the poll is not belt-and-braces on Safari, it is the whole mechanism, and
two of its properties follow from that rather than from tuning. It runs while
the tab is *hidden*, because the failure it prevents there is audible rather
than visible — a scoped pass on one video, tab switched away, and YouTube plays
the chain with sound while the badge still says THIS PAGE ONLY. And it asks
whether the pass has expired *before* it compares the address, because Safari
suspends the background page and no check-in alarm arrives to do it.

Verifying it needs a Mac, ten minutes and one YouTube video: take a page-scoped
pass, let it autoplay, and watch whether the gate comes back within a second or
so. If it does, this is fine as it stands. What must not happen is somebody
reading the poll as redundant with the listener and removing it — on Safari
that is the enforcement.

### 7.11 The list export has no importer — the copy no longer says it does

"Save a copy of your list" (`exportBlocklistFile`, `shared/options.js`) writes
`intention-list-YYYY-MM-DD.json` through an explicit allowlist
(`buildExportPayload`). Nothing reads it back. There is no file input anywhere
in `shared/`, and the wizard has no import step.

Two pieces of copy used to promise otherwise, and both have been corrected on
this branch. `docs/LEAVING.md` said the file "is how you pick up where you left
off"; it now says plainly that there is no "load this file" button and the file
is a record to work from. The settings card said "you can load it into setup and
carry on where you left off"; `shared/options.html` now reads "There is no
import button yet — you would re-enter it by hand", alongside the list of what
the file does and does not contain.

So what is left here is the importer itself, not a lie about it. That was "we
missed it" rather than "we knew and chose not to" — the export shipped as the
answer to "leaving should not be punitive", and shipping only its outbound half
is defensible, but describing the outbound half as a round trip was not. Writing
it is a file input, `buildExportPayload` read backwards, and the same
`sanitizePartRule`/`normalizeLeaveDelay` validation every other write already
goes through — note `v: 1` is in the payload for exactly this. Until someone
does, the honest sentence is already on screen.

### The sweep for things this branch closed

Recorded because "nobody checked" and "somebody checked and the answer was no"
look identical in a file like this one a year later. Every open item above was
re-read against the shipped code at the end of the branch. **Nothing was closed
outright**, so nothing carries a new — RESOLVED or — DELETED. What did move:

- **§3.6 / §7.5** — re-measured (`0 errors, 0 notices, 2 warnings`, unchanged),
  and the second warning's line number corrected from `options.js:974` to
  `options.js:1322`, where `renderStats` now lives.
- **§3.4** — recounted: fifteen tokens in `options.html`, not thirteen. The
  item said 13 and nobody had counted since.
- **§6.3** — half-decided rather than fixed; the new state is written into the
  item, because the decision reads like a closure and is not one.
- **§7.3** — rewritten. The behaviour it described (an `only` rule failing open
  inside an app) is not the behaviour that shipped.

Re-checked and still true exactly as written: §1.2 (both store descriptions
still lead with BYOK — `shared/manifest.base.json` still says "Bring your own
LLM"), §2.1 (the iOS shield copy is still committed and still unrendered;
`ShieldConfigurationExtension.swift` was not touched by any of the five
features, so it is not restated here — and it shares a device with §7.3 and
§7.7, so whoever picks up a handset for those can settle it in the same
sitting), §2.2, §2.3, §3.2 (`save-blocking-mode-btn`, `save-context-btn` and
`save-provider-btn` all still there), §3.3 (`maxGrants: 3` is still in every
limits entry and still on no screen), §3.4 (still undocumented, count
corrected above), §3.5 (`coaching.html` still carries its own inline `<style>`
copy of the message and stats styles; the `content.css`/`OVERLAY_CSS` pair is
the half §5 closed), §4.1, §4.2, §6.1, §6.2, §6.4.
