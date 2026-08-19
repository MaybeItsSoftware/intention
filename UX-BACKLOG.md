# UX backlog

Follow-up work from the onboarding + settings audit (August 2026). Everything
here was found during that audit and deliberately *not* done at the time — the
reason is recorded per item, because "we knew and chose not to" and "we missed
it" need different responses later.

Ordered roughly by what unblocks the most.

---

## 1. Decisions needed before anyone writes code

### 1.1 The second onboarding path is fully built and unreachable

`buildSetupSystemPrompt()` (`shared/prompts.js`), `SAVE_ONBOARDING_TOOL`
(`shared/prompts.js`) and the `mode: 'setup'` handler (`shared/background.js`)
implement a *conversational* onboarding — the coach interviewing you about your
goals, triggers, sites and limits — and persist the result via `save_onboarding`.

It has **no UI caller**. `grep` for `'setup'` across non-generated source finds
only `background.js` itself and two test files. `coaching.js` only knows `gate`
and `checkin`; `options.js` never sends it.

It also asks something the shipped wizard never does: *"the legitimate, brief
reasons they might still need their blocked sites."* That is arguably the single
most useful thing to know about a user before you start gating them.

Two honest options, and they point in opposite directions:

- **Delete it.** ~100 lines plus its tests. Removes a whole phantom subsystem
  that reads as live code to anyone new.
- **Wire it up** as an optional "set this up by talking instead" path from the
  welcome step. Needs a decision about who gets offered it (it costs an LLM call
  before the user has any access set up, which is a chicken-and-egg problem on
  every build).

Deferred because this is a product call, not a cleanup.

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

### 2.3 The macOS host app has no onboarding at all

`Intention Apple/Shared (App)/Resources/Base.lproj/Main.html` is a separate,
minimal page untouched by the design system. It:

- calls the product **"Intention Safari"** (the Xcode target name leaking; the
  name appears nowhere else in the product)
- offers one button reading **"Quit and Open Safari Extensions Preferences…"**,
  which threatens to quit the app the user just opened
- carries its own bare "Coaching Credit" / "Recover an interrupted purchase"
  block with none of the shared paywall's copy

A macOS user reaches the real wizard only by opening the *extension's* options
page, which nothing tells them to do.

Deferred for the same reason as 2.2, plus the name leak may need an Xcode
project change rather than a copy change.

---

## 3. Follow-ups created or left by the audit work

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

### 3.4 The coach-instructions help text dumps 13 raw template tokens

`shared/options.html` lists `{{questions}} {{usage}} {{domain}} {{grants_today}}
…` with no explanation of what any of them expand to. It is inside an
`(advanced)` disclosure, so the audience is self-selecting — but an example of
one rendered prompt would be worth more than the list.

### 3.5 Overlay CSS is duplicated in three places

`shared/content.css`, the `OVERLAY_CSS` string constant at the top of
`shared/content.js`, and an inline `<style>` in `shared/coaching.html`. Any
overlay style change must land in all three or the gate looks different
depending on how it was reached. Worth collapsing.

### 3.6 Pre-existing `innerHTML` lint warnings

`npm run lint:firefox` reports 0 errors and 4 `UNSAFE_VAR_ASSIGNMENT` warnings,
all pre-existing. `renderStats` interpolates numbers into `innerHTML`; the
per-row behaviour select builds its `<option>` list the same way. The
values are all internal, so this is hygiene rather than a live hole — but it
sits awkwardly next to the file's own stated "model-authored text: `textContent`
only" discipline.

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

### 6.2 The macOS host shell is untouched

`Intention Apple/Shared (App)/Resources/Main.html` and `Style.css` are outside
`shared/`, have no tokens, and now differ from everything else. Same reason as
§2.3 — it needs Xcode to look at.

### 6.3 The browser build's "use your own API key" route has no form on the
coaching page

Visible now that the route cards render at all: on `coaching.html` the key
route shows its description and nothing to type into, because `coaching.js`
does not pass `onSaveKey` to `renderPaywall()`. `options.html` passes it and
shows the provider select and key field. Either wire it up or say plainly that
the key is entered in settings.

### 6.4 Contrast is now measured, not eyeballed

`npm run test:smoke:contrast` walks every visible text node in the wizard, all
four settings tabs and the coaching page, in both themes, and fails on
anything under WCAG AA. It caught white-on-azure at 3.8:1 across every primary
button — which is why `--primary-solid` exists as a separate token from
`--primary`. Run it after any colour change; it is much faster than looking.
