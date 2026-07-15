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
