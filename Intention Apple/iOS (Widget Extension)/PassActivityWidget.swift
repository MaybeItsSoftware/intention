//
//  PassActivityWidget.swift
//  Intention Widget Extension
//
//  Draws the pass Live Activity on the Lock Screen and in the Dynamic Island.
//  Target membership: this file + PassActivityAttributes.swift (which the iOS
//  App target also compiles — ActivityKit matches a running activity to this
//  widget through that shared type).
//
//  Nothing here runs on a schedule. The clock is
//  Text(timerInterval:countsDown:), which SwiftUI renders from a date range
//  and the system keeps ticking; the app is suspended for almost the whole
//  pass and never sends an update. context.isStale — flipped by the staleDate
//  set when the activity started — is the only state change there is, and it
//  says "the pass ran out".
//
//  This is the iOS half of the desktop status badge (renderStatusBadge() in
//  shared/content.js): elapsed time, the granted length beside it, and the
//  purpose the user gave the coach.
//

import ActivityKit
import SwiftUI
import WidgetKit

@main
struct IntentionWidgetBundle: WidgetBundle {
    var body: some Widget {
        PassLiveActivityWidget()
    }
}

struct PassLiveActivityWidget: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: PassActivityAttributes.self) { context in
            PassLockScreenView(context: context)
                .padding(.horizontal, 16)
                .padding(.vertical, 14)
                .activityBackgroundTint(PassPalette.surface)
                .activitySystemActionForegroundColor(PassPalette.text)
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    Text(context.isStale ? "PASS ENDED" : "INTENTION")
                        .microLabel()
                }
                DynamicIslandExpandedRegion(.trailing) {
                    PassClock(context: context, size: 19)
                        .frame(maxWidth: 78, alignment: .trailing)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    // The island's expanded area is short, so the purpose gets
                    // the whole bottom row to itself rather than competing with
                    // the clock for the trailing region.
                    PassPurposeLine(context: context)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.top, 2)
                }
            } compactLeading: {
                Image(systemName: "hourglass")
                    .foregroundStyle(context.isStale ? PassPalette.muted : PassPalette.accent)
            } compactTrailing: {
                // The compact trailing slot is barely wider than the digits it
                // holds, so the clock goes in alone and capped — an overflowing
                // view here is silently clipped, not wrapped.
                PassClock(context: context, size: 13, showsBoundary: false)
                    .frame(maxWidth: 44)
            } minimal: {
                Image(systemName: "hourglass")
                    .foregroundStyle(context.isStale ? PassPalette.muted : PassPalette.accent)
            }
            .keylineTint(PassPalette.accent)
        }
    }
}

// MARK: - Lock Screen

private struct PassLockScreenView: View {
    let context: ActivityViewContext<PassActivityAttributes>

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(context.isStale ? "PASS ENDED" : "PASS RUNNING")
                .microLabel()

            PassClock(context: context, size: 34)

            PassPurposeLine(context: context)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

// MARK: - Pieces

// The loud element: elapsed time, counting up from the start of the pass, with
// the granted length beside it — "04:12 / 10:00". Counting up rather than down
// matches the desktop badge, where the boundary is the useful number and the
// elapsed figure is the one that answers "how long have I been here?".
private struct PassClock: View {
    let context: ActivityViewContext<PassActivityAttributes>
    let size: CGFloat
    var showsBoundary: Bool = true

    private var isFinished: Bool { context.isStale }

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 5) {
            // Clamped by the system once `now` passes the end of the range, so
            // an expired pass reads as the full granted length rather than
            // running away past it.
            Text(
                timerInterval: context.state.startedAt...context.state.endsAt,
                countsDown: false
            )
            .font(.system(size: size, weight: .semibold, design: .monospaced))
            .monospacedDigit()
            .foregroundStyle(isFinished ? PassPalette.muted : PassPalette.accent)
            // Live-updating timer text has no intrinsic width the layout can
            // trust, so give it one; without this the row jitters as digits
            // change and the boundary beside it walks left and right.
            .frame(maxWidth: size * 3.4, alignment: .leading)

            if showsBoundary {
                Text(boundaryText)
                    .font(.system(size: max(11, size * 0.42), weight: .regular, design: .monospaced))
                    .foregroundStyle(PassPalette.muted)
            }
        }
    }

    private var boundaryText: String {
        String(format: "/ %02d:00", context.state.grantedMinutes)
    }
}

// The quiet half: what the user said they were going to do, in their own words.
private struct PassPurposeLine: View {
    let context: ActivityViewContext<PassActivityAttributes>

    var body: some View {
        // A pass granted without a stated purpose (the no-AI simple-mode lane
        // can produce one) drops the line entirely rather than showing an empty
        // pair of quotes.
        if !context.attributes.purpose.isEmpty {
            Text("\u{201C}\(context.attributes.purpose)\u{201D}")
                .font(.system(size: 13))
                .foregroundStyle(PassPalette.muted)
                .lineLimit(2)
        }
    }
}

// The house micro-label: 10px, bold, uppercase, wide tracking, muted. Hierarchy
// comes from surface and position, not from label size.
private struct MicroLabel: ViewModifier {
    func body(content: Content) -> some View {
        content
            .font(.system(size: 10, weight: .bold))
            .tracking(1.5)
            .foregroundStyle(PassPalette.muted)
    }
}

private extension View {
    func microLabel() -> some View { modifier(MicroLabel()) }
}

// The Lock Screen and the Dynamic Island are always dark and are not ours to
// theme — the same reasoning the design language applies to media surfaces — so
// these are pinned to the dark-mode tokens instead of flipping with the system
// appearance. Flat and bordered: the system's own container is the hairline,
// so there is no shadow and no gradient anywhere in here.
private enum PassPalette {
    /// Raised surface, dark mode.
    static let surface = Color(red: 0x25 / 255, green: 0x23 / 255, blue: 0x2f / 255)
    /// Body text, dark mode.
    static let text = Color(red: 0xf5 / 255, green: 0xf4 / 255, blue: 0xf7 / 255)
    /// Muted text, dark mode.
    static let muted = Color(red: 0xb6 / 255, green: 0xb3 / 255, blue: 0xbf / 255)
    /// Azure — the one accent, carrying the only thing on this card that moves.
    static let accent = Color(red: 0x00 / 255, green: 0x7f / 255, blue: 0xff / 255)
}
