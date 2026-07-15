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
        let schedule = DeviceActivitySchedule(
            intervalStart: calendar.dateComponents([.hour, .minute, .second], from: now),
            intervalEnd: calendar.dateComponents([.hour, .minute, .second], from: end),
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
