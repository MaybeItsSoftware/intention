//
//  AppGroupConfig.swift
//  Shared (iOS)
//
//  Created by Adam on 09/07/2026.
//

import Foundation

// Identifiers shared between the iOS App and iOS Extension targets, both of
// which need the "App Groups" capability enabled in Signing & Capabilities
// with this same group added (see iOS (App).entitlements / iOS
// (Extension).entitlements).
enum AppGroupConfig {
    // TODO: replace with the real App Group identifier once the Apple
    // Developer Team ID is known (Signing & Capabilities -> App Groups on
    // both the iOS App and iOS Extension targets). Must match the group
    // string in both .entitlements files.
    static let identifier = "group.uk.co.maybeitssoftware.intention"

    // The subset of extension config keys that are synced between the native
    // app and the Safari Web Extension via the App Group. Mirrors CONFIG_KEYS
    // in tracking.js — keep the two lists in sync.
    static let configKeys: [String] = [
        "provider", "apiKey", "model", "userContext", "contextProjects",
        "contextReasons", "coachInstructions", "blockedDomains", "domainLimits",
        "blockedApps", "appLimits", "appLabels",
        // The In-App Purchase entitlement. StoreKit only runs in the app, so
        // this is how a subscription bought there reaches the Safari extension.
        "entitlement",
        "setupComplete",
        // Kept in lockstep with tracking.js. These are declarative blocking
        // configuration, never usage/activity data; a list restored in the
        // app must be visible to Safari too.
        "serviceReasons", "pendingChanges",
        "leaveDelayMinutes"
    ]

    static let extensionLastSeenAtKey = "extensionLastSeenAt"

    // Website activity pushed by each Safari extension install (tracking.js's
    // pushActivityToNative). Its own UserDefaults key rather than a field in
    // the shared JSON blob: the extension writes it every minute of browsing,
    // and a read-modify-write of the whole blob from another process would
    // race the app's own writes to chat history and settings. Surfaced to the
    // app's JS under the same name, read-only.
    static let webActivityKey = "webActivity"
    // A source that hasn't pushed in this long is an old profile or a Safari
    // that's been removed; its days are older than anything shown anyway.
    static let webActivityStaleAfter: TimeInterval = 35 * 24 * 60 * 60
}

// The clock a coach-granted Screen Time pass runs on, shared by the app
// (AppBlockingManager) and the Monitor extension so both answer "is this pass
// over?" the same way. Lives here because this is the one file every Screen
// Time target already compiles.
//
// A pass used to be a single wall-clock end time compared against Date(), and
// the wall clock belongs to the user: set it back an hour (or fly west, with
// automatic time off) and an hour-long pass became a two-hour one, with every
// backstop agreeing it still had time to run. So the start is recorded too,
// along with a reading of the monotonic clock, which keeps counting through
// sleep and cannot be set. A pass is over as soon as ANY of these says so:
//   - the wall clock has reached its end (the ordinary case);
//   - the wall clock reads earlier than its start (the clock went back);
//   - the monotonic clock has run the pass's whole length.
// Every one of those fails closed: the worst a wrong answer can do is end a
// pass early, never stretch it.
nonisolated enum PassClock {
    // Wall-clock seconds since 1970. The end key predates this type and is
    // read by older builds of the Monitor extension, so its name is fixed.
    static let endsAtKey = "screenTimePassEndsAt"
    static let startedAtKey = "screenTimePassStartedAt"
    // CLOCK_MONOTONIC seconds when the pass started — time since boot,
    // counting sleep, untouched by clock changes.
    static let startedMonotonicKey = "screenTimePassStartedMonotonic"

    static func monotonicNow() -> TimeInterval {
        TimeInterval(clock_gettime_nsec_np(CLOCK_MONOTONIC)) / 1_000_000_000
    }

    static func record(startedAt: Date, endsAt: Date, in defaults: UserDefaults) {
        defaults.set(startedAt.timeIntervalSince1970, forKey: startedAtKey)
        defaults.set(monotonicNow(), forKey: startedMonotonicKey)
        defaults.set(endsAt.timeIntervalSince1970, forKey: endsAtKey)
    }

    static func clear(in defaults: UserDefaults) {
        defaults.removeObject(forKey: endsAtKey)
        defaults.removeObject(forKey: startedAtKey)
        defaults.removeObject(forKey: startedMonotonicKey)
    }

    static func hasRecord(in defaults: UserDefaults) -> Bool {
        defaults.double(forKey: endsAtKey) > 0
    }

    /// Seconds left on the recorded pass: nil when there is none, zero or less
    /// once it is over by any of the measures above.
    static func remaining(in defaults: UserDefaults, now: Date = Date()) -> TimeInterval? {
        let endsAt = defaults.double(forKey: endsAtKey)
        guard endsAt > 0 else { return nil }
        let nowWall = now.timeIntervalSince1970
        var remaining = endsAt - nowWall

        // A pass recorded by a build before this one has only its end; the
        // wall clock is all there is to go on for it.
        let startedAt = defaults.double(forKey: startedAtKey)
        guard startedAt > 0 else { return remaining }
        if nowWall < startedAt { return 0 }

        // The monotonic clock restarts at boot, so a reading lower than the
        // one taken at the start means the device has restarted since, and
        // the difference means nothing. After a restart that has already
        // outrun the old reading, the difference UNDER-counts the true elapsed
        // time (it misses everything before the restart), so it can only ever
        // end a pass late, never early — still no worse than the wall clock it
        // is backing up.
        let startedMono = defaults.double(forKey: startedMonotonicKey)
        let nowMono = monotonicNow()
        if startedMono > 0, nowMono >= startedMono {
            let length = endsAt - startedAt
            remaining = min(remaining, length - (nowMono - startedMono))
        }
        return remaining
    }
}
