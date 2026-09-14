//
//  AppGroupConfig.swift
//  Shared (iOS)
//
//  Created by Adam on 09/07/2026.
//

import Foundation

// Identifiers shared between the iOS App and iOS Extension targets, both of
// which need the "App Groups" capability enabled in Signing & Capabilities
// with this same group added (see iOS (App).entitlements / iOS
// (Extension).entitlements).
enum AppGroupConfig {
    // TODO: replace with the real App Group identifier once the Apple
    // Developer Team ID is known (Signing & Capabilities -> App Groups on
    // both the iOS App and iOS Extension targets). Must match the group
    // string in both .entitlements files.
    static let identifier = "group.uk.co.maybeitssoftware.intention"

    // The subset of extension config keys that are synced between the native
    // app and the Safari Web Extension via the App Group. Mirrors CONFIG_KEYS
    // in tracking.js — keep the two lists in sync.
    static let configKeys: [String] = [
        "provider", "apiKey", "model", "userContext", "contextProjects",
        "contextReasons", "coachInstructions", "blockedDomains", "domainLimits",
        "blockedApps", "appLimits", "appLabels",
        // The In-App Purchase entitlement. StoreKit only runs in the app, so
        // this is how a subscription bought there reaches the Safari extension.
        "entitlement",
        "setupComplete",
        // Kept in lockstep with tracking.js. These are declarative blocking
        // configuration, never usage/activity data; a list restored in the
        // app must be visible to Safari too.
        "serviceReasons", "pendingChanges",
        "leaveDelayMinutes"
    ]

    static let extensionLastSeenAtKey = "extensionLastSeenAt"

    // Website activity pushed by each Safari extension install (tracking.js's
    // pushActivityToNative). Its own UserDefaults key rather than a field in
    // the shared JSON blob: the extension writes it every minute of browsing,
    // and a read-modify-write of the whole blob from another process would
    // race the app's own writes to chat history and settings. Surfaced to the
    // app's JS under the same name, read-only.
    static let webActivityKey = "webActivity"
    // A source that hasn't pushed in this long is an old profile or a Safari
    // that's been removed; its days are older than anything shown anyway.
    static let webActivityStaleAfter: TimeInterval = 35 * 24 * 60 * 60
}
