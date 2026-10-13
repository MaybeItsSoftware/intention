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
//  just buying, verifying-and-finishing, recovering an interrupted buy, and —
//  since a consumed consumable can never be re-reported by the store — trading
//  the Keychain account id back for the balance it keys after a reinstall.
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

    // Matches shared/providers.js's DEFAULT_INTENTION_BACKEND_URL — pinned by
    // tests/parity.test.js, because it did NOT match for months and nothing
    // noticed. The registered domain is maybeitssoftware.co.uk; a bare .uk
    // variant was fixed across the JS in v0.22.1 and missed here, so every
    // verify from this file went to a host that does not resolve. Purchases
    // are verified-and-credited from here directly (not routed through the
    // JS layer first) so a transaction can be finished as soon as the credit
    // is durably recorded server-side, per Apple's consumable guidance —
    // which also means this file is the ONLY path a StoreKit purchase takes.
    private let defaultBackendURL = URL(string: "https://api.intention.maybeitssoftware.co.uk")!

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
                switch await IntentionStore.shared.verifyWithBackend(receipt: update.jwsRepresentation) {
                case .credited:
                    await transaction.finish()
                    await IntentionStore.shared.noteCredited(update.jwsRepresentation)
                case .rejected:
                    await transaction.finish()
                case .unavailable:
                    break
                }
            }
        }
        // Both sweeps in one task, in this order, deliberately. The unfinished
        // sweep can itself credit-and-persist an entitlement, and the recovery
        // below skips a device that already has one — sequencing them here is
        // what makes "do not go asking for a balance we have just been handed"
        // structural rather than a race between two detached tasks.
        Task {
            await recoverUnfinishedTransactions()
            // A launch with nothing to recover must not spend a request on
            // this: /v1/entitlement/recover is rate limited per IP, and a
            // household behind one address would burn the budget on launches
            // that had nothing to recover. shouldAttemptRecovery() is what
            // makes that true rather than merely intended — see the long note
            // on it.
            if await shouldAttemptRecovery() {
                await recoverBalance()
            }
        }
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
        // No account id, no sale. The id is what the balance is keyed by, and
        // a purchase stamped with one that never made it into the Keychain
        // would credit a balance this device can never name again — paid for,
        // and gone on the next launch.
        guard let accountToken = stableAccountToken() else {
            return ["status": "failed", "error": "Couldn't read your account from the Keychain. Unlock your device and try again."]
        }

        do {
            let result = try await product.purchase(options: [.appAccountToken(accountToken)])
            switch result {
            case .success(let verification):
                switch verification {
                case .verified(let transaction):
                    let jws = verification.jwsRepresentation
                    // Only finish once the credit is durably recorded — if
                    // this fails (offline, server hiccup), leave it
                    // unfinished; the next start()/restore() sweep will
                    // retry it via Transaction.unfinished. A definitive "no"
                    // from the server is finished too (see VerifyOutcome).
                    switch await verifyWithBackend(receipt: jws) {
                    case .credited, .rejected:
                        await transaction.finish()
                    case .unavailable:
                        break
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
            switch await verifyWithBackend(receipt: jws) {
            case .credited:
                await transaction.finish()
                lastRecovered = jws
            case .rejected:
                await transaction.finish()
            case .unavailable:
                break
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
    //
    // No token at all when the Keychain can't be read (billing.js reads a
    // missing one as "none"), rather than a fresh one that was never saved.
    func accountToken() -> [String: Any] {
        guard let token = stableAccountToken() else {
            return ["error": "Couldn't read the account id from the Keychain."]
        }
        return ["token": token.uuidString]
    }

    // MARK: - Status

    // No local StoreKit truth to report for a consumable (see file header) —
    // the backend's balance is authoritative. Kept as a stub purely so the
    // ios-bridge.js/billing.js `status` action still resolves.
    func status() async -> [String: Any] {
        return ["available": true, "entitled": false]
    }

    // MARK: - Backend verification

    // What the server made of a transaction, because "not credited" covers
    // two different things that want opposite handling. A transient failure
    // (offline, 5xx, 429, a proxy's 404) must leave the transaction unfinished
    // so the next sweep retries it. A definitive rejection must NOT: StoreKit
    // re-delivers an unfinished transaction on every launch for ever, and one
    // the server will never accept (refunded, another app's, the wrong
    // environment) used to be re-sent on every one of them.
    enum VerifyOutcome {
        case credited
        case rejected
        case unavailable
    }

    // The server's answers about the receipt itself. 404, 405 and 408 are not
    // on the list: they say the request never reached the verifier (a
    // misrouted host, a proxy), not that the receipt is bad, and finishing on
    // them would throw paid-for credit away over a deployment mistake.
    nonisolated private static let definitiveRejections: Set<Int> = [400, 401, 402, 403, 409, 410, 422]

    private func verifyWithBackend(receipt: String) async -> VerifyOutcome {
        // Sent with every verify, and the only thing that gives a redeemed
        // code a balance to land in — so without it this is a retry later,
        // not a request the server would turn down as definitive.
        guard let accountToken = stableAccountToken() else { return .unavailable }
        var request = URLRequest(url: defaultBackendURL.appendingPathComponent("v1/entitlement/verify"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        // accountToken is only *used* by the backend when the transaction has
        // none of its own (a redeemed code); for a bought one the signed
        // transaction's own token wins and this is ignored.
        request.httpBody = try? JSONSerialization.data(withJSONObject: [
            "platform": "apple",
            "receipt": receipt,
            "accountToken": accountToken.uuidString
        ])
        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            if status == 200 {
                await persistEntitlement(from: data, receipt: receipt)
                return .credited
            }
            if Self.definitiveRejections.contains(status) {
                NSLog("[Intention] backend rejected a transaction (HTTP %d), finishing it: %@",
                      status, String(data: data, encoding: .utf8) ?? "")
                return .rejected
            }
            return .unavailable
        } catch {
            return .unavailable
        }
    }

    // The verify response carries the access token the Safari extension's
    // coach authenticates with. On iOS the JS layer also saves it (the app
    // hosts options.html, whose billing.js runs verifyPurchase), but on macOS
    // the app's window never runs that JS — this write into the App Group is
    // the only path by which a Mac purchase reaches the extension, which
    // pulls it via SafariWebExtensionHandler's pullConfig. Shaped to match
    // billing.js's normalizeEntitlement so the JS side needs no changes.
    // Both verifyWithBackend and recoverBalance land here, because the two
    // responses are the same shape — /v1/entitlement/recover reuses the verify
    // endpoint's entitlementResponse builder (server/src/app.js).
    // `async` for the same reason shouldAttemptRecovery below is: AppGroupStorage
    // is main-actor isolated and this touches it twice from the store's own
    // actor, so the awaits are real hops rather than decoration. It used to
    // call mergeConfig straight, which Swift 6 language mode rejects outright.
    private func persistEntitlement(from data: Data, receipt: String? = nil) async {
        guard let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return }
        // Read first, because one field in the stored entitlement is ours and
        // not the server's: recoveryCheckedAt is a local throttle marker (see
        // stampRecoveryChecked). Rebuilding the object from the response alone
        // would silently drop it, handing the next launch — and the JS layer,
        // which reads the same field — a free pass to re-ask a question that
        // has already been answered.
        let existing = await AppGroupStorage.get(["entitlement"])["entitlement"] as? [String: Any]
        let entitlement: [String: Any] = [
            "active": (json["active"] as? Bool) ?? false,
            "productId": (json["productId"] as? String) ?? "",
            "source": "apple",
            "token": (json["token"] as? String) ?? "",
            // Empty when this came from a recovery rather than a purchase:
            // there is no receipt left to keep — the consumable's was consumed
            // at purchase — and normalizeEntitlement in billing.js maps a
            // falsy receipt to null, so the JS side needs no change to read
            // one back.
            "receipt": receipt ?? "",
            "balanceMicros": json["balanceMicros"] ?? 0,
            "balanceGbp": json["balanceGbp"] ?? 0,
            "balanceCredits": json["balanceCredits"] ?? 0,
            "pendingVerification": false,
            "lastError": "",
            "recoveryCheckedAt": existing?["recoveryCheckedAt"] ?? 0,
            // Milliseconds, matching the JS side's Date.now() stamps.
            "updatedAt": Int(Date().timeIntervalSince1970 * 1000)
        ]
        await AppGroupStorage.mergeConfig(["entitlement": entitlement])
    }

    // MARK: - Balance recovery

    // Turning a surviving account id back into a live entitlement.
    //
    // Everything above this line needs proof of purchase, and after a reinstall
    // there is none left to give. A top-up is a consumable, so its transaction
    // is finished the moment the credit lands: `Transaction.currentEntitlements`
    // excludes consumables by design, and `Transaction.unfinished` only ever
    // holds the ones that never got credited. So there is no receipt anywhere
    // on a fresh device to re-verify, and the balance someone paid for is
    // unreachable by every path in this file.
    //
    // The one thing that does survive is `stableAccountToken()` — Keychain,
    // synchronizable, so it comes back on any device signed into the same
    // Apple ID with iCloud Keychain on — and it is exactly what the backend
    // keys the balance by. `POST /v1/entitlement/recover` trades it for a
    // signed token and the current balance (server/src/app.js's
    // recoverEndpoint). That endpoint writes nothing on either path, so a miss
    // costs nothing and a repeat is free.
    //
    // It fails soft and silent, and that is the point rather than an omission.
    // A 404 is the ordinary answer for two entirely normal people: someone who
    // has never bought anything, and someone whose iCloud Keychain was off
    // when they last had credit. Neither wants an error at launch. The second
    // one needs their recovery code instead, and the web layer owns the copy
    // that tells them so.
    @discardableResult
    private func recoverBalance() async -> Bool {
        // A Keychain that can't be read right now is not "nothing to recover":
        // ask again next launch rather than stamping a miss.
        guard let accountToken = stableAccountToken() else { return false }
        var request = URLRequest(url: defaultBackendURL.appendingPathComponent("v1/entitlement/recover"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        // No receipt and no bearer: the account id *is* the credential here.
        // Note the case — `uuidString` is uppercase, and the balance may have
        // been keyed by whatever case Apple echoed `appAccountToken` back in,
        // which is why the server tries all three casings of what it is sent
        // rather than us guessing one here.
        request.httpBody = try? JSONSerialization.data(withJSONObject: [
            "platform": "apple",
            "accountToken": accountToken.uuidString
        ])
        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            if status == 200 { await persistEntitlement(from: data) }
            // Only a definitive answer is worth remembering, and the stamp has
            // to come after the persist above or it would be written into the
            // entitlement and then overwritten by it.
            //
            // 200 and 404 are the endpoint's two real answers ("here is your
            // balance" and "nothing is attached to this id") and both mean the
            // question has been put and settled. A 429, a 5xx or a dropped
            // connection means it never was — silencing the next twenty-four
            // hours of launches over a server outage would strand a balance
            // that is really there for a day, which is the opposite of what
            // this endpoint is for.
            if status == 200 || status == 404 { await stampRecoveryChecked() }
            return status == 200
        } catch {
            return false
        }
    }

    // How long a "we asked, and there was nothing" answer stands before it is
    // worth spending another request. Deliberately the same twenty-four hours
    // as billing.js's RECOVERY_RECHECK_MS, for the same reason given there:
    // long enough to be free, short enough that a backup landing overnight is
    // noticed by morning.
    private static let recoveryRecheckMs: Double = 24 * 60 * 60 * 1000

    // The guard on recoverBalance(): is there anything here worth spending a
    // request on? Two ways the answer is no, and the second one is why this
    // function exists at all.
    //
    // The first is a token already sitting in the App Group. A warm launch has
    // nothing to recover, and an entitlement whose token has merely aged out is
    // deliberately NOT re-recovered from here — billing.js's refreshEntitlement
    // owns that case, because it can also re-verify from a stored receipt,
    // which is the stronger claim of the two.
    //
    // The second is a recent miss, and it is the whole point. "No token in the
    // App Group" is NOT "cold install", which is what this guard used to
    // assume: almost nobody buys coaching credit, so almost nobody ever has a
    // token, so a token-only test let recovery fire on every single process
    // launch for the rest of that install's life — BYOK users and people who
    // will never pay included. iOS jetsams backgrounded apps often enough for
    // that to be ten launches in an hour. Every one of them is a 404, every
    // 404 is charged against RECOVER_FAILS (10 per hour per IP, see
    // server/src/app.js), and at the tenth the server starts answering 429 to
    // that whole address — so a genuine reinstall by anyone else behind the
    // same NAT (a household, a campus, a carrier's CGNAT) could no longer
    // recover the balance they had actually paid for. The marker below is what
    // makes "a launch with nothing to recover costs no request" true after the
    // first one, rather than merely asserted in a comment.
    //
    // The marker is `entitlement.recoveryCheckedAt` — the same field, in the
    // same object, in the same App Group the two layers already pass state
    // through (SafariWebExtensionHandler pushes and pulls it, and the web
    // layer writes it in options-access.js's recoverStrandedCredit). Sharing
    // it rather than inventing a second Swift-side marker is deliberate: there
    // are two recovery paths, and with an idea of "have we asked?" each, both
    // fired on the same launch and each spent a request the other had just
    // proved pointless. One marker, one question, whichever side asks first.
    //
    // `async` because AppGroupStorage is main-actor isolated and this reads it
    // from the store's own actor; the await is a real hop, not decoration.
    private func shouldAttemptRecovery(now: Date = Date()) async -> Bool {
        let entitlement = await AppGroupStorage.get(["entitlement"])["entitlement"] as? [String: Any]
        if !(((entitlement?["token"] as? String) ?? "").isEmpty) {
            return false
        }
        // NSNumber rather than a concrete Swift type: this number crosses the
        // App Group as JSON, written as an Int by stampRecoveryChecked below
        // and as a JS Number by the web layer, and only the NSNumber bridge
        // reads both back.
        let checkedAt = (entitlement?["recoveryCheckedAt"] as? NSNumber)?.doubleValue ?? 0
        let nowMs = now.timeIntervalSince1970 * 1000
        // A stamp in the future is a clock that has moved backwards, not a
        // check that has just happened. Treating it as recent would suppress
        // recovery until the clock caught up, which could be years.
        if checkedAt > nowMs {
            return true
        }
        return nowMs - checkedAt >= Self.recoveryRecheckMs
    }

    // Records that the question was asked and answered, so the next launch —
    // and the web layer's own recovery path, which reads this same field —
    // costs nothing.
    //
    // Merged onto whatever entitlement is already there rather than written as
    // one, because this is a throttle marker and not a fact about the
    // entitlement: a miss must not be able to conjure an `active` flag or a
    // token out of nothing. `["active": false, "source": ""]` is the same seed
    // billing.js's recoverStrandedCredit uses for exactly this write, and
    // normalizeEntitlement reads the result back unchanged.
    private func stampRecoveryChecked(at now: Date = Date()) async {
        var entitlement = (await AppGroupStorage.get(["entitlement"])["entitlement"] as? [String: Any])
            ?? ["active": false, "source": ""]
        // Milliseconds, matching the JS side's Date.now() stamps.
        entitlement["recoveryCheckedAt"] = Int(now.timeIntervalSince1970 * 1000)
        await AppGroupStorage.mergeConfig(["entitlement": entitlement])
    }

    // MARK: - Account token

    // A consumable purchase's transaction id is never stable across repeat
    // buys, so the backend keys a person's balance by this instead: a
    // client-issued UUID, echoed back in the verified transaction as
    // `appAccountToken`. Keychain (iCloud-synced) so it survives a reinstall
    // on any device signed into the same Apple ID — a paid balance deserves
    // that continuity.
    //
    // Returns nil rather than guess. Any read failure used to fall through to
    // minting a fresh UUID — including errSecInteractionNotAllowed, which is
    // just "the device is locked" — and the add's result was ignored, so an
    // id that was never saved could still be stamped on a purchase as its
    // appAccountToken: the credit landed in a balance no later launch could
    // name. Now a new id is only minted when the Keychain says there is none,
    // and only returned once it is actually stored.
    nonisolated private static let accountTokenService = "uk.co.maybeitssoftware.intention.accountToken"
    private var accountTokenAccessibilityChecked = false

    private func stableAccountToken() -> UUID? {
        let item: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: Self.accountTokenService,
            kSecAttrSynchronizable as String: true
        ]

        switch readAccountToken(item) {
        case .found(let uuid):
            migrateAccountTokenAccessibility(item)
            return uuid
        case .failed(let status):
            NSLog("[Intention] Keychain read of the account id failed (%d)", status)
            return nil
        case .missing:
            break
        }

        let newToken = UUID()
        var add = item
        add[kSecValueData as String] = Data(newToken.uuidString.utf8)
        // Readable after the first unlock since boot, not only while unlocked,
        // so a StoreKit transaction landing while the screen is locked
        // (Transaction.updates, an Ask-to-Buy approval) can still be verified.
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        let status = SecItemAdd(add as CFDictionary, nil)
        switch status {
        case errSecSuccess:
            accountTokenAccessibilityChecked = true
            return newToken
        case errSecDuplicateItem:
            // Another path (or iCloud Keychain, syncing one down) got there
            // first. Theirs is the id; ours was never stored.
            if case .found(let uuid) = readAccountToken(item) { return uuid }
            return nil
        default:
            NSLog("[Intention] Keychain could not store a new account id (%d)", status)
            return nil
        }
    }

    private enum AccountTokenRead {
        case found(UUID)
        case missing
        case failed(OSStatus)
    }

    private func readAccountToken(_ item: [String: Any]) -> AccountTokenRead {
        var query = item
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        switch status {
        case errSecSuccess:
            guard let data = result as? Data,
                  let uuidString = String(data: data, encoding: .utf8),
                  let uuid = UUID(uuidString: uuidString) else {
                // Present but not one of ours — nothing can be keyed by it, so
                // replacing it loses nothing. Deleted so the add can proceed.
                SecItemDelete(item as CFDictionary)
                return .missing
            }
            return .found(uuid)
        case errSecItemNotFound:
            return .missing
        default:
            return .failed(status)
        }
    }

    // Items stored by earlier builds took the default accessibility (only
    // while unlocked). Moved over once per launch; a failure just leaves the
    // old accessibility in place, which is no worse than before.
    private func migrateAccountTokenAccessibility(_ item: [String: Any]) {
        guard !accountTokenAccessibilityChecked else { return }
        accountTokenAccessibilityChecked = true
        let update: [String: Any] = [kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlock]
        let status = SecItemUpdate(item as CFDictionary, update as CFDictionary)
        if status != errSecSuccess {
            NSLog("[Intention] could not update the account id's Keychain accessibility (%d)", status)
        }
    }
}
