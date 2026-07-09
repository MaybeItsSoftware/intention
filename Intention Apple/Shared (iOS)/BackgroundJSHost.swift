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
        webView = hostedWebView

        guard let url = Bundle.main.url(forResource: "background", withExtension: "html") else {
            assertionFailure("background.html not found in app bundle")
            return
        }
        hostedWebView.loadFileURL(url, allowingReadAccessTo: url.deletingLastPathComponent())
    }

    // Sends `message` to background.js's chrome.runtime.onMessage listeners,
    // mirroring chrome.runtime.sendMessage(message, callback). `completion` is
    // always called, with `nil` if the host isn't ready or encoding fails.
    func sendMessage(_ message: [String: Any], completion: @escaping (Any?) -> Void) {
        runOnMain { [weak self] in
            guard let self, let hostedWebView = self.webView else {
                completion(nil)
                return
            }
            let callbackId = "native_cb_\(self.nextCallbackId)"
            self.nextCallbackId += 1
            self.pendingCallbacks[callbackId] = completion

            guard
                let messageB64 = JSBridgeCodec.encode(message),
                let senderB64 = JSBridgeCodec.encode([String: Any]())
            else {
                self.pendingCallbacks.removeValue(forKey: callbackId)
                completion(nil)
                return
            }

            let script = "window.triggerMessage(atob('\(messageB64)'), atob('\(senderB64)'), '\(callbackId)')"
            hostedWebView.evaluateJavaScript(script, completionHandler: nil)
        }
    }

    private func runOnMain(_ work: @escaping () -> Void) {
        if Thread.isMainThread {
            work()
        } else {
            DispatchQueue.main.async(execute: work)
        }
    }

    private func invokeJSCallback(_ callbackId: String, result: Any?) {
        guard !callbackId.isEmpty, let hostedWebView = webView, let resultB64 = JSBridgeCodec.encode(result) else { return }
        let script = "window.IntentionCallbacks.invoke('\(callbackId)', atob('\(resultB64)'))"
        hostedWebView.evaluateJavaScript(script, completionHandler: nil)
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

        default:
            break
        }
    }
}
