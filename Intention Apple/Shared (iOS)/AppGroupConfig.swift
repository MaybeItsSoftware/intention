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
        "setupComplete"
    ]

    static let extensionLastSeenAtKey = "extensionLastSeenAt"
}
