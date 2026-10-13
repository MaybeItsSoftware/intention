//
//  AppBlockingManager.swift
//  Shared (iOS)
//
//  Native app blocking via the Screen Time APIs (FamilyControls +
//  ManagedSettings + DeviceActivity). iOS only.
//
//  Flow:
//  - The options page (options.html in the app's WKWebView) asks us to
//    authorize and to present the system FamilyActivityPicker; the chosen
//    FamilyActivitySelection is opaque (no bundle ids), so it is persisted
//    natively in the App Group rather than in the web config.
//  - Shields are applied with ManagedSettingsStore. When the coach grants
//    time, `grantPass(minutes:)` lifts all shields and schedules re-shielding
//    with DeviceActivity (enforced by the DeviceActivityMonitor extension —
//    see APP_BLOCKING_SETUP.md) plus an in-app check on foreground as backup.
//

#if os(iOS)
import Foundation
import UIKit

#if canImport(FamilyControls) && canImport(ManagedSettings) && canImport(DeviceActivity)
import FamilyControls
import ManagedSettings
import DeviceActivity
import SwiftUI

@available(iOS 16.0, *)
final class AppBlockingManager {
    static let shared = AppBlockingManager()

    static let passActivityName = DeviceActivityName("intentionPass")
    private static let selectionKey = "screenTimeSelection"

    private let store = ManagedSettingsStore()
    private init() {}

    // MARK: - Authorization

    var isAuthorized: Bool {
        AuthorizationCenter.shared.authorizationStatus == .approved
    }

    /// String form of the authorization state for the JS bridge, so the
    /// options page can distinguish "never asked" from "declined" and show
    /// recovery guidance for the latter (iOS won't always re-prompt after a
    /// denial; the user may have to enable it in Settings > Screen Time).
    var authorizationStatusString: String {
        switch AuthorizationCenter.shared.authorizationStatus {
        case .approved: return "approved"
        case .denied: return "denied"
        case .notDetermined: return "notDetermined"
        @unknown default: return "notDetermined"
        }
    }

    func requestAuthorization() async -> Bool {
        do {
            try await AuthorizationCenter.shared.requestAuthorization(for: .individual)
            return true
        } catch {
            return false
        }
    }

    // MARK: - Selection persistence (App Group, shared with the extensions)

    static func loadSelection() -> FamilyActivitySelection? {
        guard let defaults = UserDefaults(suiteName: AppGroupConfig.identifier),
              let data = defaults.data(forKey: selectionKey) else { return nil }
        return try? JSONDecoder().decode(FamilyActivitySelection.self, from: data)
    }

    private func saveSelection(_ selection: FamilyActivitySelection) {
        guard let defaults = UserDefaults(suiteName: AppGroupConfig.identifier),
              let data = try? JSONEncoder().encode(selection) else { return }
        defaults.set(data, forKey: Self.selectionKey)
    }

    var selectionCount: Int {
        guard let s = Self.loadSelection() else { return 0 }
        return s.applicationTokens.count + s.categoryTokens.count
    }

    // MARK: - Picker

    func presentPicker(from presenter: UIViewController, completion: @escaping (Int) -> Void) {
        let initial = Self.loadSelection() ?? FamilyActivitySelection()
        let pickerVC = UIHostingController(rootView: AppPickerSheet(
            selection: initial,
            onDone: { [weak self] selection in
                guard let self else { return }
                self.saveSelection(selection)
                self.applyShields()
                presenter.dismiss(animated: true) {
                    completion(self.selectionCount)
                }
            },
            onCancel: { [weak self] in
                presenter.dismiss(animated: true) {
                    completion(self?.selectionCount ?? 0)
                }
            }
        ))
        presenter.present(pickerVC, animated: true)
    }

    // MARK: - Shielding

    static func applyShields(to store: ManagedSettingsStore) {
        guard let selection = loadSelection() else { return }
        store.shield.applications = selection.applicationTokens.isEmpty ? nil : selection.applicationTokens
        store.shield.applicationCategories = selection.categoryTokens.isEmpty
            ? nil
            : .specific(selection.categoryTokens)
    }

    func applyShields() {
        Self.applyShields(to: store)
    }

    func clearAllBlocking() {
        DeviceActivityCenter().stopMonitoring([Self.passActivityName])
        store.shield.applications = nil
        store.shield.applicationCategories = nil
        if let defaults = UserDefaults(suiteName: AppGroupConfig.identifier) {
            defaults.removeObject(forKey: Self.selectionKey)
            PassClock.clear(in: defaults)
        }
        // Nothing is blocked any more, so any pass that was running has been
        // ended early — take its Lock Screen card and its expiry notice with it
        // rather than leaving a clock counting down against nothing.
        endPassTimerUI()
    }

    // MARK: - Timed pass (coach-granted)

    /// When the running pass ends, in terms of the clock as it reads now, or
    /// nil if there is none. Asks PassClock rather than comparing the stored
    /// end with Date(), so a clock set back mid-pass can't stretch it — see
    /// the note on PassClock in AppGroupConfig.swift.
    var passEndsAt: Date? {
        guard let defaults = UserDefaults(suiteName: AppGroupConfig.identifier),
              let remaining = PassClock.remaining(in: defaults),
              remaining > 0 else { return nil }
        return Date().addingTimeInterval(remaining)
    }

    /// Returns false, leaving everything shielded, when Screen Time will not
    /// take the schedule that puts the shields back.
    @discardableResult
    func grantPass(minutes: Int) -> Bool {
        // Up to a whole day's budget (MAX_DAILY_MINUTES in shared/rules.js): a
        // daily-time visit can be as long as the minutes left, and clamping it
        // shorter here would re-shield the apps while the worker still counts
        // the visit as running.
        let mins = max(1, min(240, minutes))
        let startedAt = Date()
        let endsAt = startedAt.addingTimeInterval(TimeInterval(mins * 60))
        let center = DeviceActivityCenter()
        center.stopMonitoring([Self.passActivityName])
        // Registered before anything is lifted. A schedule Screen Time turns
        // down (authorization revoked, too many activities) used to be
        // swallowed by try? after the shields were already off — leaving the
        // apps open with nothing to close them until Intention was next opened.
        do {
            try Self.startPassMonitoring(center: center, startedAt: startedAt, endsAt: endsAt, mins: mins)
        } catch {
            NSLog("Intention: could not schedule the end of a pass, so it was not granted: \(error)")
            // The stopMonitoring above has already taken the end schedule off
            // any pass that was running, so that pass cannot be left lifted
            // with nothing to close it: end it here, shields back on. The
            // worker still has it open, and the next grant or its own expiry
            // settles that — fail closed rather than open.
            endPass()
            return false
        }

        if let defaults = UserDefaults(suiteName: AppGroupConfig.identifier) {
            PassClock.record(startedAt: startedAt, endsAt: endsAt, in: defaults)
        }
        store.shield.applications = nil
        store.shield.applicationCategories = nil

        // A previous pass's "your pass is over" notice may still be pending —
        // the Live Activity path below never schedules one, so nothing else
        // replaces it, and left alone it fires in the middle of this pass.
        PassExpiryNotifier.shared.cancel()

        // Show the user their own pass running. Until this, iOS gave a granted
        // pass no face at all — the shields simply lifted and the only way to
        // know how much of the window was left was to come back into the app
        // and read a sentence about it. The desktop extension has shown a live
        // badge on the page the whole time (renderStatusBadge() in
        // shared/content.js); this is that, on the Lock Screen.
        //
        // Safe to do here because the app is always foregrounded at this point
        // — grantPass only ever arrives from the in-app Unlock tab — and
        // ActivityKit refuses to start an activity from the background.
        let purpose = PassPurpose.current()
        if !PassLiveActivityController.shared.start(startedAt: startedAt, endsAt: endsAt, purpose: purpose) {
            // No Live Activities on this device (pre-16.2, or switched off for
            // Intention in Settings). One notification at the end is a poorer
            // answer than a running clock, but it is not nothing.
            PassExpiryNotifier.shared.scheduleExpiryNotice(at: endsAt, minutes: mins, purpose: purpose)
        }

        return true
    }

    /// Registers the DeviceActivity schedule whose intervalDidEnd re-shields
    /// at `endsAt`.
    ///
    /// DeviceActivity will not take an interval shorter than 15 minutes, but
    /// the interval may start in the past. So the schedule always ENDS at the
    /// pass's end, and a shorter pass's interval is backdated to start 15
    /// minutes before that: intervalDidEnd then fires exactly when the pass
    /// does. That replaced a warningTime trick (a 15-minute schedule warning
    /// at the pass's end), which failed open — a warning that arrived more
    /// than a little early was ignored, and nothing re-armed it, so the pass
    /// quietly ran to the full 15.
    ///
    /// If Screen Time turns the backdated schedule down, the old shape is the
    /// fallback rather than no pass at all; the Monitor extension's warning
    /// handler still re-shields on it, and reapplyIfPassExpired() catches
    /// whatever it misses on the next foreground.
    ///
    /// Components carry the time zone, so the end is an instant rather than a
    /// local wall-clock reading that a time-zone change would move.
    private static func startPassMonitoring(center: DeviceActivityCenter, startedAt: Date, endsAt: Date, mins: Int) throws {
        let minimum: TimeInterval = 15 * 60
        let calendar = Calendar.current
        // Full date components (not just h/m/s) so a pass that crosses
        // midnight doesn't produce an intervalEnd "earlier" than its start.
        let fields: Set<Calendar.Component> = [.year, .month, .day, .hour, .minute, .second]
        func components(_ date: Date) -> DateComponents {
            var c = calendar.dateComponents(fields, from: date)
            c.calendar = calendar
            c.timeZone = calendar.timeZone
            return c
        }

        let start = min(startedAt, endsAt.addingTimeInterval(-minimum))
        do {
            try center.startMonitoring(passActivityName, during: DeviceActivitySchedule(
                intervalStart: components(start),
                intervalEnd: components(endsAt),
                repeats: false
            ))
            return
        } catch {
            // A pass of 15 minutes or more was never backdated, so there is
            // nothing different to retry with.
            guard start < startedAt else { throw error }
            NSLog("Intention: Screen Time refused a backdated pass schedule, falling back to a warning: \(error)")
        }

        let scheduleEnd = startedAt.addingTimeInterval(minimum)
        try center.startMonitoring(passActivityName, during: DeviceActivitySchedule(
            intervalStart: components(startedAt),
            intervalEnd: components(scheduleEnd),
            repeats: false,
            warningTime: DateComponents(minute: 15 - mins)
        ))
    }

    /// Ends a granted pass before its time: "I'm finished". iOS cannot see the
    /// user leave a blocked app, so on this platform finishing has to be said
    /// rather than inferred. Same teardown as the pass lapsing — shields back,
    /// monitoring stopped, Lock Screen card and expiry notice gone — but the
    /// app selection stays, unlike clearAllBlocking. The caller records the
    /// pass in the shared worker (endSession), which is where its minutes live.
    func endPass() {
        DeviceActivityCenter().stopMonitoring([Self.passActivityName])
        if let defaults = UserDefaults(suiteName: AppGroupConfig.identifier) {
            PassClock.clear(in: defaults)
        }
        applyShields()
        endPassTimerUI()
    }

    /// Re-applies shields if a granted pass has lapsed. Called on app foreground
    /// as a backup to the DeviceActivityMonitor extension — and the only thing
    /// that runs at all after a device restart, since the app gets no background
    /// execution and a schedule registered before the reboot may never deliver
    /// its intervalDidEnd. Until this runs, a pass interrupted by a restart
    /// leaves the blocked apps unshielded.
    ///
    /// Also clears the stale pass record and stops its monitoring, so the state
    /// left behind matches what intervalDidEnd would have produced.
    func reapplyIfPassExpired() {
        guard passEndsAt == nil else { return }
        if let defaults = UserDefaults(suiteName: AppGroupConfig.identifier),
           PassClock.hasRecord(in: defaults) {
            PassClock.clear(in: defaults)
            DeviceActivityCenter().stopMonitoring([Self.passActivityName])
            // PassClock can call a pass over while the wall clock still says
            // otherwise (it was set back), and the card and the notice both
            // go by the wall clock — so take them down outright here rather
            // than leaving them to it.
            endPassTimerUI()
        }
        // The Live Activity has been showing "pass ended" since its staleDate
        // passed, but only a process of ours can actually take the card down —
        // and this is the first moment there is one. Same catch-up shape as the
        // re-shielding above.
        PassLiveActivityController.shared.endIfExpired()
        applyShields()
    }

    /// Tears down both halves of the pass timer UI at once — for a pass that
    /// ends before its clock runs out, where neither the Live Activity's
    /// staleDate nor a scheduled expiry notice is telling the truth any more.
    private func endPassTimerUI() {
        PassLiveActivityController.shared.end()
        PassExpiryNotifier.shared.cancel()
    }

    // MARK: - Aggregate app-usage report (DeviceActivityReport)
    //
    // Per-app identity is intentionally never exposed by Family Controls
    // outside Apple's own rendering (ApplicationToken has no name/bundle-id
    // accessor), so this only surfaces one aggregate minutes-per-day number
    // across the blocked selection -- see the Intention Report Extension
    // target (iOS (Report Extension)/ReportExtension.swift), which does the
    // actual aggregation and writes the result into the App Group.
    //
    // Presenting the (invisible, zero-size) DeviceActivityReport view is what
    // triggers the OS to run the report extension; since the extension runs
    // in a separate process, the result comes back via the App Group rather
    // than a return value. This polls briefly for a freshly-written result
    // instead of wiring up CFNotificationCenter Darwin notifications, which
    // would cut the latency but needs real cross-process C-callback plumbing
    // -- worth revisiting once this is verified on-device (Screen Time report
    // extensions do not run in the Simulator, so this can only be exercised
    // on a physical device).
    private static let usageDateKey = "iosAppUsageByDate"
    private static let usageWrittenAtKey = "iosAppUsageWrittenAt"
    private static let usageReportContext = DeviceActivityReport.Context(rawValue: "intentionTotalMinutes")

    // How long to wait for the report extension. A 30-day query over a whole
    // category is real work, and the old 3 seconds gave up before most
    // devices could have answered. Not much longer than this, though: the
    // options page's usage log waits on the answer before it renders at all.
    private static let usagePollInterval: TimeInterval = 0.25
    private static let usagePollAttempts = 40 // 10 seconds

    /// Where a usage report came from, passed to the page as `status` so it can
    /// tell "no usage" from "no answer" — both used to arrive as an empty map.
    enum UsageReportStatus: String {
        /// Freshly computed for this request.
        case fresh
        /// The extension didn't answer in time; this is the last report it did
        /// write, as of `writtenAt`.
        case stale
        /// The extension didn't answer and has never written one.
        case unavailable
        /// No apps are selected, so there is nothing to report on.
        case noSelection
    }

    func requestUsageReport(from presenter: UIViewController, days: Int = 30,
                            completion: @escaping (_ minutesByDate: [String: Double], _ status: UsageReportStatus, _ writtenAt: Date?) -> Void) {
        guard let selection = Self.loadSelection(),
              !(selection.applicationTokens.isEmpty && selection.categoryTokens.isEmpty) else {
            completion([:], .noSelection, nil)
            return
        }

        let end = Date()
        guard let start = Calendar.current.date(byAdding: .day, value: -days, to: end) else {
            completion([:], .unavailable, nil)
            return
        }

        let requestedAt = Date()
        let filter = DeviceActivityFilter(
            segment: .daily(during: DateInterval(start: start, end: end)),
            users: .all,
            devices: .init([.iPhone, .iPad]),
            applications: selection.applicationTokens,
            categories: selection.categoryTokens
        )

        let hosting = UIHostingController(rootView: DeviceActivityReport(Self.usageReportContext, filter: filter))
        hosting.view.frame = .zero
        hosting.view.isHidden = true
        presenter.addChild(hosting)
        presenter.view.insertSubview(hosting.view, at: 0)
        hosting.didMove(toParent: presenter)

        Self.pollForFreshUsage(after: requestedAt, attemptsLeft: Self.usagePollAttempts) { result, status, writtenAt in
            hosting.willMove(toParent: nil)
            hosting.view.removeFromSuperview()
            hosting.removeFromParent()
            completion(result, status, writtenAt)
        }
    }

    private static func pollForFreshUsage(after requestedAt: Date, attemptsLeft: Int,
                                          completion: @escaping ([String: Double], UsageReportStatus, Date?) -> Void) {
        guard let defaults = UserDefaults(suiteName: AppGroupConfig.identifier) else {
            completion([:], .unavailable, nil)
            return
        }
        let writtenAt = defaults.double(forKey: usageWrittenAtKey)
        let stored = defaults.data(forKey: usageDateKey)
            .flatMap { try? JSONDecoder().decode([String: Double].self, from: $0) }
        if writtenAt > requestedAt.timeIntervalSince1970, let stored {
            completion(stored, .fresh, Date(timeIntervalSince1970: writtenAt))
            return
        }
        guard attemptsLeft > 0 else {
            // Out of time. Hand back the last report the extension managed,
            // labelled as such, rather than an empty map that reads as "you
            // used none of your blocked apps".
            if writtenAt > 0, let stored {
                completion(stored, .stale, Date(timeIntervalSince1970: writtenAt))
            } else {
                completion([:], .unavailable, nil)
            }
            return
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + usagePollInterval) {
            pollForFreshUsage(after: requestedAt, attemptsLeft: attemptsLeft - 1, completion: completion)
        }
    }
}

@available(iOS 16.0, *)
private struct AppPickerSheet: View {
    @State var selection: FamilyActivitySelection
    let onDone: (FamilyActivitySelection) -> Void
    let onCancel: () -> Void

    var body: some View {
        NavigationView {
            FamilyActivityPicker(selection: $selection)
                .navigationTitle("Apps to block")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Cancel", action: onCancel)
                    }
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Done") { onDone(selection) }
                    }
                }
        }
    }
}
#endif
#endif
