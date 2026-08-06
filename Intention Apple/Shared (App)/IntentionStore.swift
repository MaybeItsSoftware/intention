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
                }
            }
        }
        Task { await recoverUnfinishedTransactions() }
    }

    // MARK: - Products

    func products() async -> [[String: Any]] {
        if cachedProducts.isEmpty {
            cachedProducts = (try? await Product.products(for: IntentionProduct.all)) ?? []
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
        request.httpBody = try? JSONSerialization.data(withJSONObject: ["platform": "apple", "receipt": receipt])
        do {
            let (_, response) = try await URLSession.shared.data(for: request)
            return (response as? HTTPURLResponse)?.statusCode == 200
        } catch {
            return false
        }
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
