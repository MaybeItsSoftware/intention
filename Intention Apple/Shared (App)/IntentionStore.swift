//
//  IntentionStore.swift
//  Shared (App)
//
//  StoreKit 2 wrapper for coaching credit, the consumable top-up that turns on
//  the built-in coach. Everything the web layer can buy goes through here:
//  there is no other purchase path in the app, and no way to reach one from it.
//
//  The web layer (billing.js) talks to this through `window.intentionBilling`,
//  injected by ios-bridge.js and answered in ViewController.handleBillingMessage.
//
//  Consumables behave differently from the subscription this used to be:
//  StoreKit doesn't remember them once finished (`Transaction.currentEntitlements`
//  excludes consumables entirely), so the backend's credit balance is the only
//  source of truth for "how much does this person have" — this file's job is
//  just buying, verifying-and-finishing, and recovering an interrupted buy.
//

import Foundation
import StoreKit
import Security
#if os(macOS)
import AppKit
#endif

@available(iOS 15.0, macOS 12.0, *)
enum IntentionProduct {
    // Must match the product IDs configured in App Store Connect (and in
    // Intention.storekit for local/sandbox testing) and server/src/config.js's
    // topUps table.
    static let credit1 = "intention1pound"
    static let credit2 = "intention2pound"
    static let credit5 = "intention5pound"

    static let all: [String] = [credit1, credit2, credit5]
}

@available(iOS 15.0, macOS 12.0, *)
actor IntentionStore {

    static let shared = IntentionStore()

    // Matches shared/providers.js's DEFAULT_INTENTION_BACKEND_URL. Purchases
    // are verified-and-credited from here directly (not routed through the
    // JS layer first) so a transaction can be finished as soon as the credit
    // is durably recorded server-side, per Apple's consumable guidance.
    private let defaultBackendURL = URL(string: "https://api.intention.maybeitssoftware.uk")!

    private var cachedProducts: [Product] = []
    private var updatesTask: Task<Void, Never>?

    // StoreKit delivers Ask-to-Buy approvals and other later-arriving updates
    // through Transaction.updates, which has to be listened to for the whole
    // app lifetime or those transactions are never finished.
    func start() {
        guard updatesTask == nil else { return }
        updatesTask = Task.detached(priority: .background) {
            for await update in Transaction.updates {
                guard case .verified(let transaction) = update else { continue }
                if await IntentionStore.shared.verifyWithBackend(receipt: update.jwsRepresentation) {
                    await transaction.finish()
                    await IntentionStore.shared.noteCredited(update.jwsRepresentation)
                }
            }
        }
        Task { await recoverUnfinishedTransactions() }
    }

    // MARK: - Products

    func products() async -> [[String: Any]] {
        if cachedProducts.isEmpty {
            // An empty catalogue and a failed lookup reach the user as the same
            // "unavailable right now" line, which is the right thing to say to
            // them but leaves nothing to debug with — a build running outside
            // Xcode's StoreKit configuration, an App Store Connect product not
            // yet Ready to Submit, and a dropped connection are indistinguishable
            // from the outside. Log which one it was.
            do {
                cachedProducts = try await Product.products(for: IntentionProduct.all)
                if cachedProducts.isEmpty {
                    NSLog("[Intention] StoreKit returned no products for %@ — check App Store Connect availability, or run from Xcode to use Intention.storekit", IntentionProduct.all.joined(separator: ", "))
                }
            } catch {
                cachedProducts = []
                NSLog("[Intention] StoreKit product lookup failed: %@", String(describing: error))
            }
        }
        // Cheapest first — the smallest top-up leads, per the "show the
        // lowest amount first" decision.
        return cachedProducts
            .sorted { $0.price < $1.price }
            .map { product in
                [
                    "id": product.id,
                    "title": product.displayName,
                    "description": product.description,
                    "price": product.displayPrice,
                    "type": "one-time"
                ]
            }
    }

    // MARK: - Purchase

    // Returns the shape billing.js expects:
    //   { status: purchased | cancelled | pending | failed, receipt?, error? }
    // `receipt` is the JWS representation of the signed transaction. The JS
    // layer also calls verifyPurchase() with it after this resolves — that
    // call is idempotent and mostly just refreshes the JS-side balance/UI;
    // the durable credit already happened in verifyWithBackend below.
    func purchase(productID: String) async -> [String: Any] {
        var product = cachedProducts.first(where: { $0.id == productID })
        if product == nil {
            product = (try? await Product.products(for: [productID]))?.first
        }
        guard let product = product else {
            return ["status": "failed", "error": "That top-up isn't available right now."]
        }

        do {
            let result = try await product.purchase(options: [.appAccountToken(stableAccountToken())])
            switch result {
            case .success(let verification):
                switch verification {
                case .verified(let transaction):
                    let jws = verification.jwsRepresentation
                    // Only finish once the credit is durably recorded — if
                    // this fails (offline, server hiccup), leave it
                    // unfinished; the next start()/restore() sweep will
                    // retry it via Transaction.unfinished.
                    if await verifyWithBackend(receipt: jws) {
                        await transaction.finish()
                    }
                    return ["status": "purchased", "platform": "apple", "receipt": jws]
                case .unverified(_, let error):
                    // App Store signature check failed — never treat as paid.
                    return ["status": "failed", "error": "That purchase couldn't be verified (\(error.localizedDescription))."]
                }
            case .userCancelled:
                return ["status": "cancelled"]
            case .pending:
                return ["status": "pending"]
            @unknown default:
                return ["status": "failed", "error": "Unexpected purchase result."]
            }
        } catch {
            return ["status": "failed", "error": error.localizedDescription]
        }
    }

    // MARK: - Restore (recovers an interrupted purchase, not an ongoing plan)

    // A consumable has nothing to "restore" in the subscription sense — once
    // finished, StoreKit forgets it. What this recovers is a purchase that
    // was bought but never durably credited (app killed, offline at the
    // time) — a real, useful operation, just a different one than before.
    func restore() async -> [String: Any] {
        try? await AppStore.sync()
        guard let jws = await recoverUnfinishedTransactions(), !jws.isEmpty else {
            return ["status": "none", "error": "No pending purchase found."]
        }
        return ["status": "purchased", "platform": "apple", "receipt": jws]
    }

    // Sweeps Transaction.unfinished — unlike currentEntitlements, this *does*
    // include not-yet-finished consumables — verifying-and-crediting each one
    // against the backend before finishing it. Returns the last recovered
    // transaction's JWS, if any, so restore() can hand it to the JS layer.
    @discardableResult
    private func recoverUnfinishedTransactions() async -> String? {
        var lastRecovered: String?
        for await result in Transaction.unfinished {
            guard case .verified(let transaction) = result,
                  IntentionProduct.all.contains(transaction.productID) else { continue }
            let jws = result.jwsRepresentation
            if await verifyWithBackend(receipt: jws) {
                await transaction.finish()
                lastRecovered = jws
            }
        }
        return lastRecovered
    }

    // MARK: - Redeem an App Store code

    // Presents Apple's own code-redemption sheet. Everything about the
    // redemption happens inside StoreKit: there is no field of ours, and the
    // only codes it accepts are ones App Store Connect issued against this
    // app. The granted transaction arrives asynchronously through
    // Transaction.updates (see start()), which verifies-and-credits it just
    // like a bought one — so this waits for it to land rather than returning
    // the instant the sheet closes.
    //
    // iOS only: macOS has no presentCodeRedemptionSheet, and a Mac user
    // redeems in the App Store app instead, which start()'s listener picks up
    // on the next launch.
    func redeem() async -> [String: Any] {
#if os(iOS)
        // Cleared first so a grant from a *previous* redemption can't be
        // mistaken for this one's.
        lastCreditedJWS = nil
        await MainActor.run { SKPaymentQueue.default().presentCodeRedemptionSheet() }

        // The sheet is fire-and-forget: StoreKit reports the grant through
        // Transaction.updates whenever the App Store gets round to it, which
        // is usually seconds after the sheet closes but is not guaranteed to
        // be before it. Wait for the transaction rather than returning
        // immediately, or the paywall would report nothing while the balance
        // quietly changed underneath it.
        //
        // Two places to look, because start()'s listener and this call race
        // for the same transaction: whichever of them gets there first is the
        // answer. Checking only Transaction.unfinished would report "none"
        // for a redemption the listener had already finished.
        for _ in 0..<30 {
            try? await Task.sleep(nanoseconds: 1_000_000_000)
            if let jws = lastCreditedJWS {
                return ["status": "purchased", "platform": "apple", "receipt": jws]
            }
            if let jws = await recoverUnfinishedTransactions(), !jws.isEmpty {
                return ["status": "purchased", "platform": "apple", "receipt": jws]
            }
        }
        // Not a failure — App Store grants can land minutes later. The next
        // launch's start() sweep will credit it.
        return ["status": "none", "error": "No redeemed code has come through yet. It can take a moment — the credit will appear on its own."]
#elseif os(macOS)
        // No presentCodeRedemptionSheet on macOS, so the nearest real thing is
        // the App Store's own redeem page. Opening it beats the message that
        // used to stand here: the button rendered on this build either way, so
        // telling someone to go and find the App Store themselves was a dead
        // end dressed as a control.
        lastCreditedJWS = nil
        if let url = URL(string: "macappstore://apps.apple.com/redeem") {
            await MainActor.run { NSWorkspace.shared.open(url) }
        } else {
            return ["status": "failed", "error": "Couldn't open the App Store to redeem a code."]
        }

        // Same race as on iOS — start()'s listener and this call both want the
        // granted transaction — so watch both places for it.
        for _ in 0..<30 {
            try? await Task.sleep(nanoseconds: 1_000_000_000)
            if let jws = lastCreditedJWS {
                return ["status": "purchased", "platform": "apple", "receipt": jws]
            }
            if let jws = await recoverUnfinishedTransactions(), !jws.isEmpty {
                return ["status": "purchased", "platform": "apple", "receipt": jws]
            }
        }
        return ["status": "none", "error": "No redeemed code has come through yet. It can take a moment — the credit will appear on its own."]
#else
        return ["status": "failed", "error": "Codes can't be redeemed on this device."]
#endif
    }

    // Set by whichever path credits a transaction, so redeem() above can tell
    // that the code it just presented actually landed.
    private var lastCreditedJWS: String?

    func noteCredited(_ jws: String) {
        lastCreditedJWS = jws
    }

    // The device-local UUID a balance is keyed by, handed to the web layer so
    // it can name the subject on a verify. A redeemed code's transaction
    // carries no appAccountToken of its own — this is what gives that grant a
    // balance to land in, and it is the same value every bought transaction
    // already carries, so both end up in one balance.
    func accountToken() -> [String: Any] {
        return ["token": stableAccountToken().uuidString]
    }

    // MARK: - Status

    // No local StoreKit truth to report for a consumable (see file header) —
    // the backend's balance is authoritative. Kept as a stub purely so the
    // ios-bridge.js/billing.js `status` action still resolves.
    func status() async -> [String: Any] {
        return ["available": true, "entitled": false]
    }

    // MARK: - Backend verification

    private func verifyWithBackend(receipt: String) async -> Bool {
        var request = URLRequest(url: defaultBackendURL.appendingPathComponent("v1/entitlement/verify"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        // accountToken is only *used* by the backend when the transaction has
        // none of its own (a redeemed code); for a bought one the signed
        // transaction's own token wins and this is ignored.
        request.httpBody = try? JSONSerialization.data(withJSONObject: [
            "platform": "apple",
            "receipt": receipt,
            "accountToken": stableAccountToken().uuidString
        ])
        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            guard (response as? HTTPURLResponse)?.statusCode == 200 else { return false }
            persistEntitlement(from: data, receipt: receipt)
            return true
        } catch {
            return false
        }
    }

    // The verify response carries the access token the Safari extension's
    // coach authenticates with. On iOS the JS layer also saves it (the app
    // hosts options.html, whose billing.js runs verifyPurchase), but on macOS
    // the app's window never runs that JS — this write into the App Group is
    // the only path by which a Mac purchase reaches the extension, which
    // pulls it via SafariWebExtensionHandler's pullConfig. Shaped to match
    // billing.js's normalizeEntitlement so the JS side needs no changes.
    private func persistEntitlement(from data: Data, receipt: String) {
        guard let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return }
        let entitlement: [String: Any] = [
            "active": (json["active"] as? Bool) ?? false,
            "productId": (json["productId"] as? String) ?? "",
            "source": "apple",
            "token": (json["token"] as? String) ?? "",
            "receipt": receipt,
            "balanceMicros": json["balanceMicros"] ?? 0,
            "balanceGbp": json["balanceGbp"] ?? 0,
            "balanceCredits": json["balanceCredits"] ?? 0,
            "pendingVerification": false,
            "lastError": "",
            // Milliseconds, matching the JS side's Date.now() stamps.
            "updatedAt": Int(Date().timeIntervalSince1970 * 1000)
        ]
        AppGroupStorage.mergeConfig(["entitlement": entitlement])
    }

    // MARK: - Account token

    // A consumable purchase's transaction id is never stable across repeat
    // buys, so the backend keys a person's balance by this instead: a
    // client-issued UUID, echoed back in the verified transaction as
    // `appAccountToken`. Keychain (iCloud-synced) so it survives a reinstall
    // on any device signed into the same Apple ID — a paid balance deserves
    // that continuity.
    private func stableAccountToken() -> UUID {
        let service = "uk.co.maybeitssoftware.intention.accountToken"
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrSynchronizable as String: true,
            kSecReturnData as String: true
        ]
        var item: CFTypeRef?
        if SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
           let data = item as? Data,
           let uuidString = String(data: data, encoding: .utf8),
           let uuid = UUID(uuidString: uuidString) {
            return uuid
        }

        let newToken = UUID()
        let addQuery: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrSynchronizable as String: true,
            kSecValueData as String: newToken.uuidString.data(using: .utf8)!
        ]
        SecItemAdd(addQuery as CFDictionary, nil)
        return newToken
    }
}
