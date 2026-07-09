//
//  SafariWebExtensionHandler.swift
//  Shared (Extension)
//
//  Created by Adam on 22/06/2026.
//

import SafariServices
import os.log

class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {

    func beginRequest(with context: NSExtensionContext) {
        let request = context.inputItems.first as? NSExtensionItem

        let profile: UUID?
        if #available(iOS 17.0, macOS 14.0, *) {
            profile = request?.userInfo?[SFExtensionProfileKey] as? UUID
        } else {
            profile = request?.userInfo?["profile"] as? UUID
        }

        let message: Any?
        if #available(iOS 15.0, macOS 11.0, *) {
            message = request?.userInfo?[SFExtensionMessageKey]
        } else {
            message = request?.userInfo?["message"]
        }

        os_log(.default, "Received message from browser.runtime.sendNativeMessage: %@ (profile: %@)", String(describing: message), profile?.uuidString ?? "none")

        let responsePayload = handle(message: message)

        let response = NSExtensionItem()
        if #available(iOS 15.0, macOS 11.0, *) {
            response.userInfo = [ SFExtensionMessageKey: responsePayload ]
        } else {
            response.userInfo = [ "message": responsePayload ]
        }

        context.completeRequest(returningItems: [ response ], completionHandler: nil)
    }

    // Answers the native-messaging config bridge used by tracking.js's
    // pushConfigToNative()/syncConfigFromNative() (Apple platforms only — see
    // tracking.js). Falls back to the original echo behavior for any other
    // message shape, unchanged from before this bridge existed.
    private func handle(message: Any?) -> [String: Any] {
#if os(iOS)
        guard let dict = message as? [String: Any], let action = dict["action"] as? String else {
            return [ "echo": message as Any ]
        }

        switch action {
        case "pushConfig":
            let config = dict["config"] as? [String: Any] ?? [:]
            AppGroupStorage.mergeConfig(config)
            AppGroupStorage.stampExtensionHeartbeat()
            return [ "ok": true ]

        case "pullConfig":
            AppGroupStorage.stampExtensionHeartbeat()
            return [ "config": AppGroupStorage.configSubset() ]

        default:
            return [ "echo": message as Any ]
        }
#else
        return [ "echo": message as Any ]
#endif
    }

}
