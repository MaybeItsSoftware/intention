//
//  AppDelegate.swift
//  macOS (App)
//
//  Created by Adam on 22/06/2026.
//

import Cocoa
import CoreServices
import SafariServices

@main
class AppDelegate: NSObject, NSApplicationDelegate {

    // Nothing on macOS can resist removal. The .app can be dragged to the
    // Trash, and the extension's on/off switch lives in Safari's own settings
    // where no web extension API can read it, let alone gate it. The one
    // honest thing left is for the host app — which does have
    // SFSafariExtensionManager — to NOTICE that the extension went dark and
    // say so once, so that "I turned it off in a weak moment and forgot"
    // stops being a silent, permanent state.
    //
    // Deliberately narrow: we only speak up if we have previously seen the
    // extension enabled on this Mac. A fresh install where it has never been
    // turned on is the setup wizard's job (its "Turn on the Safari extension"
    // step) and duplicating that here would be a second onboarding nag over
    // the top of the first.
    private let sawEnabledKey = "IntentionSafariExtensionWasEnabled"

    // Set when we surface the notice, cleared the moment the extension comes
    // back. That pairing is what makes this once per *disable event* rather
    // than once per launch: turning it off, being told, and turning it back on
    // rearms us for the next time, but leaving it off keeps us quiet forever.
    private let noticeShownKey = "IntentionSafariExtensionDisableNoticeShown"

    // getStateOfSafariExtension is asynchronous and both entry points below
    // fire in quick succession at launch, so without this the first launch
    // would run two overlapping queries and could put up two alerts.
    private var stateCheckInFlight = false

    // True when launchd started us for the login item rather than the user
    // asking for the app. "Start Intention at login" exists so that something
    // checks the extension is still on after a restart, not so that a window
    // is waiting on top of whatever you actually logged in to do — so on this
    // kind of launch we run as an accessory: no window, no Dock icon, no menu
    // bar. The only thing that can break that silence is the extension having
    // gone dark.
    private var launchedAtLogin = false

    func applicationWillFinishLaunching(_ notification: Notification) {
        // Read here rather than in didFinishLaunching: the open-application
        // Apple event is only the *current* event while the launch is being
        // handled, and the storyboard window goes up in between. Catching it
        // this early is also what keeps the Dock icon from ever being drawn.
        if Self.launchedAsLoginItem() { enterBackgroundLaunch() }
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        // Second opinion, because the two mechanisms disagree depending on how
        // the login item was registered: SMAppService launches come from
        // launchd, which does not always carry the Apple event property below.
        // A non-default launch is good enough — this app has no documents and
        // no URL scheme, so nothing else opens it without the user. Arriving
        // here rather than above costs at most a blink of Dock icon.
        if let isDefaultLaunch = notification.userInfo?[NSApplication.launchIsDefaultUserInfoKey] as? Bool,
           !isDefaultLaunch {
            enterBackgroundLaunch()
        }

        configureMainWindow()
        if launchedAtLogin { hideMainWindow() }
        checkExtensionState()
    }

    // The classic check, and the only one that works when Launch Services
    // (rather than launchd) does the honours: the kAEOpenApplication event
    // carries keyAELaunchedAsLogInItem when the launch came from a login item.
    private static func launchedAsLoginItem() -> Bool {
        guard let event = NSAppleEventManager.shared().currentAppleEvent,
              event.eventID == kAEOpenApplication else { return false }
        return event.paramDescriptor(forKeyword: keyAEPropData)?.enumCodeValue == keyAELaunchedAsLogInItem
    }

    func applicationDidBecomeActive(_ notification: Notification) {
        checkExtensionState()
    }

    // The window is a dashboard now, not a one-shot "go and enable the
    // extension" page, so closing it leaves the app in the Dock like any other
    // Mac app and clicking the Dock icon brings it back. Blocking itself never
    // depended on the app running — that is the extension, inside Safari.
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        return false
    }

    // With no Dock icon and no window, the way back in is to open Intention
    // the way you would open anything — Spotlight, Applications, the Safari
    // extension's button. Launch Services sees us already running and sends
    // this instead of starting a second copy, so this is the hinge the whole
    // accessory launch turns on: it is where we become an ordinary app.
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        leaveBackgroundLaunch()
        if !flag {
            mainWindow?.makeKeyAndOrderFront(nil)
        }
        return true
    }

    // MARK: - Window

    // Narrow windows get the page's single-column phone layout, which still
    // works; the floor only stops the window being dragged into something
    // narrower than a phone. The autosave name remembers where and how big the
    // user left it.
    private func configureMainWindow() {
        guard let window = mainWindow else { return }
        window.minSize = NSSize(width: 480, height: 560)
        window.setFrameAutosaveName("IntentionMainWindow")
    }

    private var mainWindow: NSWindow? {
        NSApp.windows.first { $0.contentViewController is ViewController }
    }

    // The storyboard puts its window on screen for us, so the window exists and
    // is already ordered front by the time any delegate method runs. Ordering
    // it out here, before the run loop draws a frame, is what keeps the login
    // launch invisible rather than a flash. The webview behind it carries on
    // loading, so opening Intention later is instant.
    private func hideMainWindow() {
        mainWindow?.orderOut(nil)
    }

    // MARK: - Accessory launch

    private func enterBackgroundLaunch() {
        guard !launchedAtLogin else { return }
        launchedAtLogin = true
        NSApp.setActivationPolicy(.accessory)
        hideMainWindow()
    }

    // Once the user has asked for Intention it is an ordinary app again, with
    // a Dock icon and a menu bar, and stays that way until it is quit. The
    // activation is deferred by one turn of the run loop because AppKit will
    // not bring a process forward in the same breath as the policy change that
    // made it eligible — without this the window comes up behind the frontmost
    // app about half the time.
    private func leaveBackgroundLaunch() {
        guard launchedAtLogin else { return }
        launchedAtLogin = false
        NSApp.setActivationPolicy(.regular)
        DispatchQueue.main.async { NSApp.activate(ignoringOtherApps: true) }
    }

    // MARK: - Extension state

    private func checkExtensionState() {
        guard !stateCheckInFlight else { return }
        stateCheckInFlight = true

        // extensionBundleIdentifier is ViewController.swift's, read out of the
        // Xcode project rather than guessed; both targets in this app compile
        // against the same one.
        SFSafariExtensionManager.getStateOfSafariExtension(withIdentifier: extensionBundleIdentifier) { state, error in
            DispatchQueue.main.async {
                self.stateCheckInFlight = false

                // A failed query is not evidence of anything — Safari not
                // running, a launch-time race, a profile we cannot see. Saying
                // "your extension is off" on a missing answer would be a lie a
                // fraction of the time, and this notice only works if it is
                // never wrong. Stay quiet.
                guard let state = state, error == nil else { return }

                self.handleExtensionState(isEnabled: state.isEnabled)
            }
        }
    }

    private func handleExtensionState(isEnabled: Bool) {
        let defaults = UserDefaults.standard

        if isEnabled {
            defaults.set(true, forKey: sawEnabledKey)
            defaults.set(false, forKey: noticeShownKey)
            return
        }

        guard defaults.bool(forKey: sawEnabledKey) else { return }
        guard !defaults.bool(forKey: noticeShownKey) else { return }

        // Recorded before the alert goes up, not after it is dismissed: if the
        // app is force-quit with the sheet open we would rather have said this
        // once and lost it than say it on every launch from then on.
        defaults.set(true, forKey: noticeShownKey)

        presentDisabledNotice()
    }

    private func presentDisabledNotice() {
        let alert = NSAlert()
        alert.alertStyle = .informational
        alert.messageText = "Intention's Safari extension is turned off"
        alert.informativeText = "Blocked sites aren't being blocked. You can turn it back on in Safari's Extensions settings, or leave it off and this won't ask again."
        alert.addButton(withTitle: "Open Safari Settings")
        alert.addButton(withTitle: "Leave It Off")

        let handle: (NSApplication.ModalResponse) -> Void = { response in
            guard response == .alertFirstButtonReturn else { return }
            // The same call the host page's "open preferences" button makes.
            // It takes the user to Intention's own row in Safari's Extensions
            // settings; the switch itself is theirs to throw, which is the
            // whole point.
            SFSafariApplication.showPreferencesForExtension(withIdentifier: extensionBundleIdentifier) { _ in }
        }

        // A sheet on our own window when one is on screen, so this cannot end
        // up as a free-floating alert in front of whatever the user was
        // actually doing. After an accessory launch there is no visible window
        // to hang it from — and a sheet on a hidden window would be a notice
        // nobody can see — so that case comes forward and asks outright. It is
        // the one thing worth interrupting a login for: blocking is off.
        //
        // It asks as an accessory, without promoting itself to a full app: the
        // alert is the entire interruption, and answering it either sends you
        // to Safari or dismisses it. Neither outcome deserves a Dock icon left
        // behind for an app the user never opened.
        if let window = NSApp.windows.first(where: { $0.isVisible && $0.contentViewController is ViewController }) {
            alert.beginSheetModal(for: window, completionHandler: handle)
        } else {
            NSApp.activate(ignoringOtherApps: true)
            handle(alert.runModal())
        }
    }

}
