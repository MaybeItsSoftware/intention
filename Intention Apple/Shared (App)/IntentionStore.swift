//
//  IntentionStore.swift
//  Shared (App)
//
//  StoreKit 2 wrapper for Intention Pro, the subscription that turns on the
//  built-in coach. Everything the web layer can buy goes through here: there is
//  no other purchase path in the app, and no way to reach one from it.
//
//  The web layer (billing.js) talks to this through `window.intentionBilling`,
//  injected by ios-bridge.js and answered in ViewController.handleBillingMessage.
//

import Foundation
import StoreKit

#if os(iOS)
import UIKit
#elseif os(macOS)
import AppKit
#endif

@available(iOS 15.0, macOS 12.0, *)
enum IntentionProduct {
    // Must match the product IDs configured in App Store Connect (and in
    // Intention.storekit for local/sandbox testing).
    static let monthly = "uk.co.maybeitssoftware.intention.pro.monthly"
    static let yearly = "uk.co.maybeitssoftware.intention.pro.yearly"

    static let all: [String] = [monthly, yearly]
}

@available(iOS 15.0, macOS 12.0, *)
actor IntentionStore {

    static let shared = IntentionStore()

    private var cachedProducts: [Product] = []
    private var updatesTask: Task<Void, Never>?

    // StoreKit delivers renewals, Ask-to-Buy approvals and purchases made on
    // another device through Transaction.updates, which has to be listened to
    // for the whole app lifetime or those transactions are never finished.
    func start() {
        guard updatesTask == nil else { return }
        updatesTask = Task.detached(priority: .background) {
            for await update in Transaction.updates {
                guard case .verified(let transaction) = update else { continue }
                await transaction.finish()
                await IntentionStore.shared.cacheEntitlementSnapshot()
            }
        }
        Task { await cacheEntitlementSnapshot() }
    }

    // MARK: - Products

    func products() async -> [[String: Any]] {
        if cachedProducts.isEmpty {
            cachedProducts = (try? await Product.products(for: IntentionProduct.all)) ?? []
        }
        // Cheapest-per-period first so the monthly plan leads and the yearly
        // one reads as the upgrade, rather than depending on StoreKit's order.
        return cachedProducts
            .sorted { $0.price < $1.price }
            .map { product in
                [
                    "id": product.id,
                    "title": product.displayName,
                    "description": product.description,
                    "price": product.displayPrice,
                    "period": Self.periodLabel(for: product),
                    "type": product.type == .autoRenewable ? "subscription" : "one-time"
                ]
            }
    }

    private static func periodLabel(for product: Product) -> String {
        guard let period = product.subscription?.subscriptionPeriod else { return "" }
        let unit: String
        switch period.unit {
        case .day: unit = "day"
        case .week: unit = "week"
        case .month: unit = "month"
        case .year: unit = "year"
        @unknown default: unit = ""
        }
        if unit.isEmpty { return "" }
        return period.value == 1 ? unit : "\(period.value) \(unit)s"
    }

    // MARK: - Purchase

    // Returns the shape billing.js expects:
    //   { status: purchased | cancelled | pending | failed, receipt?, error? }
    // `receipt` is the JWS representation of the signed transaction — exactly
    // what the backend re-verifies with Apple before minting an access token.
    func purchase(productID: String) async -> [String: Any] {
        guard let product = cachedProducts.first(where: { $0.id == productID })
            ?? (try? await Product.products(for: [productID]))?.first else {
            return ["status": "failed", "error": "That plan isn't available right now."]
        }

        do {
            let result = try await product.purchase()
            switch result {
            case .success(let verification):
                switch verification {
                case .verified(let transaction):
                    await transaction.finish()
                    await cacheEntitlementSnapshot()
                    return ["status": "purchased", "platform": "apple", "receipt": verification.jwsRepresentation]
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

    // MARK: - Restore

    func restore() async -> [String: Any] {
        // Pulls anything bought on this Apple Account onto this device first,
        // so a reinstall doesn't come up empty.
        try? await AppStore.sync()
        guard let entitlement = await currentEntitlement() else {
            return ["status": "none", "error": "No previous purchase found on this Apple Account."]
        }
        return ["status": "purchased", "platform": "apple", "receipt": entitlement.jws]
    }

    // MARK: - Status

    struct EntitlementSnapshot {
        let productID: String
        let expiresAt: Date?
        let jws: String
    }

    func currentEntitlement() async -> EntitlementSnapshot? {
        for await result in Transaction.currentEntitlements {
            guard case .verified(let transaction) = result,
                  IntentionProduct.all.contains(transaction.productID),
                  transaction.revocationDate == nil else { continue }
            return EntitlementSnapshot(
                productID: transaction.productID,
                expiresAt: transaction.expirationDate,
                jws: result.jwsRepresentation
            )
        }
        return nil
    }

    func status() async -> [String: Any] {
        guard let entitlement = await currentEntitlement() else {
            return ["available": true, "entitled": false]
        }
        return [
            "available": true,
            "entitled": true,
            "platform": "apple",
            "productId": entitlement.productID,
            "expiresAt": entitlement.expiresAt.map { $0.timeIntervalSince1970 * 1000 } as Any,
            "receipt": entitlement.jws
        ]
    }

    // Mirrors the store's own view of the subscription into the App Group, so
    // a renewal or lapse that StoreKit reports while the web layer isn't
    // looking still reaches it (and the Safari extension) on the next read.
    // The backend remains the authority on whether calls are allowed — this is
    // only the local hint that a re-verify is worth doing.
    private func cacheEntitlementSnapshot() async {
        let entitlement = await currentEntitlement()
        var payload: [String: Any] = ["storeEntitled": entitlement != nil]
        if let entitlement {
            payload["storeProductId"] = entitlement.productID
            payload["storeExpiresAt"] = entitlement.expiresAt.map { $0.timeIntervalSince1970 * 1000 } ?? 0
        }
        AppGroupStorage.set(["storeEntitlement": payload])
    }

    // MARK: - Manage

    @MainActor
    static func openManageSubscriptions() async {
#if os(iOS)
        guard let scene = UIApplication.shared.connectedScenes
            .compactMap({ $0 as? UIWindowScene })
            .first(where: { $0.activationState == .foregroundActive }) else { return }
        try? await AppStore.showManageSubscriptions(in: scene)
#elseif os(macOS)
        // No in-app sheet on macOS; the App Store app owns subscriptions there.
        if let url = URL(string: "macappstore://apps.apple.com/account/subscriptions") {
            NSWorkspace.shared.open(url)
        }
#endif
    }
}
