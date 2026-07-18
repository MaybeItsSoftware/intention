//
//  ReportExtension.swift
//  iOS (Report Extension)
//
//  DeviceActivityReport extension used only to compute an AGGREGATE
//  total-minutes-used number for the currently-blocked apps/categories, day
//  by day. Apple's Family Controls APIs deliberately keep per-app identity
//  opaque outside Apple-rendered UI (see AppBlockingManager.swift's header
//  comment and APP_BLOCKING_SETUP.md) -- ApplicationToken has no name/
//  bundle-id accessor, only Label(token) rendering inside a report's own
//  SwiftUI content. So this extension does NOT attempt a per-app breakdown;
//  it sums activity duration across every app/category the host app's filter
//  matches (see AppBlockingManager.requestUsageReport) and writes one number
//  per day into the App Group, which AppBlockingManager reads back for the
//  options page's usage log.
//
//  Target membership: this file + Shared (iOS)/AppGroupConfig.swift (same
//  pattern as the Monitor extension -- see APP_BLOCKING_SETUP.md, which also
//  documents adding this as a 4th extension target).
//
//  NOTE: DeviceActivityReport extensions only run on a physical device (the
//  Simulator has no Screen Time data), so none of this can be exercised
//  until the Xcode target exists and is tested on-device -- treat the exact
//  framework call shapes here as a best-effort implementation against
//  Apple's documented DeviceActivityReportScene API, not as compiled/
//  verified code. The `intentionTotalMinutes` context string below must
//  match the one used by AppBlockingManager.requestUsageReport exactly.
//

#if os(iOS)
import DeviceActivity
import SwiftUI

@main
struct IntentionUsageReport: DeviceActivityReportExtension {
    var body: some DeviceActivityReportScene {
        TotalMinutesScene()
    }
}

struct TotalMinutesScene: DeviceActivityReportScene {
    let context: DeviceActivityReport.Context = .init(rawValue: "intentionTotalMinutes")
    let content: ([String: Double]) -> TotalMinutesView = { _ in TotalMinutesView() }

    func makeConfiguration(representing data: DeviceActivityResults<DeviceActivityData>) async -> [String: Double] {
        var minutesByDate: [String: Double] = [:]
        let formatter = ReportExtensionSupport.dateKeyFormatter

        for await segmentData in data {
            for await activitySegment in segmentData.activitySegments {
                let key = formatter.string(from: activitySegment.dateInterval.start)
                let minutes = activitySegment.totalActivityDuration / 60
                minutesByDate[key, default: 0] += minutes
            }
        }

        ReportExtensionSupport.writeUsage(minutesByDate)
        return minutesByDate
    }
}

// No UI is ever actually shown to the user -- the host app only presents
// this off-screen (zero-size, hidden) to trigger the computation above. See
// AppBlockingManager.requestUsageReport.
struct TotalMinutesView: View {
    let minutesByDate: [String: Double]

    init(_ minutesByDate: [String: Double] = [:]) {
        self.minutesByDate = minutesByDate
    }

    var body: some View {
        Color.clear
    }
}

enum ReportExtensionSupport {
    static let dateKeyFormatter: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd"
        f.calendar = Calendar(identifier: .gregorian)
        return f
    }()

    // Keys must match AppBlockingManager's usageDateKey/usageWrittenAtKey.
    private static let usageDateKey = "iosAppUsageByDate"
    private static let usageWrittenAtKey = "iosAppUsageWrittenAt"

    static func writeUsage(_ minutesByDate: [String: Double]) {
        guard let defaults = UserDefaults(suiteName: AppGroupConfig.identifier),
              let data = try? JSONEncoder().encode(minutesByDate) else { return }
        defaults.set(data, forKey: usageDateKey)
        defaults.set(Date().timeIntervalSince1970, forKey: usageWrittenAtKey)
    }
}
#endif
