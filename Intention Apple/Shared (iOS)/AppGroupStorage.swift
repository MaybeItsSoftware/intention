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

    // Every read-modify-write of the blob runs under this. Two processes write
    // it — the app (BackgroundJSHost and the options page's setStorage) and the
    // Safari extension's native handler (pushConfig) — and each used to read
    // the whole blob, change its keys and write the whole blob back, so
    // whichever wrote second silently undid the other's change: a setting
    // saved in Safari lost to a chat-history write in the app, or the reverse.
    //
    // flock() on a file in the App Group container, because it is a lock both
    // processes can see and the kernel drops it if the holder dies, so a crash
    // mid-write can't wedge the other side. The storage format is untouched.
    // If the lock file can't be opened (no App Group container — a
    // misconfigured build) this runs unlocked, exactly as before.
    private static func withStorageLock<T>(_ body: () -> T) -> T {
        guard let url = FileManager.default
            .containerURL(forSecurityApplicationGroupIdentifier: AppGroupConfig.identifier)?
            .appendingPathComponent("intentionSharedStorage.lock") else { return body() }
        let fd = open(url.path, O_RDWR | O_CREAT | O_CLOEXEC, 0o644)
        guard fd >= 0 else { return body() }
        defer { close(fd) }
        var locked = flock(fd, LOCK_EX) == 0
        while !locked && errno == EINTR {
            locked = flock(fd, LOCK_EX) == 0
        }
        defer { if locked { flock(fd, LOCK_UN) } }
        // Pick up whatever the other process wrote while we waited; the
        // in-process cache can otherwise lag behind it.
        defaults?.synchronize()
        let result = body()
        defaults?.synchronize()
        return result
    }

    private static func readAll() -> [String: Any] {
        guard let defaults, let data = defaults.data(forKey: storageKey) else { return [:] }
        return (try? JSONSerialization.jsonObject(with: data, options: [])) as? [String: Any] ?? [:]
    }

    // Mirrors chrome.storage.local.get: returns only the requested keys that
    // are present, or the entire store when `keys` is empty. `webActivity` is
    // overlaid from its own key — see AppGroupConfig.webActivityKey.
    static func get(_ keys: [String]) -> [String: Any] {
        var all = readAll()
        if keys.isEmpty || keys.contains(AppGroupConfig.webActivityKey) {
            let activity = readWebActivity()
            if activity.isEmpty {
                all.removeValue(forKey: AppGroupConfig.webActivityKey)
            } else {
                all[AppGroupConfig.webActivityKey] = activity
            }
        }
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
        withStorageLock {
            var all = readAll()
            // The extension is the only writer of webActivity; an app-side write
            // (a data import, a set of everything it just read) must not land in
            // the blob, where it would shadow nothing and go stale.
            for (key, value) in items where key != AppGroupConfig.webActivityKey {
                all[key] = value
            }
            guard let data = try? JSONSerialization.data(withJSONObject: all, options: []) else { return }
            defaults.set(data, forKey: storageKey)
        }
    }

    // Mirrors chrome.storage.local.remove: removes keys from the store.
    static func remove(_ keys: [String]) {
        guard let defaults, !keys.isEmpty else { return }
        withStorageLock {
            var all = readAll()
            var changed = false
            for key in keys {
                if all.removeValue(forKey: key) != nil {
                    changed = true
                }
            }
            guard changed, let data = try? JSONSerialization.data(withJSONObject: all, options: []) else { return }
            defaults.set(data, forKey: storageKey)
        }
    }

    // Mirrors chrome.storage.local.clear: clears all items, pushed website
    // activity included. Safari will push its own days again next time it runs.
    static func clear() {
        guard let defaults else { return }
        withStorageLock {
            defaults.removeObject(forKey: AppGroupConfig.webActivityKey)
            guard let data = try? JSONSerialization.data(withJSONObject: [String: Any](), options: []) else { return }
            defaults.set(data, forKey: storageKey)
        }
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

    // Extension-facing: replaces this source's pushed days. `days` is
    // { "YYYY-MM-DD": { domain: { minutes, grants, negotiated, … } } }, numbers
    // only, built by tracking.js's activityForNative.
    static func mergeWebActivity(sourceId: String, days: [String: Any], startedAt: Double) {
        guard let defaults, !sourceId.isEmpty else { return }
        let now = Date().timeIntervalSince1970 * 1000
        // Locked too: each Safari profile pushes its own source into this one
        // key, and two pushes racing would drop one of them.
        withStorageLock {
            var sources = readWebActivity()
            var entry: [String: Any] = ["updatedAt": now, "days": days]
            if startedAt > 0 { entry["startedAt"] = startedAt }
            sources[sourceId] = entry
            let cutoff = now - AppGroupConfig.webActivityStaleAfter * 1000
            sources = sources.filter { _, value in
                let updatedAt = ((value as? [String: Any])?["updatedAt"] as? NSNumber)?.doubleValue ?? 0
                return updatedAt >= cutoff
            }
            guard JSONSerialization.isValidJSONObject(sources),
                  let data = try? JSONSerialization.data(withJSONObject: sources, options: []) else { return }
            defaults.set(data, forKey: AppGroupConfig.webActivityKey)
        }
    }

    private static func readWebActivity() -> [String: Any] {
        guard let defaults, let data = defaults.data(forKey: AppGroupConfig.webActivityKey) else { return [:] }
        return (try? JSONSerialization.jsonObject(with: data, options: [])) as? [String: Any] ?? [:]
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
