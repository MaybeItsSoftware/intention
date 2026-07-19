# Deployment Guide

How to ship Intention to the Chrome Web Store, Firefox Add-ons (AMO), the Apple App Store (Safari, macOS + iOS), and Google Play (Android). For local unpacked/temporary installs, see the [README](README.md#installation) instead — this doc is about store submission.

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
   - **`publish-chrome.yml`** — uploads to the Chrome Web Store, *if* the secrets below are configured.
   - **`publish-firefox.yml`** — submits to AMO, *if* configured.
   - **`publish-android.yml`** — publishes a Google Play internal release, *if* configured.
   
   If secrets are missing, these workflows log warnings and skip gracefully. You can run any store workflow by hand via the Actions tab.

   > [!NOTE]
   > **Downstream Workflow Triggers in CI:**
   > When the automated release workflow runs on GitHub and pushes a tag using the default `GITHUB_TOKEN`, GitHub's built-in security policies prevent it from triggering subsequent workflows (such as the store publishing workflows).
   > To enable automatic publishing to the stores on every automated tag push, create a **Personal Access Token (PAT)** or GitHub App token with `repo` and `workflow` permissions, and save it in your repository secrets as **`RELEASE_TOKEN`**. The release workflow will use this token to push tags, which successfully triggers downstream workflows.
5. Safari/App Store has no CLI-only path (Apple requires Xcode/Transporter for the first submission of a build). See [Safari / App Store](#safari--app-store-macos--ios) below.

## Chrome Web Store: automated publishing

`publish-chrome.yml` needs these repo secrets (**Settings → Secrets and variables → Actions**):

| Secret | How to get it |
|---|---|
| `CHROME_EXTENSION_ID` | Create/upload the extension once by hand in the [Developer Dashboard](https://chrome.google.com/webstore/devconsole) to get an ID, or read it from the dashboard URL after first manual upload. |
| `CHROME_CLIENT_ID` / `CHROME_CLIENT_SECRET` | Create an OAuth 2.0 Client ID (type "Desktop app") in [Google Cloud Console](https://console.cloud.google.com/apis/credentials), with the Chrome Web Store API enabled on that project. |
| `CHROME_REFRESH_TOKEN` | Generate once via the OAuth consent flow using the client ID/secret above and scope `https://www.googleapis.com/auth/chromewebstore` (see the [chrome-extension-upload README](https://github.com/mnao305/chrome-extension-upload) for the exact `curl`/browser flow). |

The very first submission must be done manually (upload a zip from `./build.sh`'s `build/` output, fill in the store listing, submit for review) — Google requires the extension to exist before the API can update it. After that, `publish-chrome.yml` handles every subsequent version.

## Firefox Add-ons (AMO): automated publishing

`publish-firefox.yml` needs:

| Secret | How to get it |
|---|---|
| `AMO_JWT_ISSUER` | From [addons.mozilla.org/developers/addon/api/key](https://addons.mozilla.org/developers/addon/api/key/) — "JWT issuer". |
| `AMO_JWT_SECRET` | Same page — "JWT secret". |

Unlike Chrome, `web-ext sign --channel=listed` can handle the *first* submission too — no manual upload needed first. Run `npm run lint:firefox` locally before tagging to catch AMO validation issues early (CI runs this on every push as well).

## Safari / App Store (macOS + iOS)

No public API for first-time app submission — this stays manual, on a Mac with Xcode:

1. Open `Intention Apple/Intention Safari.xcodeproj` in Xcode.
2. Set your own Team under **Signing & Capabilities** for all four targets (App + Extension, macOS + iOS). The bundle identifiers are already set to `uk.co.maybeitssoftware.intention...` (Xcode → target → General → Bundle Identifier) — change them if you're forking under a different identifier. `scripts/bump-version.sh` keeps `MARKETING_VERSION`/`CURRENT_PROJECT_VERSION` in sync for you on every release; it does not touch bundle identifiers or signing.
3. `Product → Archive` for the macOS scheme and the iOS scheme (or `./build.sh --safari` for the macOS build only — Xcode CLI tools required, macOS only).
4. Use the Xcode Organizer (or Transporter) to upload each archive to App Store Connect.
5. In [App Store Connect](https://appstoreconnect.apple.com), fill in the listing (see below) and submit for review.
6. To regenerate the wrapper from the latest Chrome sources after a big change: `xcrun safari-web-extension-converter "./Intention Chrome" --project-location . --app-name "Intention Safari"`, then re-apply your Team/bundle ID settings.

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

## Store listing checklist (first submission, all stores)

- **Privacy policy URL** — link to [`PRIVACY.md`](PRIVACY.md) (raw GitHub URL or hosted via GitHub Pages). Required by Chrome Web Store and AMO because of the `<all_urls>` host permission and third-party LLM calls.
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
| `publish-chrome.yml` | `v*` tag push (or manual) | Publishes to Chrome Web Store, if secrets are configured; skips gracefully otherwise |
| `publish-firefox.yml` | `v*` tag push (or manual) | Submits to AMO, if secrets are configured; skips gracefully otherwise |
| `publish-android.yml` | `v*` tag push (or manual) | Publishes a Google Play internal release, if secrets are configured; skips gracefully otherwise |
