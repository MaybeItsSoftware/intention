//
//  DeviceActivityMonitorExtension.swift
//  Intention Monitor Extension
//
//  Re-applies the app shields when a coach-granted pass window ends.
//  Target membership: this file + AppGroupConfig.swift.
//
//  The selection-loading and shield logic is intentionally inlined here
//  (rather than reusing AppBlockingManager) so this target only needs
//  FamilyControls/ManagedSettings/DeviceActivity and AppGroupConfig.swift.
//

#if os(iOS)
import DeviceActivity
import FamilyControls
import ManagedSettings
import Foundation

class DeviceActivityMonitorExtension: DeviceActivityMonitor {
    private let store = ManagedSettingsStore()

    override func intervalDidEnd(for activity: DeviceActivityName) {
        super.intervalDidEnd(for: activity)
        guard activity == DeviceActivityName("intentionPass") else { return }
        reshield()
    }

    // A pass shorter than DeviceActivity's 15-minute minimum is scheduled for
    // 15 with a warning set to fire when the pass itself ends (see grantPass
    // in AppBlockingManager). Checked against the stored end rather than
    // trusted blindly: a warning can arrive a little early, and re-shielding
    // with time still on the pass would cut it short.
    override func intervalWillEndWarning(for activity: DeviceActivityName) {
        super.intervalWillEndWarning(for: activity)
        guard activity == DeviceActivityName("intentionPass") else { return }
        let endsAt = UserDefaults(suiteName: AppGroupConfig.identifier)?
            .double(forKey: "screenTimePassEndsAt") ?? 0
        guard endsAt <= Date().timeIntervalSince1970 + 30 else { return }
        reshield()
    }

    private func reshield() {
        let defaults = UserDefaults(suiteName: AppGroupConfig.identifier)
        defaults?.removeObject(forKey: "screenTimePassEndsAt")

        guard let data = defaults?.data(forKey: "screenTimeSelection"),
              let selection = try? JSONDecoder().decode(FamilyActivitySelection.self, from: data) else { return }
        store.shield.applications = selection.applicationTokens.isEmpty ? nil : selection.applicationTokens
        store.shield.applicationCategories = selection.categoryTokens.isEmpty
            ? nil
            : .specific(selection.categoryTokens)
    }
}
#endif
