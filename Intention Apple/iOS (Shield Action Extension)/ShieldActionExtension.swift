//
//  ShieldActionExtension.swift
//  Intention Shield Action Extension
//
//  Handles the button on the shield. A shield cannot launch another app,
//  so the only action offered is closing the blocked app; getting time
//  goes through the coach inside the Intention app.
//

#if os(iOS)
import ManagedSettings

class ShieldActionExtension: ShieldActionDelegate {
    override func handle(action: ShieldAction, for application: ApplicationToken, completionHandler: @escaping (ShieldActionResponse) -> Void) {
        completionHandler(.close)
    }

    override func handle(action: ShieldAction, for webDomain: WebDomainToken, completionHandler: @escaping (ShieldActionResponse) -> Void) {
        completionHandler(.close)
    }

    override func handle(action: ShieldAction, for category: ActivityCategoryToken, completionHandler: @escaping (ShieldActionResponse) -> Void) {
        completionHandler(.close)
    }
}
#endif
