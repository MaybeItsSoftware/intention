//
//  BackgroundJSHost.swift
//  Shared (iOS)
//
//  Created by Adam on 09/07/2026.
//
//  Headless WKWebView running background.html (which in turn loads
//  providers.js, prompts.js, tracking.js, background.js), so the app can run
//  the same LLM/coach logic the Safari Web Extension runs — entirely inside
//  the app's own process. Mirrors Intention Android's BackgroundJsHelper.kt
//  (a hidden WebView loading background.html, proxied via a JS bridge).
//
//  All methods are main-thread only, matching WKWebView/WKScriptMessageHandler
//  requirements — there is no separate synchronization since every entry
//  point here is already dispatched onto (or guaranteed to run on) the main
//  thread.
//

import Foundation
import WebKit

final class BackgroundJSHost: NSObject {
    static let shared = BackgroundJSHost()

    private var webView: WKWebView?
    private var pendingCallbacks: [String: (Any?) -> Void] = [:]
    private var nextCallbackId = 1
    // background.html is loaded asynchronously, so window.triggerMessage does
    // not exist for the first moments of the app's life. Messages sent in that
    // window used to evaluate against an empty page and vanish (their callback
    // never firing); they queue here until the page is up instead.
    private var isReady = false
    private var pendingWork: [() -> Void] = []
    private var alarmTimers: [String: Timer] = [:]

    private override init() {
        super.init()
    }

    func start() {
        if Thread.isMainThread {
            setUpWebViewIfNeeded()
        } else {
            DispatchQueue.main.async { [weak self] in self?.setUpWebViewIfNeeded() }
        }
    }

    private func setUpWebViewIfNeeded() {
        guard webView == nil else { return }

        let contentController = WKUserContentController()
        contentController.add(self, name: "intentionNative")

        let configuration = WKWebViewConfiguration()
        configuration.userContentController = contentController

        let hostedWebView = WKWebView(frame: .zero, configuration: configuration)
        hostedWebView.navigationDelegate = self
        webView = hostedWebView

        guard let url = Bundle.main.url(forResource: "background", withExtension: "html") else {
            assertionFailure("background.html not found in app bundle")
            return
        }
        hostedWebView.loadFileURL(url, allowingReadAccessTo: url.deletingLastPathComponent())
    }

    // Sends `message` to background.js's chrome.runtime.onMessage listeners,
    // mirroring chrome.runtime.sendMessage(message, callback). `completion` is
    // always called, with `nil` if the host was never started or encoding fails.
    func sendMessage(_ message: [String: Any], completion: @escaping (Any?) -> Void) {
        runOnMain { [weak self] in
            guard let self, self.webView != nil else {
                completion(nil)
                return
            }
            let work: () -> Void = { [weak self] in
                self?.deliver(message, completion: completion)
            }
            if self.isReady {
                work()
            } else {
                self.pendingWork.append(work)
            }
        }
    }

    private func deliver(_ message: [String: Any], completion: @escaping (Any?) -> Void) {
        guard let hostedWebView = webView else {
            completion(nil)
            return
        }
        let callbackId = "native_cb_\(nextCallbackId)"
        nextCallbackId += 1
        pendingCallbacks[callbackId] = completion

        guard
            let messageLiteral = JSBridgeCodec.encodedLiteral(message),
            let senderLiteral = JSBridgeCodec.encodedLiteral([String: Any]())
        else {
            pendingCallbacks.removeValue(forKey: callbackId)
            completion(nil)
            return
        }

        let script = "window.triggerMessage(\(messageLiteral), \(senderLiteral), \(JSBridgeCodec.jsLiteral(callbackId)))"
        hostedWebView.evaluateJavaScript(script) { _, error in
            if let error { NSLog("[Intention] triggerMessage failed: %@", String(describing: error)) }
        }
    }

    // MARK: - Catch-up
    //
    // Everything time-based here has to be caught up rather than relied upon:
    // in-process timers stop the moment iOS suspends the app, and a device
    // restart takes them with it. Storage keeps the timestamps, so the work is
    // always "what came due while we weren't running?" — called on background
    // page ready and again on every foreground.

    /// Delivers alarms that came due while nothing was running, then asks
    /// background.js to reconcile session bookkeeping. Idempotent; a no-op until
    /// the background page is up, which runs it itself once ready.
    func catchUpOnDueWork() {
        runOnMain { [weak self] in
            guard let self, self.isReady else { return }
            self.fireDueAlarmsAndScheduleRest()
            // Banks any pass that ran out while the app was closed and re-arms
            // the check-ins for those still running — see reconcileSessions() in
            // background.js.
            self.sendMessage(["action": "reconcileSessions"]) { _ in }
        }
    }

    private func fireDueAlarmsAndScheduleRest() {
        let now = Date().timeIntervalSince1970
        for (name, fireAt) in AlarmStore.all() {
            if fireAt <= now {
                deliverAlarm(name)
            } else {
                scheduleTimer(for: name, fireAt: fireAt)
            }
        }
    }

    // MARK: - chrome.alarms

    // Mirrors chrome.alarms.create: either an absolute `when` (epoch ms) or a
    // relative `delayInMinutes`. Re-creating an existing name replaces it.
    fileprivate func createAlarm(name: String, info: [String: Any]) {
        guard !name.isEmpty else { return }
        let fireAt: TimeInterval
        if let whenMs = Self.numeric(info["when"]), whenMs > 0 {
            fireAt = whenMs / 1000
        } else if let delayMinutes = Self.numeric(info["delayInMinutes"]), delayMinutes > 0 {
            fireAt = Date().timeIntervalSince1970 + (delayMinutes * 60)
        } else {
            return
        }
        AlarmStore.set(name, fireAt: fireAt)
        scheduleTimer(for: name, fireAt: fireAt)
    }

    fileprivate func clearAlarm(_ name: String) {
        AlarmStore.remove(name)
        alarmTimers.removeValue(forKey: name)?.invalidate()
    }

    private func scheduleTimer(for name: String, fireAt: TimeInterval) {
        alarmTimers.removeValue(forKey: name)?.invalidate()
        let delay = max(0, fireAt - Date().timeIntervalSince1970)
        alarmTimers[name] = Timer.scheduledTimer(withTimeInterval: delay, repeats: false) { [weak self] _ in
            self?.deliverAlarm(name)
        }
    }

    // Fires the chrome.alarms.onAlarm listener background.js registered (exposed
    // as window.alarmListener by background.html). One-shot, matching how the
    // shared code uses alarms, so the record is dropped as it fires.
    private func deliverAlarm(_ name: String) {
        AlarmStore.remove(name)
        alarmTimers.removeValue(forKey: name)?.invalidate()
        guard let hostedWebView = webView else { return }
        hostedWebView.evaluateJavaScript(
            "window.alarmListener && window.alarmListener({ name: \(JSBridgeCodec.jsLiteral(name)) })"
        ) { _, error in
            if let error { NSLog("[Intention] alarmListener failed: %@", String(describing: error)) }
        }
    }

    private static func numeric(_ value: Any?) -> Double? {
        if let number = value as? NSNumber { return number.doubleValue }
        if let double = value as? Double { return double }
        if let int = value as? Int { return Double(int) }
        return nil
    }

    private func runOnMain(_ work: @escaping () -> Void) {
        if Thread.isMainThread {
            work()
        } else {
            DispatchQueue.main.async(execute: work)
        }
    }

    private func invokeJSCallback(_ callbackId: String, result: Any?) {
        guard !callbackId.isEmpty, let hostedWebView = webView,
              let resultLiteral = JSBridgeCodec.encodedLiteral(result) else { return }
        let script = "window.IntentionCallbacks.invoke(\(JSBridgeCodec.jsLiteral(callbackId)), \(resultLiteral))"
        hostedWebView.evaluateJavaScript(script) { _, error in
            if let error { NSLog("[Intention] callback invoke failed: %@", String(describing: error)) }
        }
    }
}

extension BackgroundJSHost: WKScriptMessageHandler {
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any], let type = body["type"] as? String else { return }
        let callbackId = body["callbackId"] as? String ?? ""

        switch type {
        case "getStorage":
            let keys = body["keys"] as? [String] ?? []
            invokeJSCallback(callbackId, result: AppGroupStorage.get(keys))

        case "setStorage":
            let items = body["items"] as? [String: Any] ?? [:]
            AppGroupStorage.set(items)
            invokeJSCallback(callbackId, result: [String: Any]())

        case "messageResponse":
            let callback = pendingCallbacks.removeValue(forKey: callbackId)
            callback?(body["response"])

        case "createAlarm":
            createAlarm(name: body["name"] as? String ?? "", info: body["info"] as? [String: Any] ?? [:])

        case "clearAlarm":
            if let name = body["name"] as? String { clearAlarm(name) }

        default:
            break
        }
    }
}

extension BackgroundJSHost: WKNavigationDelegate {
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard !isReady else { return }
        isReady = true
        let queued = pendingWork
        pendingWork = []
        queued.forEach { $0() }
        catchUpOnDueWork()
    }
}

// Pending alarm fire times, in the App Group so they outlive the app being
// closed or the device restarting. Only this host reads them — the Safari Web
// Extension has real browser alarms and never comes through here.
private enum AlarmStore {
    private static let storageKey = "intentionAlarms"

    private static var defaults: UserDefaults? {
        UserDefaults(suiteName: AppGroupConfig.identifier)
    }

    // [alarm name: fire time as epoch seconds]
    static func all() -> [String: TimeInterval] {
        guard let raw = defaults?.dictionary(forKey: storageKey) else { return [:] }
        var result: [String: TimeInterval] = [:]
        for (name, value) in raw {
            if let number = value as? NSNumber { result[name] = number.doubleValue }
        }
        return result
    }

    static func set(_ name: String, fireAt: TimeInterval) {
        guard let defaults else { return }
        var alarms = all()
        alarms[name] = fireAt
        defaults.set(alarms, forKey: storageKey)
    }

    static func remove(_ name: String) {
        guard let defaults else { return }
        var alarms = all()
        guard alarms.removeValue(forKey: name) != nil else { return }
        defaults.set(alarms, forKey: storageKey)
    }
}
