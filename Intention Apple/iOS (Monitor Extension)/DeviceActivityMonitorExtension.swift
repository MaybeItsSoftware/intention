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

    // Only reached on the fallback schedule — a pass shorter than
    // DeviceActivity's 15-minute minimum whose backdated schedule Screen Time
    // refused (see startPassMonitoring in AppBlockingManager) — where the
    // warning is set to land when the pass itself ends. Checked rather than
    // trusted blindly: a warning can arrive a little early, and re-shielding
    // with time still on the pass would cut it short. Checked with PassClock
    // rather than the stored end against Date(), so a clock set back mid-pass
    // can't talk this out of re-shielding.
    override func intervalWillEndWarning(for activity: DeviceActivityName) {
        super.intervalWillEndWarning(for: activity)
        guard activity == DeviceActivityName("intentionPass") else { return }
        if let defaults = UserDefaults(suiteName: AppGroupConfig.identifier),
           let remaining = PassClock.remaining(in: defaults),
           remaining > 30 {
            return
        }
        reshield()
    }

    private func reshield() {
        let defaults = UserDefaults(suiteName: AppGroupConfig.identifier)
        if let defaults { PassClock.clear(in: defaults) }

        guard let data = defaults?.data(forKey: "screenTimeSelection"),
              let selection = try? JSONDecoder().decode(FamilyActivitySelection.self, from: data) else { return }
        store.shield.applications = selection.applicationTokens.isEmpty ? nil : selection.applicationTokens
        store.shield.applicationCategories = selection.categoryTokens.isEmpty
            ? nil
            : .specific(selection.categoryTokens)
    }
}
#endif
