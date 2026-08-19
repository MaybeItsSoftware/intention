//
//  PassActivityAttributes.swift
//  Shared (iOS)
//
//  The shape of the Live Activity that runs for the length of a coach-granted
//  pass — the iOS answer to the desktop extension's status badge
//  (renderStatusBadge() in shared/content.js), which shows elapsed time, the
//  granted length and the purpose the user gave the coach.
//
//  Target membership: the iOS App AND the Widget Extension. ActivityKit pairs
//  a running activity with the widget that draws it by matching this type, so
//  both processes have to compile the very same declaration — one file in two
//  targets, the way every other cross-target file in this project is shared
//  (AppGroupConfig.swift, AppGroupStorage.swift).
//

#if os(iOS)
#if canImport(ActivityKit)
import ActivityKit
import Foundation

@available(iOS 16.2, *)
struct PassActivityAttributes: ActivityAttributes {
    // Everything that can move while the pass is live. A check-in that extends
    // a pass pushes `endsAt` out, so these are content state rather than fixed
    // attributes even though nothing extends a pass on iOS today.
    struct ContentState: Codable, Hashable {
        var startedAt: Date
        var endsAt: Date

        // The granted length, for the "/ 10:00" boundary next to the running
        // clock. Derived rather than stored so it can never disagree with the
        // interval the timer is actually counting across.
        var grantedMinutes: Int {
            max(0, Int((endsAt.timeIntervalSince(startedAt) / 60).rounded()))
        }
    }

    // What the user told the coach they were going to do. Fixed for the life
    // of the pass, and deliberately the quiet half of the layout — the timer
    // is the loud element.
    var purpose: String
}
#endif
#endif
