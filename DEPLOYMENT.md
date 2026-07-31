# Deployment Guide

How to ship Intention to the Chrome Web Store, Firefox Add-ons (AMO), the Apple App Store (Safari, macOS + iOS), and Google Play (Android). For local unpacked/temporary installs, see the [README](README.md#installation) instead — this doc is about store submission.

Intention Pro is sold through In-App Purchase, so two things now have to be live before the mobile builds are submitted: the store products (below) and the [backend](server/README.md) that verifies them. See [In-App Purchase setup](#in-app-purchase-setup) for both.

## One-time setup per store

| Store | Account | Cost | Where |
|---|---|---|---|
| Chrome Web Store | Google account | $5 one-time | [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole) |
| Firefox Add-ons (AMO) | Firefox account | Free | [addons.mozilla.org/developers](https://addons.mozilla.org/developers/) |
| Apple App Store | Apple Developer Program | $99/year | [developer.apple.com](https://developer.apple.com/programs/) |
| Google Play | Google Play Console account | $25 one-time | [play.google.com/console](https://play.google.com/console) |

Do these once, before the first submission of each platform.

## Release flow

1. **Commit changes using Conventional Commits**: To enable auto-versioning, commit messages must follow the Conventional Commits syntax (e.g., `feat: login screen`, `fix: cookie parser`, or `feat!: remove legacy API` for breaking changes).
2. **Merge/Push to `main`**: Pushing or merging code into the `main` branch automatically triggers the [auto-release.yml](file:///.github/workflows/auto-release.yml) workflow.
3. **Automated Release**: The CI runner:
   - Evaluates Conventional Commits since the last release tag.
   - Bumps the version using SemVer rules.
   - Updates files using `scripts/bump-version.sh`.
   - Compiles and packages Chrome/Firefox extensions.
   - Tags the commit and creates a GitHub Release with build zips and `CHANGELOG.md`.
4. **Publishing to Stores**: The tag push triggers the store publishing workflows:
   - **`publish-chrome.yml`** — uploads a draft build to the Chrome Web Store, *if* the secrets below are configured. This only primes the new version in the dashboard; it does **not** submit it for review — do that manually in the Developer Dashboard when ready.
   - **`publish-firefox.yml`** — submits to AMO, *if* configured.
   - **`publish-android.yml`** — publishes a Google Play internal release, *if* configured.
   - **`publish-apple.yml`** — uploads signed iOS + macOS builds to App Store Connect, *if* configured. Like Chrome, this only primes the build — it does not attach it to a version or submit for review; do that manually when ready.
   
   If secrets are missing, these workflows log warnings and skip gracefully. You can run any store workflow by hand via the Actions tab.

   > [!NOTE]
   > **Automated Store Publishing:**
   > The storefront publishing workflows (`publish-chrome.yml`, `publish-firefox.yml`, `publish-android.yml`, `publish-apple.yml`) are configured to trigger automatically on the successful completion of the `Automated Release` workflow (`workflow_run`).
   > Because of this, they execute fully automatically on every new version release without requiring you to configure any Personal Access Tokens (PATs) or repository release secrets.
5. Safari/App Store publishes the same way, via `publish-apple.yml` — uploads only, never submits for review. See [Safari / App Store](#safari--app-store-macos--ios) below.

## Chrome Web Store: automated publishing

`publish-chrome.yml` needs these repo secrets (**Settings → Secrets and variables → Actions**):

| Secret | How to get it |
|---|---|
| `CHROME_EXTENSION_ID` | Create/upload the extension once by hand in the [Developer Dashboard](https://chrome.google.com/webstore/devconsole) to get an ID, or read it from the dashboard URL after first manual upload. |
| `CHROME_CLIENT_ID` / `CHROME_CLIENT_SECRET` | Create an OAuth 2.0 Client ID (type "Desktop app") in [Google Cloud Console](https://console.cloud.google.com/apis/credentials), with the Chrome Web Store API enabled on that project. |
| `CHROME_REFRESH_TOKEN` | Generate once via the OAuth consent flow using the client ID/secret above and scope `https://www.googleapis.com/auth/chromewebstore` (see the [chrome-extension-upload README](https://github.com/mnao305/chrome-extension-upload) for the exact `curl`/browser flow). |

The very first submission must be done manually (upload a zip from `./build.sh`'s `build/` output, fill in the store listing, submit for review) — Google requires the extension to exist before the API can update it. After that, `publish-chrome.yml` uploads every subsequent version as a draft automatically, but you still need to go to the [Developer Dashboard](https://chrome.google.com/webstore/devconsole) and click **Submit for review** yourself — the workflow never does that step.

## Firefox Add-ons (AMO): automated publishing

`publish-firefox.yml` needs:

| Secret | How to get it |
|---|---|
| `AMO_JWT_ISSUER` | From [addons.mozilla.org/developers/addon/api/key](https://addons.mozilla.org/developers/addon/api/key/) — "JWT issuer". |
| `AMO_JWT_SECRET` | Same page — "JWT secret". |

Unlike Chrome, `web-ext sign --channel=listed` can handle the *first* submission too — no manual upload needed first. Run `npm run lint:firefox` locally before tagging to catch AMO validation issues early (CI runs this on every push as well).

## Safari / App Store (macOS + iOS)

**One-time setup:** create the app record manually in [App Store Connect](https://appstoreconnect.apple.com) (My Apps → +) — Apple requires this before any API/CLI upload can target it, same as Chrome/Play. Already done for Intention (app ID `6791299221`, team `6NQNU5YSC2`). If forking under a different bundle identifier, also set your own Team under **Signing & Capabilities** for all targets in `Intention Apple/Intention Safari.xcodeproj` — the bundle identifiers are set to `uk.co.maybeitssoftware.intention...` (Xcode → target → General → Bundle Identifier). `scripts/bump-version.sh` keeps `MARKETING_VERSION`/`CURRENT_PROJECT_VERSION` in sync on every release; it doesn't touch bundle identifiers or signing.

**Every release after that** is CLI-automated via Fastlane + [match](https://docs.fastlane.tools/actions/match/) — no Xcode GUI needed for signing or upload — and runs automatically via `publish-apple.yml` on every `v*` tag push, same as Chrome/Firefox/Android. To run it locally instead:

```bash
cd "Intention Apple"
bundle exec fastlane ios beta   # archive -> build/ios/Intention.ipa   -> upload to App Store Connect
bundle exec fastlane mac beta   # archive -> build/macos/Intention.pkg -> upload to App Store Connect
```

`publish-apple.yml` needs these repo secrets (**Settings → Secrets and variables → Actions**); local runs read the same variable names from the repo root `.env` instead. See [DEVOPS.md](DEVOPS.md#3-apple-app-store-macos--ios-safari-wrapper) for exactly how to get them and what each lane does under the hood:

| Secret | Purpose |
|---|---|
| `ASC_KEY_ID` / `ASC_ISSUER_ID` / `ASC_KEY_CONTENT` | App Store Connect API key — auth for both provisioning (`match`) and the upload |
| `MATCH_PASSWORD` | Decrypts the shared `MaybeItsSoftware/match-certs` cert/profile repo (same repo other maybeitssoftware apps use) |
| `MATCH_GIT_SSH_KEY` | SSH deploy key with access to `match-certs` — CI-only; a local run uses your own SSH identity instead |

If secrets are missing, `publish-apple.yml` logs a warning and skips gracefully, like the other store workflows. On CI, `match` runs in `readonly` mode automatically (via `setup_ci`) so a workflow run can never create or revoke certs/profiles — only a local run can do that, the first time a new bundle ID needs a profile.

After a successful upload, the build takes a few minutes to finish processing in App Store Connect before you can attach it to a version and submit for review — that part stays manual at [App Store Connect](https://appstoreconnect.apple.com).

To regenerate the Xcode wrapper from the latest Chrome sources after a big change: `xcrun safari-web-extension-converter "./Intention Chrome" --project-location . --app-name "Intention Safari"`, then re-apply Team/bundle ID settings and re-share (**Product → Scheme → Manage Schemes → Shared**) any schemes Fastlane needs to see.

## Google Play: automated publishing

`publish-android.yml` builds a signed `.aab` in CI and pushes it to the **internal** track (change the `track:` input in the workflow to `alpha`, `beta`, or `production` once you're past internal testing). It needs these repo secrets:

| Secret | How to get it |
|---|---|
| `ANDROID_KEYSTORE_BASE64` | `base64 -i "Intention Android/keystore/upload-keystore.jks" \| pbcopy` — base64-encode your upload keystore. Never commit the raw `.jks` (already gitignored). |
| `ANDROID_KEYSTORE_PASSWORD` | The store password from your local `keystore.properties`. |
| `ANDROID_KEY_ALIAS` | The key alias from `keystore.properties` (`intention-upload`). |
| `ANDROID_KEY_PASSWORD` | The key password from `keystore.properties`. |
| `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON` | Create a service account in [Google Cloud Console](https://console.cloud.google.com/iam-admin/serviceaccounts) for the same project linked to your Play Console, grant it access under **Play Console → Users and permissions** with "Release to production, exclude devices, and use Play App Signing" permission, then paste the full JSON key as the secret value. |

The very first release to Google Play must be created manually (upload the `.aab` from `./gradlew bundleRelease`'s output, fill in the store listing, complete the content rating and data safety forms, submit for review) — Play Console requires the app to exist and pass initial review before the API can push subsequent builds. After that, `publish-android.yml` handles every later version.

To build the signed bundle locally without CI: `cd "Intention Android" && ./gradlew bundleRelease` — output lands at `app/build/outputs/bundle/release/app-release.aab`, signed via the local `keystore.properties`.

## In-App Purchase setup

Intention was rejected under **Guideline 3.1.1** for unlocking its core feature with a user-supplied API key. The fix is structural: access to the coach is sold through Apple/Google, the provider key lives on Intention's backend, and the custom-key field is an unadvertised developer override in Settings → Advanced. All three parts have to be in place at submission.

### 1. Deploy the backend

`server/` verifies receipts and proxies coaching calls. Deploy it anywhere that runs Node 20+, behind TLS, then set:

- `INTENTION_TOKEN_SECRET` — `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`
- `INTENTION_LLM_API_KEY` — Intention's own provider key
- the Apple and Google credentials in the tables below

Point the clients at it by editing `DEFAULT_INTENTION_BACKEND_URL` in `shared/providers.js` and running `scripts/sync.sh`. Full reference: [`server/README.md`](server/README.md).

### 2. App Store Connect (iOS + macOS)

1. **My Apps → Intention → Monetization → Subscriptions.** Create a subscription group named `Intention Pro` with two auto-renewable subscriptions:
   - `uk.co.maybeitssoftware.intention.pro.monthly` (1 month)
   - `uk.co.maybeitssoftware.intention.pro.yearly` (1 year)

   The IDs must match `IntentionProduct` in `Intention Apple/Shared (App)/IntentionStore.swift` and `APPLE_PRODUCT_IDS` on the backend. Each needs a localized display name, description, price, and a review screenshot, and must reach **Ready to Submit** — a subscription still in "Missing Metadata" won't load in the app, and review will see an empty paywall.
2. **Users and Access → Integrations → In-App Purchase → generate a key.** Its Issuer ID, Key ID, and `.p8` become `APPLE_ISSUER_ID`, `APPLE_KEY_ID`, `APPLE_PRIVATE_KEY`. Set `APPLE_ENVIRONMENT=sandbox` while testing with a sandbox Apple Account.
3. **Attach the subscriptions to the version** being submitted (App Store Connect asks for this on the version page — first submissions review the app and its IAPs together).
4. **App Groups.** The subscription is bought in the app but the coach also runs inside the Safari extension, so the entitlement crosses via the App Group. Enable **App Groups** under Signing & Capabilities on all four targets (iOS App, iOS Extension, macOS App, macOS Extension) with the same group as `AppGroupConfig.identifier`. macOS groups need the Team ID prefix (`6NQNU5YSC2.group.uk.co.maybeitssoftware.intention`); without it the Mac extension will never see the subscription.

Local testing needs no App Store Connect round-trip: `Intention Apple/Shared (App)/Intention.storekit` is wired into both shared schemes, so Debug runs against local StoreKit products.

### 3. Google Play

1. **Monetize → Products → Subscriptions**: create `intention_pro_monthly` and `intention_pro_yearly`, each with a base plan and an active price. These must match `BillingManager.PRODUCT_MONTHLY`/`PRODUCT_YEARLY` and `GOOGLE_PRODUCT_IDS`.
2. Reuse the `GOOGLE_PLAY_SERVICE_ACCOUNT_JSON` service account (see the Play section above) for the backend's `GOOGLE_CLIENT_EMAIL` / `GOOGLE_PRIVATE_KEY`; it needs "View financial data" in Play Console to read subscription state.
3. Subscriptions only become purchasable once a build containing the Billing library has been through a release track, so push an internal-track build before testing the paywall.

### 4. What review sees

- A fresh install can subscribe and use the coach without ever meeting an API key field: onboarding's last step is the purchase, and it lists Apple's own products.
- **Restore purchases** is on the paywall, and **Manage subscription** appears once active — both required.
- No link out of the app to a website, and no mention of any external LLM provider, appears anywhere in onboarding, the paywall, or marketing copy.
- The custom-key field lives at Settings → Advanced → Custom API key, is not referenced anywhere else, and is labelled as a developer option. If review asks about it: it points the app at the reviewer's own LLM account and sells nothing.

## Store listing checklist (first submission, all stores)

- **Privacy policy URL** — link to [`PRIVACY.md`](PRIVACY.md) (raw GitHub URL or hosted via GitHub Pages). Required by Chrome Web Store and AMO because of the `<all_urls>` host permission and third-party LLM calls, and by Apple/Google because subscriptions send conversations to Intention's backend.
- **Subscription disclosures** (Apple and Google both require these in the listing, and Apple also wants them reachable from the paywall): title, length, and price of each subscription, plus links to the Terms of Use (Apple accepts the standard EULA) and the privacy policy.
- **Permission justification** (Chrome Web Store asks for this explicitly in the listing form):
  - `<all_urls>` / host permissions — needed to detect and overlay any domain the user adds to their own blocklist; the extension has no fixed list of sites.
  - `tabs` — needed to detect which tab/URL is active and pause it.
  - `scripting` — needed to inject the coaching overlay.
  - `declarativeNetRequest` — redirects the top-level navigation to `coaching.html` when a blocked domain loads, and grants a temporary per-tab allow rule while a coaching session is active.
  - `storage`, `alarms` — local persistence and the grant-countdown timer.
- **Icons** — already present (`icon16/32/48/128.png` per platform). Chrome Web Store also wants a 128×128 store icon (use `icon128.png`).
- **Screenshots** — not included in this repo (design assets, not code). Chrome: 1280×800 or 640×400, at least one. Firefox: recommended, no hard size requirement. Apple: per-device-size screenshots via Xcode Organizer/App Store Connect.
- **Listing copy** — short description, long description, category ("Productivity"). Draft from the [README](README.md) features/how-it-works sections.

## Known lint warnings

`web-ext lint` currently reports `UNSAFE_VAR_ASSIGNMENT` warnings (innerHTML usage in `content.js`, `coaching.js`, `options.js`). These are warnings, not errors — they don't block AMO submission — but are worth revisiting separately if you want a cleaner lint pass.

## CI/CD summary

| Workflow | Trigger | What it does |
|---|---|---|
| `ci.yml` | push/PR to `main` | Manifest/version validation, JS syntax, cross-platform file sync, `web-ext lint` |
| `auto-release.yml` | push to `main` | Calculates next version, runs tests, bumps versions, zips Chrome + Firefox, tags the commit, and creates a GitHub Release |
| `publish-chrome.yml` | `v*` tag push (or manual) | Uploads a draft to the Chrome Web Store (not submitted for review), if secrets are configured; skips gracefully otherwise |
| `publish-firefox.yml` | `v*` tag push (or manual) | Submits to AMO, if secrets are configured; skips gracefully otherwise |
| `publish-android.yml` | `v*` tag push (or manual) | Publishes a Google Play internal release, if secrets are configured; skips gracefully otherwise |
| `publish-apple.yml` | `v*` tag push (or manual) | Builds + uploads signed iOS/macOS binaries to App Store Connect via Fastlane + match (not submitted for review), if secrets are configured; skips gracefully otherwise |
