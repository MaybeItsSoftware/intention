//
//  AppDelegate.swift
//  iOS (App)
//
//  Created by Adam on 22/06/2026.
//

import UIKit

@main
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        // Start the hidden background WebView host so it's ready by the time
        // ViewController's options.html WebView sends its first message.
        BackgroundJSHost.shared.start()
        // Claiming the notification delegate is not the same as asking for
        // permission — that happens only when a pass actually needs the
        // fallback notice (PassExpiryNotifier) — but it has to be in place
        // before any notification can be delivered, and iOS wants it set
        // before the app finishes launching.
        PassExpiryNotifier.shared.registerAsPresentationDelegate()
        return true
    }

    func application(_ application: UIApplication, configurationForConnecting connectingSceneSession: UISceneSession, options: UIScene.ConnectionOptions) -> UISceneConfiguration {
        return UISceneConfiguration(name: "Default Configuration", sessionRole: connectingSceneSession.role)
    }

}
