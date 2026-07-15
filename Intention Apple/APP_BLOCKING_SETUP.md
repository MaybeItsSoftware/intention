# iOS app blocking (Screen Time) — one-time Xcode setup

The Swift sources, Info.plists, and entitlements for native app blocking are
in the repo, but Xcode targets cannot be created from the command line, so
three extension targets need to be added once in Xcode. Until then the app
still builds and runs; the options page simply drives the picker and shields
from the main app, and only re-shielding-on-schedule and custom shield copy
are missing.

## What already works without this setup

- `Shared (iOS)/AppBlockingManager.swift` is compiled into the iOS App target.
- The options page (Blocked apps card) can authorize Screen Time, present the
  FamilyActivityPicker, apply shields, and grant a coach-approved pass.
- Passes are re-shielded when the app is next foregrounded
  (`reapplyIfPassExpired()`); without the monitor extension there is no
  guaranteed background re-shield.

## 1. Family Controls capability

- Targets: **iOS (App)** → Signing & Capabilities → add **Family Controls**.
  The entitlement is already in `iOS (App)/iOS (App).entitlements`.
- Distribution outside development requires requesting the Family Controls
  entitlement from Apple: https://developer.apple.com/contact/request/family-controls-distribution
  (development builds on a physical device work without approval).
- Screen Time APIs do not work in the Simulator — test on a device.

## 2. Create the three extension targets

For each one: File → New → Target → iOS, pick the template, then delete the
template's generated source file and add the existing one from the repo
(File → Add Files, uncheck "Copy items"). Set the App Group + Family Controls
capabilities on every target (entitlements files are already in each folder).

| Template | Target name | Existing sources |
| --- | --- | --- |
| Device Activity Monitor Extension | IntentionMonitor | `iOS (Monitor Extension)/DeviceActivityMonitorExtension.swift` + also add `Shared (iOS)/AppGroupConfig.swift` to this target |
| Shield Configuration Extension | IntentionShield | `iOS (Shield Extension)/ShieldConfigurationExtension.swift` |
| Shield Action Extension | IntentionShieldAction | `iOS (Shield Action Extension)/ShieldActionExtension.swift` |

Point each target's Info.plist / entitlements build settings at the files in
the matching folder (or let Xcode's generated ones match the values there —
the `NSExtensionPointIdentifier` and `NSExtensionPrincipalClass` values are
what matter).

## 3. How the pieces fit

- Options page → `ios-bridge.js` (`window.intentionScreenTime`) →
  `ViewController.handleScreenTimeMessage` → `AppBlockingManager`.
- Selection is a `FamilyActivitySelection` stored as JSON in the App Group
  under `screenTimeSelection` — it is opaque (no bundle ids) and never enters
  the web config.
- Coach grant: coaching page (`coaching.html?domain=apps&app=1`) → grant_access
  tool → `intentionScreenTime.grantPass(minutes)` → shields lifted, pass end
  stored under `screenTimePassEndsAt`, DeviceActivity schedule started.
- Re-shield: `DeviceActivityMonitorExtension.intervalDidEnd` (background) and
  `AppBlockingManager.reapplyIfPassExpired()` on app foreground (backup —
  DeviceActivity schedules have a ~15 minute floor, shorter passes rely on
  the foreground check).
- Shield UI: `ShieldConfigurationExtension` renders the "blocked by
  Intention" copy; `ShieldActionExtension` closes the app (iOS offers no way
  to open Intention from a shield).
