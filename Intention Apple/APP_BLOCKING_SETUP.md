# iOS app blocking (Screen Time)

The five iOS extension targets are wired into `Intention Safari.xcodeproj`
(added directly in project.pbxproj):

| Target | Extension point | Sources |
| --- | --- | --- |
| Intention Monitor Extension | Device Activity Monitor (NSExtension) | `iOS (Monitor Extension)/DeviceActivityMonitorExtension.swift` + `Shared (iOS)/AppGroupConfig.swift` |
| Intention Shield Extension | Shield Configuration (NSExtension) | `iOS (Shield Extension)/ShieldConfigurationExtension.swift` |
| Intention Shield Action Extension | Shield Action (NSExtension) | `iOS (Shield Action Extension)/ShieldActionExtension.swift` |
| Intention Report Extension | Device Activity Report (ExtensionKit) | `iOS (Report Extension)/ReportExtension.swift` + `Shared (iOS)/AppGroupConfig.swift` |

The four Screen Time ones have App Groups + Family Controls entitlements (files
live in each target folder) and a 16.0 deployment target. The Report Extension
is an ExtensionKit extension (embedded in `Intention.app/Extensions`, declared
via `EXAppExtensionAttributes`), unlike the other NSExtension appexes in
`PlugIns`; it also needs a direct `import ExtensionKit` because the project
enables `MemberImportVisibility`.

The Widget Extension is the odd one out: it touches no Screen Time API at all,
so it has no entitlements file and no App Group — everything it draws arrives
through the Live Activity's own attributes. It needs a 16.2 deployment target
(the app itself is still 15.0) because that is where ActivityKit's
`Activity.request` lives, and the app's `Info.plist` must carry
`NSSupportsLiveActivities` or activities are reported as disabled.

`Shared (iOS)/PassActivityAttributes.swift` is compiled into **both** the iOS
App target and the Widget Extension target. That is not an accident of
convenience: ActivityKit pairs a running activity with the widget that draws it
by matching this type, so dropping it from either target's membership leaves a
granted pass with no card and no build error to say so.

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
- While that pass runs, lock the device: the Lock Screen should show the pass
  card with a clock counting up, the granted length beside it and the purpose
  underneath, and the Dynamic Island should hold the same clock. Nothing of
  ours is running while it ticks — if it freezes, the timer is being driven
  from the wrong place. At the end of the pass the card switches to "PASS
  ENDED" on its own, and is cleared the next time Intention is opened.
- Turn Live Activities off for Intention (Settings → Intention) and grant
  another pass: there should be a notifications permission prompt on the first
  such pass, and a single "Your pass is over" notification when it ends.
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
  stored under `screenTimePassEndsAt`, DeviceActivity schedule started, and the
  pass Live Activity requested.
- Pass timer: `AppBlockingManager.grantPass` → `PassLiveActivityController`,
  which digs the purpose out of the App Group's `activeSessions` (the bridge
  itself only carries the minutes — `shared/coaching.js` calls
  `grantPass(minutes)`, and shared/ is not forked per platform) and hands it to
  the Widget Extension as the activity's attributes. If no activity could be
  started — pre-16.2, or Live Activities switched off for Intention —
  `PassExpiryNotifier` schedules a local notification for the end of the pass
  instead. Both are torn down by `reapplyIfPassExpired()` on foreground and by
  `clearAllBlocking()`.
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
