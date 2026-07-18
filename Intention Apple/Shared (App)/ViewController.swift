//
//  ViewController.swift
//  Shared (App)
//
//  Created by Adam on 22/06/2026.
//

import WebKit

#if os(iOS)
import UIKit
typealias PlatformViewController = UIViewController
#elseif os(macOS)
import Cocoa
import SafariServices
typealias PlatformViewController = NSViewController
#endif

let extensionBundleIdentifier = "uk.co.maybeitssoftware.intention.Extension"

class ViewController: PlatformViewController, WKNavigationDelegate, WKScriptMessageHandler {

    @IBOutlet var webView: WKWebView!

#if os(iOS)
    // How stale the extension's native-messaging heartbeat (see
    // SafariWebExtensionHandler.swift's pullConfig handling) can be before we
    // treat the Safari Web Extension as "not enabled" and show the banner.
    private let extensionHeartbeatFreshnessWindow: TimeInterval = 5 * 60

    private lazy var extensionBanner: UIView = makeExtensionBanner()
#endif

    override func viewDidLoad() {
        super.viewDidLoad()

        self.webView.navigationDelegate = self

#if os(iOS)
        self.webView.scrollView.isScrollEnabled = true
        // Main.storyboard doesn't constrain the webview to the view's bounds
        // (only a stale design-time frame) — pin it explicitly so options.html
        // actually gets a real, correctly-sized viewport on every device.
        self.webView.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            self.webView.topAnchor.constraint(equalTo: view.topAnchor),
            self.webView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            self.webView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            self.webView.bottomAnchor.constraint(equalTo: view.bottomAnchor)
        ])
        setUpIOSBridge()
        BackgroundJSHost.shared.start()
        loadOptionsPage()
        setUpExtensionBanner()
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(appDidBecomeActive),
            name: UIApplication.didBecomeActiveNotification,
            object: nil
        )
#elseif os(macOS)
        self.webView.configuration.userContentController.add(self, name: "controller")
        self.webView.loadFileURL(Bundle.main.url(forResource: "Main", withExtension: "html")!, allowingReadAccessTo: Bundle.main.resourceURL!)
#endif
    }

#if os(iOS)
    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        updateExtensionBanner()
    }

    @objc private func appDidBecomeActive() {
        updateExtensionBanner()
        // Backup for the DeviceActivityMonitor extension: passes shorter than
        // DeviceActivity's ~15-minute schedule floor are re-shielded here.
#if canImport(FamilyControls)
        if #available(iOS 16.0, *) {
            AppBlockingManager.shared.reapplyIfPassExpired()
        }
#endif
    }

    deinit {
        NotificationCenter.default.removeObserver(self)
    }
#endif

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
#if os(macOS)
        webView.evaluateJavaScript("show('mac')")

        SFSafariExtensionManager.getStateOfSafariExtension(withIdentifier: extensionBundleIdentifier) { (state, error) in
            guard let state = state, error == nil else {
                // Insert code to inform the user that something went wrong.
                return
            }

            DispatchQueue.main.async {
                if #available(macOS 13, *) {
                    webView.evaluateJavaScript("show('mac', \(state.isEnabled), true)")
                } else {
                    webView.evaluateJavaScript("show('mac', \(state.isEnabled), false)")
                }
            }
        }
#endif
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
#if os(iOS)
        guard message.name == "intentionNative" else { return }
        handleBridgeMessage(message.body)
#elseif os(macOS)
        guard message.name == "controller" else { return }
        if (message.body as! String != "open-preferences") {
            return
        }

        SFSafariApplication.showPreferencesForExtension(withIdentifier: extensionBundleIdentifier) { error in
            guard error == nil else {
                // Insert code to inform the user that something went wrong.
                return
            }

            DispatchQueue.main.async {
                NSApp.terminate(self)
            }
        }
#endif
    }

#if os(iOS)
    // MARK: - Options WebView + native bridge

    private func setUpIOSBridge() {
        let contentController = webView.configuration.userContentController
        contentController.add(self, name: "intentionNative")

        if let bridgeURL = Bundle.main.url(forResource: "ios-bridge", withExtension: "js"),
           let source = try? String(contentsOf: bridgeURL, encoding: .utf8) {
            let script = WKUserScript(source: source, injectionTime: .atDocumentStart, forMainFrameOnly: true)
            contentController.addUserScript(script)
        } else {
            assertionFailure("ios-bridge.js not found in app bundle")
        }
    }

    private func loadOptionsPage() {
        guard let url = Bundle.main.url(forResource: "options", withExtension: "html") else {
            assertionFailure("options.html not found in app bundle")
            return
        }
        webView.loadFileURL(url, allowingReadAccessTo: url.deletingLastPathComponent())
    }

    private func handleBridgeMessage(_ body: Any) {
        guard let dict = body as? [String: Any], let type = dict["type"] as? String else { return }
        switch type {
        case "sendMessage":
            let message = dict["message"] as? [String: Any] ?? [:]
            let callbackId = dict["callbackId"] as? String ?? ""
            BackgroundJSHost.shared.sendMessage(message) { [weak self] response in
                self?.invokeBridgeCallback(callbackId, result: response)
            }
        case "screenTime":
            let action = dict["action"] as? String ?? ""
            let callbackId = dict["callbackId"] as? String ?? ""
            handleScreenTimeMessage(action: action, dict: dict, callbackId: callbackId)
        default:
            break
        }
    }

    // MARK: - Screen Time app blocking bridge
    //
    // The options page drives native app blocking through these messages.
    // The FamilyActivitySelection is opaque and lives in the App Group
    // (AppBlockingManager), never in the web config.

    private func handleScreenTimeMessage(action: String, dict: [String: Any], callbackId: String) {
#if canImport(FamilyControls)
        guard #available(iOS 16.0, *) else {
            invokeBridgeCallback(callbackId, result: ["available": false])
            return
        }
        let manager = AppBlockingManager.shared
        switch action {
        case "status":
            invokeBridgeCallback(callbackId, result: [
                "available": true,
                "authorized": manager.isAuthorized,
                "selectionCount": manager.selectionCount,
                "passEndsAt": manager.passEndsAt.map { $0.timeIntervalSince1970 * 1000 } as Any
            ])
        case "authorize":
            Task { @MainActor in
                let ok = await manager.requestAuthorization()
                self.invokeBridgeCallback(callbackId, result: ["authorized": ok])
            }
        case "pickApps":
            manager.presentPicker(from: self) { [weak self] count in
                self?.invokeBridgeCallback(callbackId, result: ["selectionCount": count])
            }
        case "grantPass":
            let minutes = dict["minutes"] as? Int ?? Int(dict["minutes"] as? Double ?? 0)
            manager.grantPass(minutes: minutes)
            invokeBridgeCallback(callbackId, result: ["ok": true])
        case "clear":
            manager.clearAllBlocking()
            invokeBridgeCallback(callbackId, result: ["ok": true, "selectionCount": 0])
        case "getAppUsageReport":
            let days = (dict["days"] as? Int) ?? Int(dict["days"] as? Double ?? 30)
            manager.requestUsageReport(from: self, days: days > 0 ? days : 30) { [weak self] minutesByDate in
                self?.invokeBridgeCallback(callbackId, result: ["minutesByDate": minutesByDate])
            }
        default:
            invokeBridgeCallback(callbackId, result: ["error": "unknown screenTime action: \(action)"])
        }
#else
        invokeBridgeCallback(callbackId, result: ["available": false])
#endif
    }

    private func invokeBridgeCallback(_ callbackId: String, result: Any?) {
        guard !callbackId.isEmpty, let resultB64 = JSBridgeCodec.encode(result) else { return }
        webView.evaluateJavaScript(
            "window.IntentionCallbacks.invoke('\(callbackId)', atob('\(resultB64)'))",
            completionHandler: nil
        )
    }

    // MARK: - Extension enablement banner
    //
    // There's no iOS API to directly query whether the user has enabled the
    // Safari Web Extension (SFSafariExtensionManager.getStateOfSafariExtension
    // above is macOS-only). Instead we use a heartbeat: the extension's native
    // handler (SafariWebExtensionHandler.swift) stamps a timestamp in the App
    // Group every time Safari actually invokes it, piggybacking on the
    // pullConfig native-messaging sync. If that heartbeat is stale (or has
    // never happened), we show a banner prompting the user to enable it.

    private func makeExtensionBanner() -> UIView {
        let container = UIView()
        container.translatesAutoresizingMaskIntoConstraints = false
        container.backgroundColor = UIColor(red: 0.12, green: 0.14, blue: 0.18, alpha: 1.0)
        container.layer.cornerRadius = 10
        container.isHidden = true

        let label = UILabel()
        label.translatesAutoresizingMaskIntoConstraints = false
        label.text = "Intention needs the Safari Extension turned on to block sites. Enable it in Settings \u{2192} Apps \u{2192} Safari \u{2192} Extensions."
        label.textColor = UIColor(red: 0.91, green: 0.91, blue: 0.92, alpha: 1.0)
        label.numberOfLines = 0
        label.font = .systemFont(ofSize: 13)

        let button = UIButton(type: .system)
        button.translatesAutoresizingMaskIntoConstraints = false
        button.setTitle("Open Settings", for: .normal)
        button.setTitleColor(UIColor(red: 0.06, green: 0.07, blue: 0.09, alpha: 1.0), for: .normal)
        button.backgroundColor = UIColor(red: 0.91, green: 0.91, blue: 0.92, alpha: 1.0)
        button.layer.cornerRadius = 6
        button.titleLabel?.font = .boldSystemFont(ofSize: 13)
        button.contentEdgeInsets = UIEdgeInsets(top: 6, left: 10, bottom: 6, right: 10)
        button.addTarget(self, action: #selector(openSettings), for: .touchUpInside)

        let stack = UIStackView(arrangedSubviews: [label, button])
        stack.translatesAutoresizingMaskIntoConstraints = false
        stack.axis = .vertical
        stack.spacing = 10
        stack.alignment = .leading

        container.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.topAnchor.constraint(equalTo: container.topAnchor, constant: 12),
            stack.bottomAnchor.constraint(equalTo: container.bottomAnchor, constant: -12),
            stack.leadingAnchor.constraint(equalTo: container.leadingAnchor, constant: 14),
            stack.trailingAnchor.constraint(equalTo: container.trailingAnchor, constant: -14)
        ])

        return container
    }

    private func setUpExtensionBanner() {
        view.addSubview(extensionBanner)
        NSLayoutConstraint.activate([
            extensionBanner.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 8),
            extensionBanner.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor, constant: 12),
            extensionBanner.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor, constant: -12)
        ])
    }

    @objc private func updateExtensionBanner() {
        let seenAt = AppGroupStorage.extensionLastSeenAt()
        let isFresh = seenAt.map { Date().timeIntervalSince($0) < extensionHeartbeatFreshnessWindow } ?? false
        extensionBanner.isHidden = isFresh
    }

    @objc private func openSettings() {
        // Opens this app's own Settings page — iOS has no direct deep link
        // into Settings > Apps > Safari > Extensions, hence the banner copy
        // spelling out where to navigate from there.
        guard let url = URL(string: UIApplication.openSettingsURLString) else { return }
        UIApplication.shared.open(url)
    }
#endif

}
