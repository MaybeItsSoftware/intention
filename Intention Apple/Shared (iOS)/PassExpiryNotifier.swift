//
//  PassExpiryNotifier.swift
//  Shared (iOS)
//
//  The fallback for when a pass can't have a Live Activity: a single local
//  notification, scheduled for the moment the pass runs out.
//
//  This is second choice, not a companion. A Live Activity already shows the
//  clock the whole way through, so firing a notification on top of one would
//  just be noise — PassLiveActivityController.start() reports whether it got a
//  card up, and only when it didn't does anything here happen. That's iOS
//  before 16.2, and any device where the user has turned Live Activities off
//  for Intention.
//
//  Authorization is asked for here, at the first pass that actually needs it,
//  rather than at launch: a permission prompt on first run has no context to
//  justify itself, and a user who never grants an app pass never sees one.
//

#if os(iOS)
import Foundation
import UserNotifications

final class PassExpiryNotifier: NSObject {
    static let shared = PassExpiryNotifier()

    // One pass at a time, so one identifier — re-scheduling replaces the
    // pending notice rather than queueing a second one behind it.
    private static let requestIdentifier = "uk.co.maybeitssoftware.intention.passExpiry"

    private override init() {
        super.init()
    }

    /// Called once at launch (AppDelegate) so the notice still appears as a
    /// banner if the pass runs out while the user is sitting in the app —
    /// without a delegate iOS silently swallows foreground notifications, and
    /// the app itself shows nothing live in this fallback path.
    func registerAsPresentationDelegate() {
        UNUserNotificationCenter.current().delegate = self
    }

    /// Schedules "your pass is over" for `endsAt`, asking for permission first
    /// if we've never asked. Silently does nothing if the user has said no —
    /// there is no recovery to offer here that wouldn't interrupt the pass
    /// they just earned.
    func scheduleExpiryNotice(at endsAt: Date, minutes: Int, purpose: String) {
        let center = UNUserNotificationCenter.current()
        center.getNotificationSettings { settings in
            switch settings.authorizationStatus {
            case .notDetermined:
                center.requestAuthorization(options: [.alert, .sound]) { granted, _ in
                    guard granted else { return }
                    self.submit(at: endsAt, minutes: minutes, purpose: purpose)
                }
            case .denied:
                return
            default:
                self.submit(at: endsAt, minutes: minutes, purpose: purpose)
            }
        }
    }

    /// Drops the pending notice — for a pass cleared before it ran out. A notice
    /// that has already fired is not recalled; this only removes what's pending.
    func cancel() {
        UNUserNotificationCenter.current()
            .removePendingNotificationRequests(withIdentifiers: [Self.requestIdentifier])
    }

    private func submit(at endsAt: Date, minutes: Int, purpose: String) {
        let content = UNMutableNotificationContent()
        content.title = "Your pass is over"
        // Says what happened and what it was for, in the order the badge on
        // desktop says it: the length, then the purpose in the user's own words.
        content.body = purpose.isEmpty
            ? "Your \(minutes)-minute pass has ended and your blocked apps are back."
            : "Your \(minutes)-minute pass for \u{201C}\(purpose)\u{201D} has ended. Your blocked apps are back."
        content.sound = .default

        let request = UNNotificationRequest(
            identifier: Self.requestIdentifier,
            content: content,
            // A time interval rather than a calendar trigger: passes are
            // minutes long, and an interval can't be knocked sideways by a
            // timezone change mid-pass.
            trigger: UNTimeIntervalNotificationTrigger(
                timeInterval: max(1, endsAt.timeIntervalSinceNow),
                repeats: false
            )
        )
        UNUserNotificationCenter.current().add(request) { error in
            if let error {
                NSLog("[Intention] could not schedule the pass expiry notice: %@", String(describing: error))
            }
        }
    }
}

extension PassExpiryNotifier: UNUserNotificationCenterDelegate {
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([.banner, .sound])
    }
}
#endif
