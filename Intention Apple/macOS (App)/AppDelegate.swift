//
//  AppDelegate.swift
//  macOS (App)
//
//  Created by Adam on 22/06/2026.
//

import Cocoa
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

    func applicationDidFinishLaunching(_ notification: Notification) {
        configureMainWindow()
        checkExtensionState()
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

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag {
            NSApp.windows.first { $0.contentViewController is ViewController }?.makeKeyAndOrderFront(nil)
        }
        return true
    }

    // MARK: - Window

    // Narrow windows get the page's single-column phone layout, which still
    // works; the floor only stops the window being dragged into something
    // narrower than a phone. The autosave name remembers where and how big the
    // user left it.
    private func configureMainWindow() {
        guard let window = NSApp.windows.first(where: { $0.contentViewController is ViewController }) else { return }
        window.minSize = NSSize(width: 480, height: 560)
        window.setFrameAutosaveName("IntentionMainWindow")
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

        // A sheet on our own window when we have one, so this cannot end up as
        // a free-floating alert in front of whatever the user was actually
        // doing; a modal only when there is no window to hang it from.
        if let window = NSApplication.shared.mainWindow ?? NSApplication.shared.windows.first {
            alert.beginSheetModal(for: window, completionHandler: handle)
        } else {
            handle(alert.runModal())
        }
    }

}
