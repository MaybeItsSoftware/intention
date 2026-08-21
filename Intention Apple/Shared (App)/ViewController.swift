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
    // Generous on purpose: the heartbeat only stamps when Safari actually
    // runs the extension (a navigation, throttled to 30s), so a short window
    // shows the banner to everyone who simply hasn't browsed recently.
    private let extensionHeartbeatFreshnessWindow: TimeInterval = 24 * 60 * 60

    // Dismissal lasts for this app session; a stale heartbeat brings the
    // banner back on next launch.
    private var extensionBannerDismissed = false

    // Whether the options page has finished its setup wizard. Starts false so
    // a fresh install never flashes the banner over the wizard's own (fuller)
    // "turn on the Safari extension" step; the web layer reports the real
    // value as soon as it knows it, via the `extension` bridge.
    private var setupComplete = false

    // There is no public deep link into Safari's extensions settings page, so
    // both the banner and the wizard spell out the exact path — which moved in
    // iOS 18 — rather than offering a button that can only land somewhere
    // unrelated and make things more confusing.
    private var safariExtensionSettingsPath: String {
        if #available(iOS 18.0, *) {
            return "Settings \u{2192} Apps \u{2192} Safari \u{2192} Extensions"
        }
        return "Settings \u{2192} Safari \u{2192} Extensions"
    }

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
        // Listen for renewals / Ask-to-Buy approvals for as long as the app is
        // alive, or StoreKit never finishes those transactions.
        if #available(iOS 15.0, *) {
            Task { await IntentionStore.shared.start() }
        }
        loadOptionsPage()
        setUpExtensionBanner()
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(appDidBecomeActive),
            name: UIApplication.didBecomeActiveNotification,
            object: nil
        )
#elseif os(macOS)
        // Same story as iOS above: the storyboard's webview carries only a
        // design-time frame (translatesAutoresizingMaskIntoConstraints = NO
        // with no constraints), which went unnoticed while the window was a
        // fixed 425x325. Now that it resizes to fit the coaching-credit
        // section, the webview has to follow it or it stays its nib size and
        // leaves the rest of the window blank.
        self.webView.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            self.webView.topAnchor.constraint(equalTo: view.topAnchor),
            self.webView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            self.webView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            self.webView.bottomAnchor.constraint(equalTo: view.bottomAnchor)
        ])
        self.webView.configuration.userContentController.add(self, name: "controller")
        // Same bridge name the iOS options page uses, so Script.js can drive
        // the StoreKit purchase flow from the Mac app's own window — the Mac
        // App Store build must sell coaching credit through StoreKit too.
        self.webView.configuration.userContentController.add(self, name: "intentionNative")
        if #available(macOS 12.0, *) {
            Task { await IntentionStore.shared.start() }
        }
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
        // Coming back from Settings or Safari is exactly when the setup
        // wizard's "is the extension on yet?" answer changes, and a WKWebView
        // gets no dependable visibilitychange for an app switch — so tell the
        // page directly.
        webView.evaluateJavaScript(
            "window.dispatchEvent(new Event('intention-app-active'))",
            completionHandler: nil
        )
        // iOS stops the host's in-process timers as soon as the app leaves the
        // foreground, and a device restart takes them with it — so a granted pass
        // can have run out with nothing around to fire its check-in. Deliver
        // whatever came due and re-arm what's left.
        BackgroundJSHost.shared.catchUpOnDueWork()
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

    // options.html is loaded from the bundle and this web view has no chrome of
    // its own — no back button, no address bar. A tapped link would replace the
    // settings UI with a web page the user has no way back from, so anything
    // off-app is handed to the real browser instead. Only link taps: the page's
    // own loads and the bridge's navigations fall through untouched.
    func webView(_ webView: WKWebView,
                 decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard navigationAction.navigationType == .linkActivated,
              let url = navigationAction.request.url,
              let scheme = url.scheme?.lowercased(),
              scheme == "http" || scheme == "https" else {
            decisionHandler(.allow)
            return
        }
        decisionHandler(.cancel)
#if os(macOS)
        NSWorkspace.shared.open(url)
#else
        UIApplication.shared.open(url)
#endif
    }

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
        if message.name == "intentionNative" {
            guard let dict = message.body as? [String: Any],
                  dict["type"] as? String == "billing" else { return }
            handleBillingMessage(
                action: dict["action"] as? String ?? "",
                dict: dict,
                callbackId: dict["callbackId"] as? String ?? ""
            )
            return
        }
        guard message.name == "controller" else { return }
        guard let body = message.body as? String, body == "open-preferences" else {
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
        case "billing":
            let action = dict["action"] as? String ?? ""
            let callbackId = dict["callbackId"] as? String ?? ""
            handleBillingMessage(action: action, dict: dict, callbackId: callbackId)
        case "extension":
            let action = dict["action"] as? String ?? ""
            let callbackId = dict["callbackId"] as? String ?? ""
            handleExtensionMessage(action: action, dict: dict, callbackId: callbackId)
        default:
            break
        }
    }

    // MARK: - Safari extension enablement bridge
    //
    // Backs the setup wizard's "Turn on the Safari extension" step. Same
    // heartbeat the banner below reads — the difference is that the wizard can
    // explain the step in context, so while setup is unfinished the banner
    // stands down and lets it.

    private func handleExtensionMessage(action: String, dict: [String: Any], callbackId: String) {
        switch action {
        case "status":
            let seenAt = AppGroupStorage.extensionLastSeenAt()
            let isFresh = seenAt.map { Date().timeIntervalSince($0) < extensionHeartbeatFreshnessWindow } ?? false
            invokeBridgeCallback(callbackId, result: [
                "active": isFresh,
                "settingsPath": safariExtensionSettingsPath,
                "lastSeenAt": seenAt.map { $0.timeIntervalSince1970 * 1000 } as Any
            ])
        case "openSafari":
            openSafari()
            invokeBridgeCallback(callbackId, result: ["ok": true])
        case "openSettings":
            openSettings()
            invokeBridgeCallback(callbackId, result: ["ok": true])
        case "setSetupComplete":
            setupComplete = (dict["value"] as? Bool) ?? false
            updateExtensionBanner()
            invokeBridgeCallback(callbackId, result: ["ok": true])
        default:
            invokeBridgeCallback(callbackId, result: ["error": "unknown extension action: \(action)"])
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
                "authorizationStatus": manager.authorizationStatusString,
                "selectionCount": manager.selectionCount,
                "passEndsAt": manager.passEndsAt.map { $0.timeIntervalSince1970 * 1000 } as Any
            ])
        case "authorize":
            Task { @MainActor in
                let ok = await manager.requestAuthorization()
                self.invokeBridgeCallback(callbackId, result: [
                    "authorized": ok,
                    "authorizationStatus": manager.authorizationStatusString
                ])
            }
        case "pickApps":
            // Request authorization first if needed: presenting the
            // FamilyActivityPicker unauthorized renders an empty list or an
            // endless spinner, which looks like the picker is broken.
            Task { @MainActor in
                if !manager.isAuthorized {
                    _ = await manager.requestAuthorization()
                }
                guard manager.isAuthorized else {
                    self.invokeBridgeCallback(callbackId, result: [
                        "selectionCount": manager.selectionCount,
                        "authorized": false,
                        "authorizationStatus": manager.authorizationStatusString
                    ])
                    return
                }
                manager.presentPicker(from: self) { [weak self] count in
                    self?.invokeBridgeCallback(callbackId, result: [
                        "selectionCount": count,
                        "authorized": true,
                        "authorizationStatus": manager.authorizationStatusString
                    ])
                }
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
        label.text = "Intention's Safari extension isn't active yet, so blocked websites won't stop you.\n1. Go to \(safariExtensionSettingsPath) and turn on Intention Safari Extension.\n2. Open Safari and load any page once to activate it."
        label.textColor = UIColor(red: 0.91, green: 0.91, blue: 0.92, alpha: 1.0)
        label.numberOfLines = 0
        label.font = .systemFont(ofSize: 13)

        func filledButton(_ title: String, action: Selector) -> UIButton {
            var config = UIButton.Configuration.filled()
            var titleContainer = AttributeContainer()
            titleContainer.font = UIFont.boldSystemFont(ofSize: 13)
            config.attributedTitle = AttributedString(title, attributes: titleContainer)
            config.baseForegroundColor = UIColor(red: 0.06, green: 0.07, blue: 0.09, alpha: 1.0)
            config.baseBackgroundColor = UIColor(red: 0.91, green: 0.91, blue: 0.92, alpha: 1.0)
            config.contentInsets = NSDirectionalEdgeInsets(top: 6, leading: 10, bottom: 6, trailing: 10)
            config.background.cornerRadius = 6
            let button = UIButton(configuration: config, primaryAction: nil)
            button.translatesAutoresizingMaskIntoConstraints = false
            button.addTarget(self, action: action, for: .touchUpInside)
            return button
        }

        let safariButton = filledButton("Open Safari", action: #selector(openSafari))

        var dismissConfig = UIButton.Configuration.plain()
        var dismissTitleContainer = AttributeContainer()
        dismissTitleContainer.font = UIFont.boldSystemFont(ofSize: 13)
        dismissConfig.attributedTitle = AttributedString("Dismiss", attributes: dismissTitleContainer)
        dismissConfig.baseForegroundColor = UIColor(red: 0.63, green: 0.65, blue: 0.70, alpha: 1.0)
        dismissConfig.contentInsets = NSDirectionalEdgeInsets(top: 6, leading: 10, bottom: 6, trailing: 10)
        let dismissButton = UIButton(configuration: dismissConfig, primaryAction: nil)
        dismissButton.translatesAutoresizingMaskIntoConstraints = false
        dismissButton.addTarget(self, action: #selector(dismissExtensionBanner), for: .touchUpInside)

        let buttonsStack = UIStackView(arrangedSubviews: [safariButton, dismissButton])
        buttonsStack.translatesAutoresizingMaskIntoConstraints = false
        buttonsStack.axis = .horizontal
        buttonsStack.spacing = 10
        buttonsStack.alignment = .center

        let stack = UIStackView(arrangedSubviews: [label, buttonsStack])
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
        extensionBanner.isHidden = isFresh || extensionBannerDismissed || !setupComplete
        view.setNeedsLayout()
    }

    // Keep the options page readable while the banner is up: push the web
    // content down by the banner's height instead of floating over it.
    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        let inset = extensionBanner.isHidden ? 0 : extensionBanner.frame.height + 16
        if webView.scrollView.contentInset.top != inset {
            webView.scrollView.contentInset.top = inset
        }
    }

    @objc private func dismissExtensionBanner() {
        extensionBannerDismissed = true
        updateExtensionBanner()
    }

    // There's no public URL scheme into the Safari Extensions settings page
    // specifically, but openSettingsURLString does drop the user into the
    // Settings app itself (on this app's own page) rather than leaving them to
    // find it from the home screen — real help even though it can't land on
    // the exact screen the wizard describes.
    @objc private func openSettings() {
        guard let settingsURL = URL(string: UIApplication.openSettingsURLString) else { return }
        UIApplication.shared.open(settingsURL)
    }

    @objc private func openSafari() {
        // Loading any page in Safari runs the (enabled) extension, which
        // stamps the heartbeat that hides this banner; the destination just
        // needs to be neutral and fast.
        if let safariURL = URL(string: "x-safari-https://www.apple.com") {
            UIApplication.shared.open(safariURL, options: [:]) { success in
                if !success, let fallbackURL = URL(string: "https://www.apple.com") {
                    UIApplication.shared.open(fallbackURL)
                }
            }
        }
    }
#endif

    // MARK: - In-app purchase bridge
    //
    // Coaching credit is sold through StoreKit and nothing else. The web layer
    // (billing.js) can list products, buy one, restore (recover an interrupted
    // purchase), or read status — every one of those is a StoreKit call made
    // here, in the app. `manage` has no consumable equivalent and is a no-op
    // stub, kept only for bridge compatibility.

    private func handleBillingMessage(action: String, dict: [String: Any], callbackId: String) {
        guard #available(iOS 15.0, macOS 12.0, *) else {
            invokeBridgeCallback(callbackId, result: ["available": false, "error": "In-app purchases need a newer OS version."])
            return
        }
        let store = IntentionStore.shared
        switch action {
        case "products":
            Task {
                let products = await store.products()
                self.invokeBridgeCallback(callbackId, result: [
                    "available": true,
                    "products": products
                ])
            }
        case "purchase":
            let productId = dict["productId"] as? String ?? ""
            Task {
                let result = await store.purchase(productID: productId)
                self.invokeBridgeCallback(callbackId, result: result)
            }
        case "restore":
            Task {
                let result = await store.restore()
                self.invokeBridgeCallback(callbackId, result: result)
            }
        case "redeem":
            Task {
                let result = await store.redeem()
                self.invokeBridgeCallback(callbackId, result: result)
            }
        case "accountToken":
            Task {
                let result = await store.accountToken()
                self.invokeBridgeCallback(callbackId, result: result)
            }
        case "status":
            Task {
                let result = await store.status()
                self.invokeBridgeCallback(callbackId, result: result)
            }
        case "manage":
            // No-op: a consumable top-up has nothing to manage/cancel. Kept
            // as a stub purely so ios-bridge.js/billing.js's `manage` call
            // still resolves without needing a bridge contract change.
            invokeBridgeCallback(callbackId, result: ["ok": true])
        default:
            invokeBridgeCallback(callbackId, result: ["error": "unknown billing action: \(action)"])
        }
    }

    private func invokeBridgeCallback(_ callbackId: String, result: Any?) {
        guard !callbackId.isEmpty, let resultLiteral = JSBridgeCodec.encodedLiteral(result) else { return }
        webView.evaluateJavaScript(
            "window.IntentionCallbacks.invoke(\(JSBridgeCodec.jsLiteral(callbackId)), \(resultLiteral))"
        ) { _, error in
            if let error { NSLog("[Intention] bridge callback failed: %@", String(describing: error)) }
        }
    }

}
