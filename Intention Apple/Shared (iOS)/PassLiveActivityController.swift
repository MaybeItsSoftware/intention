//
//  PassLiveActivityController.swift
//  Shared (iOS)
//
//  Starts and ends the Live Activity that runs for the length of a
//  coach-granted pass. App-side only — the drawing lives in the Widget
//  Extension target (iOS (Widget Extension)/PassActivityWidget.swift); this
//  is the half that knows when a pass begins and ends.
//
//  Why a Live Activity and not a timer we tick ourselves: the app gets no
//  background execution (see BackgroundJSHost's catch-up comments — even its
//  in-process alarm timers die the moment iOS suspends us). A Live Activity's
//  Text(timerInterval:countsDown:) is rendered by the system from a date
//  range, so the clock on the Lock Screen keeps running with nothing of ours
//  alive to run it. Nothing here ever pushes an update.
//
//  Starting one requires the app to be foregrounded, which it is: passes are
//  granted from the in-app Unlock tab (options.html -> coaching.html ->
//  window.intentionScreenTime.grantPass, see Shared (App)/Resources/
//  ios-bridge.js), so grantPass() always runs with the app on screen.
//

#if os(iOS)
import Foundation

#if canImport(ActivityKit)
import ActivityKit
#endif

@available(iOS 16.0, *)
final class PassLiveActivityController {
    static let shared = PassLiveActivityController()

    // Ends the activity at the exact moment the pass runs out, for the common
    // case where the user is still in the app (or comes back to it) when the
    // clock hits zero. Best-effort only: iOS stops this timer as soon as the
    // app leaves the foreground, which is what the staleDate below and
    // endIfExpired() on foreground are for.
    private var expiryTimer: Timer?

    private init() {}

    /// Whether Live Activities can actually run right now. False on iOS < 16.2,
    /// and false when the user has turned them off for this app in Settings —
    /// which is precisely when the local-notification fallback has to engage.
    var isAvailable: Bool {
#if canImport(ActivityKit)
        guard #available(iOS 16.2, *) else { return false }
        return ActivityAuthorizationInfo().areActivitiesEnabled
#else
        return false
#endif
    }

    /// Puts a pass on the Lock Screen and in the Dynamic Island for its whole
    /// length. Returns false if no activity could be started, so the caller can
    /// fall back to a local notification instead of leaving the user with
    /// nothing at all — which is what iOS showed during a pass before this.
    @discardableResult
    func start(startedAt: Date, endsAt: Date, purpose: String) -> Bool {
#if canImport(ActivityKit)
        guard #available(iOS 16.2, *), isAvailable else { return false }

        // One pass at a time: granting again replaces the previous pass rather
        // than stacking a second clock on the Lock Screen.
        endAllActivities()

        let attributes = PassActivityAttributes(purpose: purpose)
        let state = PassActivityAttributes.ContentState(startedAt: startedAt, endsAt: endsAt)
        // staleDate is what lets the card tell the truth without us: at the
        // moment the pass runs out the system re-renders with context.isStale
        // set, and the widget switches to its "pass ended" wording. Ending it
        // for real still needs a process of ours to run — see endIfExpired().
        let content = ActivityContent(state: state, staleDate: endsAt)

        do {
            _ = try Activity.request(attributes: attributes, content: content, pushType: nil)
        } catch {
            NSLog("[Intention] could not start the pass Live Activity: %@", String(describing: error))
            return false
        }

        expiryTimer?.invalidate()
        expiryTimer = Timer.scheduledTimer(
            withTimeInterval: max(1, endsAt.timeIntervalSinceNow),
            repeats: false
        ) { [weak self] _ in
            self?.end()
        }
        return true
#else
        return false
#endif
    }

    /// Takes the pass card down. Safe to call when there is nothing running.
    func end() {
        expiryTimer?.invalidate()
        expiryTimer = nil
#if canImport(ActivityKit)
        guard #available(iOS 16.2, *) else { return }
        endAllActivities()
#endif
    }

    /// Foreground catch-up. A pass that ran out while the app was suspended
    /// leaves a stale-but-still-present card behind (the system only re-renders
    /// it, it can't dismiss it for us), so clear it the moment we're running
    /// again — same "what came due while we weren't here?" shape as
    /// BackgroundJSHost.catchUpOnDueWork() and reapplyIfPassExpired().
    func endIfExpired() {
#if canImport(ActivityKit)
        guard #available(iOS 16.2, *) else { return }
        let now = Date()
        for activity in Activity<PassActivityAttributes>.activities
        where activity.content.state.endsAt <= now {
            Task { await activity.end(nil, dismissalPolicy: .immediate) }
        }
#endif
    }

#if canImport(ActivityKit)
    @available(iOS 16.2, *)
    private func endAllActivities() {
        for activity in Activity<PassActivityAttributes>.activities {
            Task { await activity.end(nil, dismissalPolicy: .immediate) }
        }
    }
#endif
}

// The purpose the user gave the coach, dug out of the shared store.
//
// It can't come in through the bridge: shared/coaching.js calls
// window.intentionScreenTime.grantPass(minutes) with the minutes and nothing
// else, and shared/ is the single source of truth for all four platforms — not
// something to fork for one of them. The session itself is right there in the
// App Group though, because background.js runs in this app's own hidden
// WebView (BackgroundJSHost) and writes activeSessions through it.
enum PassPurpose {
    /// The reason on the most recently started live session, or "" if there
    /// isn't one. Newest-wins rather than keyed lookup because the native
    /// bridge doesn't say which target the pass was for: grantSession() in
    /// background.js keys tab-less sessions as `target:<domain>`, and the one
    /// just granted is by definition the newest.
    static func current() -> String {
        let sessions = AppGroupStorage.get(["activeSessions"])["activeSessions"] as? [String: Any] ?? [:]
        let now = Date().timeIntervalSince1970 * 1000
        var newestStart = -Double.greatestFiniteMagnitude
        var purpose = ""

        for value in sessions.values {
            guard let session = value as? [String: Any],
                  // Same liveness test as activeSession() in background.js:
                  // banked (endedAt) or past its interval means it isn't a
                  // pass any more, whatever it says about a purpose.
                  session["endedAt"] == nil,
                  let startTime = numeric(session["startTime"]),
                  let intervalMinutes = numeric(session["intervalMinutes"]),
                  startTime + intervalMinutes * 60_000 > now,
                  startTime > newestStart
            else { continue }
            newestStart = startTime
            purpose = (session["reason"] as? String) ?? ""
        }
        return purpose.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static func numeric(_ value: Any?) -> Double? {
        (value as? NSNumber)?.doubleValue
    }
}
#endif
