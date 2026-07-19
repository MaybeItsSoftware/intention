# iOS app blocking (Screen Time)

The four Screen Time extension targets are wired into
`Intention Safari.xcodeproj` (added directly in project.pbxproj):

| Target | Extension point | Sources |
| --- | --- | --- |
| Intention Monitor Extension | Device Activity Monitor (NSExtension) | `iOS (Monitor Extension)/DeviceActivityMonitorExtension.swift` + `Shared (iOS)/AppGroupConfig.swift` |
| Intention Shield Extension | Shield Configuration (NSExtension) | `iOS (Shield Extension)/ShieldConfigurationExtension.swift` |
| Intention Shield Action Extension | Shield Action (NSExtension) | `iOS (Shield Action Extension)/ShieldActionExtension.swift` |
| Intention Report Extension | Device Activity Report (ExtensionKit) | `iOS (Report Extension)/ReportExtension.swift` + `Shared (iOS)/AppGroupConfig.swift` |

All four have App Groups + Family Controls entitlements (files live in each
target folder) and a 16.0 deployment target. The Report Extension is an
ExtensionKit extension (embedded in `Intention.app/Extensions`, declared via
`EXAppExtensionAttributes`), unlike the other three NSExtension appexes in
`PlugIns`; it also needs a direct `import ExtensionKit` because the project
enables `MemberImportVisibility`.

## Remaining manual steps

- Distribution outside development requires requesting the Family Controls
  entitlement from Apple: https://developer.apple.com/contact/request/family-controls-distribution
  (development builds on a physical device work without approval; automatic
  signing registers the capability on the App IDs the first time you build
  to a device).
- Screen Time APIs do not work in the Simulator — everything below has to be
  verified on a physical device.

## On-device verification checklist

- Authorize + pick apps from the options page (the picker now auto-requests
  authorization on first use), confirm the shield shows the Intention copy
  (Shield Extension) and its button closes the app (Shield Action Extension).
- Grant a pass via the coach, background Intention, and confirm the apps
  re-shield after the pass ends without reopening Intention (Monitor
  Extension; passes under 15 minutes still rely on the next foreground).
- The Report Extension only computes an **aggregate** total-minutes-used
  number for the blocked selection, not a per-app breakdown — Family Controls
  doesn't expose app identity (bundle IDs/names) to third-party code outside
  Apple's own report-rendering UI, by design. Block an app, use it briefly,
  then check that "Blocked apps (this device)" appears in the options page's
  usage log after a few minutes.

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
- Usage log: options page → `intentionScreenTime.getAppUsageReport` →
  `handleScreenTimeMessage` → `AppBlockingManager.requestUsageReport`, which
  briefly presents an invisible `DeviceActivityReport` view (that's what
  triggers `ReportExtension` to run), then polls the App Group for the
  aggregate `{date: minutes}` map the extension wrote under
  `iosAppUsageByDate`.
