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
    private static let passEndsAtKey = "screenTimePassEndsAt"

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
            defaults.removeObject(forKey: Self.passEndsAtKey)
        }
    }

    // MARK: - Timed pass (coach-granted)

    var passEndsAt: Date? {
        guard let defaults = UserDefaults(suiteName: AppGroupConfig.identifier) else { return nil }
        let t = defaults.double(forKey: Self.passEndsAtKey)
        guard t > 0 else { return nil }
        let date = Date(timeIntervalSince1970: t)
        return date > Date() ? date : nil
    }

    func grantPass(minutes: Int) {
        let mins = max(1, min(60, minutes))
        let endsAt = Date().addingTimeInterval(TimeInterval(mins * 60))
        if let defaults = UserDefaults(suiteName: AppGroupConfig.identifier) {
            defaults.set(endsAt.timeIntervalSince1970, forKey: Self.passEndsAtKey)
        }
        store.shield.applications = nil
        store.shield.applicationCategories = nil

        // DeviceActivity enforces a minimum interval of ~15 minutes, so the
        // schedule end is clamped; the intervalDidEnd callback in the monitor
        // extension re-shields, and reapplyIfPassExpired() catches shorter
        // passes as soon as the app is foregrounded again.
        let scheduleMins = max(15, mins)
        let now = Date()
        let end = now.addingTimeInterval(TimeInterval(scheduleMins * 60))
        let calendar = Calendar.current
        // Full date components (not just h/m/s) so a pass that crosses
        // midnight doesn't produce an intervalEnd "earlier" than its start.
        let components: Set<Calendar.Component> = [.year, .month, .day, .hour, .minute, .second]
        let schedule = DeviceActivitySchedule(
            intervalStart: calendar.dateComponents(components, from: now),
            intervalEnd: calendar.dateComponents(components, from: end),
            repeats: false
        )
        let center = DeviceActivityCenter()
        center.stopMonitoring([Self.passActivityName])
        try? center.startMonitoring(Self.passActivityName, during: schedule)
    }

    /// Re-applies shields if a granted pass has lapsed. Called on app
    /// foreground as a backup to the DeviceActivityMonitor extension.
    func reapplyIfPassExpired() {
        guard passEndsAt == nil else { return }
        applyShields()
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

    func requestUsageReport(from presenter: UIViewController, days: Int = 30, completion: @escaping ([String: Double]) -> Void) {
        guard let selection = Self.loadSelection(),
              !(selection.applicationTokens.isEmpty && selection.categoryTokens.isEmpty) else {
            completion([:])
            return
        }

        let end = Date()
        guard let start = Calendar.current.date(byAdding: .day, value: -days, to: end) else {
            completion([:])
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

        Self.pollForFreshUsage(after: requestedAt, attemptsLeft: 15) { result in
            hosting.willMove(toParent: nil)
            hosting.view.removeFromSuperview()
            hosting.removeFromParent()
            completion(result)
        }
    }

    private static func pollForFreshUsage(after requestedAt: Date, attemptsLeft: Int, completion: @escaping ([String: Double]) -> Void) {
        guard let defaults = UserDefaults(suiteName: AppGroupConfig.identifier) else {
            completion([:])
            return
        }
        let writtenAt = defaults.double(forKey: usageWrittenAtKey)
        if writtenAt > requestedAt.timeIntervalSince1970,
           let data = defaults.data(forKey: usageDateKey),
           let decoded = try? JSONDecoder().decode([String: Double].self, from: data) {
            completion(decoded)
            return
        }
        guard attemptsLeft > 0 else {
            completion([:])
            return
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) {
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
