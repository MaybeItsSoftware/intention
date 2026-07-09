//
//  AppGroupStorage.swift
//  Shared (iOS)
//
//  Created by Adam on 09/07/2026.
//

import Foundation

// Shared JSON key-value store backed by the App Group's UserDefaults suite —
// the single source of truth reachable from both the app's hidden background
// WKWebView (BackgroundJSHost, full read/write access, mirrors
// chrome.storage.local exactly) and the Safari Web Extension's native handler
// (SafariWebExtensionHandler, config-keys-only access via pushConfig/
// pullConfig so it never clobbers app-local-only or extension-local-only
// fields like chatHistories/dailyStats with each other's data).
enum AppGroupStorage {
    private static let storageKey = "intentionSharedStorage"

    private static var defaults: UserDefaults? {
        UserDefaults(suiteName: AppGroupConfig.identifier)
    }

    private static func readAll() -> [String: Any] {
        guard let defaults, let data = defaults.data(forKey: storageKey) else { return [:] }
        return (try? JSONSerialization.jsonObject(with: data, options: [])) as? [String: Any] ?? [:]
    }

    // Mirrors chrome.storage.local.get: returns only the requested keys that
    // are present, or the entire store when `keys` is empty.
    static func get(_ keys: [String]) -> [String: Any] {
        let all = readAll()
        guard !keys.isEmpty else { return all }
        var result: [String: Any] = [:]
        for key in keys where all[key] != nil {
            result[key] = all[key]
        }
        return result
    }

    // Mirrors chrome.storage.local.set: shallow-merges `items` into the store.
    static func set(_ items: [String: Any]) {
        guard let defaults, !items.isEmpty else { return }
        var all = readAll()
        for (key, value) in items {
            all[key] = value
        }
        guard let data = try? JSONSerialization.data(withJSONObject: all, options: []) else { return }
        defaults.set(data, forKey: storageKey)
    }

    // Extension-facing: only the keys in AppGroupConfig.configKeys.
    static func configSubset() -> [String: Any] {
        get(AppGroupConfig.configKeys)
    }

    // Extension-facing: merges only config keys from `partial`, ignoring
    // anything else so app-local-only fields can never be clobbered this way.
    static func mergeConfig(_ partial: [String: Any]) {
        var filtered: [String: Any] = [:]
        for (key, value) in partial where AppGroupConfig.configKeys.contains(key) {
            filtered[key] = value
        }
        guard !filtered.isEmpty else { return }
        set(filtered)
    }

    static func stampExtensionHeartbeat() {
        defaults?.set(Date().timeIntervalSince1970, forKey: AppGroupConfig.extensionLastSeenAtKey)
    }

    static func extensionLastSeenAt() -> Date? {
        guard let defaults else { return nil }
        let interval = defaults.double(forKey: AppGroupConfig.extensionLastSeenAtKey)
        return interval > 0 ? Date(timeIntervalSince1970: interval) : nil
    }
}
