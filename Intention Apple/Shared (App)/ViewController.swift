//
//  ViewController.swift
//  Shared (App)
//
//  Created by Adam on 22/06/2026.
//

import WebKit

#if os(iOS)
import UIKit
import CoreText
import SafariServices
typealias PlatformViewController = UIViewController
#elseif os(macOS)
import Cocoa
import SafariServices
import ServiceManagement
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

    // "Intention / Getting ready…", native, for the moment before WebKit has
    // painted anything. The page opens on the same two lines (#boot-view), so
    // the hand-over is invisible.
    private var launchPlaceholder: UIView?
#endif

    override func viewDidLoad() {
        super.viewDidLoad()

        self.webView.navigationDelegate = self
        if #available(iOS 16.4, macOS 13.3, *) {
            self.webView.isInspectable = true
        }

        // The storyboard's webview carries only a design-time frame, so pin it
        // explicitly or options.html never gets a real, correctly-sized
        // viewport (on iOS) or stops following the window as it resizes (on
        // the Mac).
        self.webView.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            self.webView.topAnchor.constraint(equalTo: view.topAnchor),
            self.webView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            self.webView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            self.webView.bottomAnchor.constraint(equalTo: view.bottomAnchor)
        ])

        // Both apps are the same thing now: the extension's own options page,
        // with the coach and its bookkeeping running in-process in
        // BackgroundJSHost against the App Group. The Mac window used to be a
        // separate status page with no progress in it at all.
        setUpNativeBridge()
        BackgroundJSHost.shared.start()
        BackgroundJSHost.shared.attach(to: view)
        // Listen for renewals / Ask-to-Buy approvals for as long as the app is
        // alive, or StoreKit never finishes those transactions.
        if #available(iOS 15.0, macOS 12.0, *) {
            Task { await IntentionStore.shared.start() }
        }
        loadOptionsPage()

#if os(iOS)
        // The page's own paper colour behind the web view while it loads, in
        // both appearances, instead of the white flash that read as a blank
        // screen before the first paint.
        let paper = UIColor { traits in
            traits.userInterfaceStyle == .dark
                ? UIColor(red: 0x1c / 255, green: 0x1a / 255, blue: 0x23 / 255, alpha: 1)
                : UIColor(red: 0xfa / 255, green: 0xf8 / 255, blue: 0xf4 / 255, alpha: 1)
        }
        view.backgroundColor = paper
        // Transparent until the page paints, so the native placeholder behind it
        // shows through. Starting the web content process alone takes a second
        // or more on a cold launch, and nothing the page does can paint sooner.
        self.webView.isOpaque = false
        self.webView.backgroundColor = .clear
        self.webView.scrollView.backgroundColor = .clear
        setUpLaunchPlaceholder()
        self.webView.scrollView.isScrollEnabled = true
        setUpExtensionBanner()
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(appDidBecomeActive),
            name: UIApplication.didBecomeActiveNotification,
            object: nil
        )
#elseif os(macOS)
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(appDidBecomeActive),
            name: NSApplication.didBecomeActiveNotification,
            object: nil
        )
#endif
    }

#if os(iOS)
    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        updateExtensionBanner()
    }
#endif

    @objc private func appDidBecomeActive() {
#if os(iOS)
        updateExtensionBanner()
#endif
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
#if os(iOS) && canImport(FamilyControls)
        if #available(iOS 16.0, *) {
            AppBlockingManager.shared.reapplyIfPassExpired()
        }
#endif
    }

    deinit {
        NotificationCenter.default.removeObserver(self)
    }

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

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        NSLog("[Intention] webView didFail navigation: %@", String(describing: error))
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        NSLog("[Intention] webView didFailProvisionalNavigation: %@", String(describing: error))
    }

#if os(iOS)
    private static var bundledFontsRegistered = false

    private static func registerBundledFonts() {
        guard !bundledFontsRegistered else { return }
        bundledFontsRegistered = true
        let urls = Bundle.main.urls(forResourcesWithExtension: "woff2", subdirectory: "fonts") ?? []
        guard !urls.isEmpty else { return }
        CTFontManagerRegisterFontURLs(urls as CFArray, .process, true, nil)
    }

    private func setUpLaunchPlaceholder() {
        let ink = UIColor { traits in
            traits.userInterfaceStyle == .dark
                ? UIColor(red: 0xf5 / 255, green: 0xf4 / 255, blue: 0xf7 / 255, alpha: 1)
                : UIColor(red: 0x44 / 255, green: 0x40 / 255, blue: 0x54 / 255, alpha: 1)
        }
        let muted = UIColor { traits in
            traits.userInterfaceStyle == .dark
                ? UIColor(red: 0xb6 / 255, green: 0xb3 / 255, blue: 0xbf / 255, alpha: 1)
                : UIColor(red: 0x6e / 255, green: 0x6b / 255, blue: 0x7c / 255, alpha: 1)
        }
        // Arvo, the page's own face, so nothing changes typeface when the page
        // takes over. The app bundle already carries the web fonts; CoreText
        // reads WOFF2 directly.
        Self.registerBundledFonts()

        let name = UILabel()
        name.text = "Intention"
        name.textColor = ink
        name.font = UIFont(name: "Arvo-Bold", size: 28) ?? .boldSystemFont(ofSize: 28)

        let status = UILabel()
        status.text = "Getting ready\u{2026}"
        status.textColor = muted
        status.font = UIFont(name: "Arvo", size: 14) ?? .systemFont(ofSize: 14)

        let stack = UIStackView(arrangedSubviews: [name, status])
        stack.axis = .vertical
        stack.alignment = .center
        stack.spacing = 6
        stack.translatesAutoresizingMaskIntoConstraints = false
        stack.isAccessibilityElement = true
        stack.accessibilityLabel = "Intention, getting ready"
        view.insertSubview(stack, belowSubview: webView)
        NSLayoutConstraint.activate([
            stack.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            stack.centerYAnchor.constraint(equalTo: view.centerYAnchor)
        ])
        launchPlaceholder = stack
    }
#endif

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
#if os(iOS)
        // didFinish can land a frame or two before WebKit's first paint, and
        // taking the placeholder away then left exactly the blank frame it is
        // there to prevent. The page's opaque ground covers it once painted, so
        // it goes a little later, as tidying rather than as a hand-over.
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in
            self?.launchPlaceholder?.removeFromSuperview()
            self?.launchPlaceholder = nil
        }
#endif
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == "intentionNative" else { return }
        handleBridgeMessage(message.body)
    }

    // MARK: - Options WebView + native bridge

    private func setUpNativeBridge() {
        let contentController = webView.configuration.userContentController
        contentController.add(self, name: "intentionNative")

        // Read by ios-bridge.js before it builds the shims: the Mac has no
        // Screen Time, so it must not advertise window.intentionScreenTime, and
        // the page styles itself for a resizable desktop window.
#if os(macOS)
        let platform = "mac"
#else
        let platform = "ios"
#endif
        contentController.addUserScript(WKUserScript(
            source: "window.__intentionPlatform = \(JSBridgeCodec.jsLiteral(platform));",
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        ))

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
#if os(iOS)
        case "screenTime":
            let action = dict["action"] as? String ?? ""
            let callbackId = dict["callbackId"] as? String ?? ""
            handleScreenTimeMessage(action: action, dict: dict, callbackId: callbackId)
#endif
        case "billing":
            let action = dict["action"] as? String ?? ""
            let callbackId = dict["callbackId"] as? String ?? ""
            handleBillingMessage(action: action, dict: dict, callbackId: callbackId)
        case "extension":
            let action = dict["action"] as? String ?? ""
            let callbackId = dict["callbackId"] as? String ?? ""
            handleExtensionMessage(action: action, dict: dict, callbackId: callbackId)
        case "getStorage":
            let keys = dict["keys"] as? [String] ?? []
            let callbackId = dict["callbackId"] as? String ?? ""
            invokeBridgeCallback(callbackId, result: AppGroupStorage.get(keys))
        case "setStorage":
            let items = dict["items"] as? [String: Any] ?? [:]
            let callbackId = dict["callbackId"] as? String ?? ""
            AppGroupStorage.set(items)
            invokeBridgeCallback(callbackId, result: [String: Any]())
        case "removeStorage":
            let keys = dict["keys"] as? [String] ?? []
            let callbackId = dict["callbackId"] as? String ?? ""
            AppGroupStorage.remove(keys)
            invokeBridgeCallback(callbackId, result: [String: Any]())
        case "clearStorage":
            let callbackId = dict["callbackId"] as? String ?? ""
            AppGroupStorage.clear()
            invokeBridgeCallback(callbackId, result: [String: Any]())
        default:
            break
        }
    }

#if os(macOS)
    // MARK: - Safari extension enablement bridge (Mac)
    //
    // The Mac can simply ask Safari, which is better than the iOS heartbeat:
    // the answer is the switch itself, not "has it run lately". A failed query
    // (Safari not running, a launch race) falls back to the heartbeat rather
    // than reporting "off" on no evidence.

    private var safariExtensionSettingsPath: String {
        if #available(macOS 13.0, *) {
            return "Safari \u{2192} Settings \u{2192} Extensions"
        }
        return "Safari \u{2192} Preferences \u{2192} Extensions"
    }

    private func handleExtensionMessage(action: String, dict: [String: Any], callbackId: String) {
        switch action {
        case "status":
            SFSafariExtensionManager.getStateOfSafariExtension(withIdentifier: extensionBundleIdentifier) { state, error in
                DispatchQueue.main.async {
                    let seenAt = AppGroupStorage.extensionLastSeenAt()
                    let active: Bool
                    if let state, error == nil {
                        active = state.isEnabled
                    } else {
                        active = seenAt.map { Date().timeIntervalSince($0) < 24 * 60 * 60 } ?? false
                    }
                    self.invokeBridgeCallback(callbackId, result: [
                        "active": active,
                        "platform": "mac",
                        "settingsPath": self.safariExtensionSettingsPath,
                        "lastSeenAt": seenAt.map { $0.timeIntervalSince1970 * 1000 } as Any
                    ])
                }
            }
        case "openSettings":
            // Lands on Intention's own row in Safari's Extensions settings. The
            // switch itself is the user's to throw.
            SFSafariApplication.showPreferencesForExtension(withIdentifier: extensionBundleIdentifier) { _ in }
            invokeBridgeCallback(callbackId, result: ["ok": true])
        case "openSafari":
            if let safari = NSWorkspace.shared.urlForApplication(withBundleIdentifier: "com.apple.Safari") {
                NSWorkspace.shared.open(safari)
            }
            invokeBridgeCallback(callbackId, result: ["ok": true])
        case "setSetupComplete":
            // Nothing native waits on this on the Mac; AppDelegate's
            // disabled-extension notice keys off the real switch instead.
            invokeBridgeCallback(callbackId, result: ["ok": true])
        case "loginItem":
            invokeBridgeCallback(callbackId, result: loginItemState())
        case "setLoginItem":
            let enabled = (dict["enabled"] as? Bool) ?? false
            if #available(macOS 13.0, *) {
                do {
                    if enabled {
                        try SMAppService.mainApp.register()
                    } else {
                        try SMAppService.mainApp.unregister()
                    }
                } catch {
                    // Registering an app that is already registered (or
                    // unregistering one that isn't) throws too. The state read
                    // back below is the answer either way.
                    NSLog("[Intention] login item change failed: %@", String(describing: error))
                }
            }
            invokeBridgeCallback(callbackId, result: loginItemState())
        case "openLoginItemsSettings":
            if #available(macOS 13.0, *) {
                SMAppService.openSystemSettingsLoginItems()
            }
            invokeBridgeCallback(callbackId, result: ["ok": true])
        default:
            invokeBridgeCallback(callbackId, result: ["error": "unknown extension action: \(action)"])
        }
    }

    // "Open Intention at login", as the page's switch needs it. `requiresApproval`
    // is macOS holding a registration until the user allows it under System
    // Settings → General → Login Items — on, from our side, but not yet real.
    private func loginItemState() -> [String: Any] {
        guard #available(macOS 13.0, *) else {
            return ["available": false, "enabled": false, "requiresApproval": false]
        }
        let status = SMAppService.mainApp.status
        return [
            "available": true,
            "enabled": status == .enabled,
            "requiresApproval": status == .requiresApproval
        ]
    }
#endif

#if os(iOS)
    // MARK: - Safari extension enablement bridge (iOS)
    //
    // Backs the setup wizard's "Turn on the Safari extension" step. Same
    // heartbeat the banner below reads — the difference is that the wizard can
    // explain the step in context, so while setup is unfinished the banner
    // stands down and lets it.

    private func handleExtensionMessage(action: String, dict: [String: Any], callbackId: String) {
        switch action {
        case "status":
            readExtensionEnabled { [weak self] enabled in
                guard let self else { return }
                let seenAt = AppGroupStorage.extensionLastSeenAt()
                let isFresh = seenAt.map { Date().timeIntervalSince($0) < self.extensionHeartbeatFreshnessWindow } ?? false
                self.invokeBridgeCallback(callbackId, result: [
                    "active": enabled ?? isFresh,
                    "platform": "ios",
                    // iOS 26.2 can read the switch itself and open Safari's
                    // Extensions page directly; before that the wizard has to
                    // spell out the path and wait for Safari to run it.
                    "readsSwitch": enabled != nil,
                    "opensExtensionSettings": self.canOpenExtensionSettings,
                    "settingsPath": self.safariExtensionSettingsPath,
                    "lastSeenAt": seenAt.map { $0.timeIntervalSince1970 * 1000 } as Any
                ])
            }
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
        case "endPass":
            manager.endPass()
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
    // is macOS-only). Instead we use a heartbeat: the extension's native
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
        label.text = canOpenExtensionSettings
            ? "Intention's Safari extension is off, so blocked websites won't stop you. Tap Turn On, then switch on Intention and allow it on every website."
            : "Intention's Safari extension isn't active yet, so blocked websites won't stop you.\n1. Go to \(safariExtensionSettingsPath) and turn on Intention Safari Extension.\n2. Open Safari and load any page once to activate it."
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

        let safariButton = canOpenExtensionSettings
            ? filledButton("Turn On", action: #selector(openSettings))
            : filledButton("Open Safari", action: #selector(openSafari))

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
        readExtensionEnabled { [weak self] enabled in
            guard let self else { return }
            let seenAt = AppGroupStorage.extensionLastSeenAt()
            let isFresh = seenAt.map { Date().timeIntervalSince($0) < self.extensionHeartbeatFreshnessWindow } ?? false
            self.extensionBanner.isHidden = (enabled ?? isFresh) || self.extensionBannerDismissed || !self.setupComplete
            self.view.setNeedsLayout()
        }
    }

    // iOS 26.2+: Safari's real on/off switch for the extension. nil below that,
    // or when Safari can't answer, and callers fall back to the heartbeat.
    private func readExtensionEnabled(_ completion: @escaping (Bool?) -> Void) {
        guard #available(iOS 26.2, *) else {
            completion(nil)
            return
        }
        SFSafariExtensionManager.getStateOfExtension(withIdentifier: extensionBundleIdentifier) { state, error in
            let enabled: Bool? = (error == nil) ? state?.isEnabled : nil
            DispatchQueue.main.async { completion(enabled) }
        }
    }

    private var canOpenExtensionSettings: Bool {
        if #available(iOS 26.2, *) { return true }
        return false
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

    // iOS 26.2 opens Safari's Extensions settings with Intention's row, which
    // is the screen the wizard asks for. Before that there is no public way
    // there, so this falls back to the Settings app on this app's own page, as
    // it does if the direct call fails.
    @objc private func openSettings() {
        let openAppSettings = {
            guard let settingsURL = URL(string: UIApplication.openSettingsURLString) else { return }
            UIApplication.shared.open(settingsURL)
        }
        guard #available(iOS 26.2, *) else {
            openAppSettings()
            return
        }
        SFSafariSettings.openExtensionsSettings(forIdentifiers: [extensionBundleIdentifier]) { error in
            if let error {
                NSLog("[Intention] couldn't open Safari extension settings: %@", String(describing: error))
                openAppSettings()
            }
        }
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
