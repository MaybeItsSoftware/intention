package uk.co.maybeitssoftware.intention

import android.app.Activity
import android.content.Context
import android.content.SharedPreferences
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Log
import com.android.billingclient.api.BillingClient
import com.android.billingclient.api.BillingClientStateListener
import com.android.billingclient.api.BillingFlowParams
import com.android.billingclient.api.BillingResult
import com.android.billingclient.api.ConsumeParams
import com.android.billingclient.api.PendingPurchasesParams
import com.android.billingclient.api.ProductDetails
import com.android.billingclient.api.Purchase
import com.android.billingclient.api.PurchasesUpdatedListener
import com.android.billingclient.api.QueryProductDetailsParams
import com.android.billingclient.api.QueryPurchasesParams
import com.google.android.gms.auth.blockstore.Blockstore
import com.google.android.gms.auth.blockstore.RetrieveBytesRequest
import com.google.android.gms.auth.blockstore.StoreBytesData
import com.google.android.gms.tasks.Tasks
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.util.UUID
import java.util.concurrent.TimeUnit

/**
 * Google Play Billing wrapper for coaching credit — the consumable top-up
 * that turns on the built-in coach.
 *
 * This mirrors IntentionStore.swift on Apple: the web layer (billing.js) sees
 * a `window.intentionBilling` object, and every purchase it can make goes
 * through Play. A purchase is verified-and-credited against the backend
 * directly from here (not routed through the JS layer first) before it's
 * consumed, so a tampered client can't mint itself access, and the product
 * only becomes purchasable again once it's durably credited.
 */
object BillingManager : PurchasesUpdatedListener {

    private const val TAG = "IntentionBilling"

    // Matches shared/providers.js's DEFAULT_INTENTION_BACKEND_URL — pinned by
    // tests/parity.test.js, because it did NOT match for months and nothing
    // noticed. The registered domain is maybeitssoftware.co.uk; a bare .uk
    // variant was fixed across the JS in v0.22.1 and missed here, so every
    // verify from this file died at DNS resolution and was swallowed into a
    // warn log by the catch in verifyWithBackend. No Android purchase or
    // redeemed code has ever been credited.
    private const val DEFAULT_BACKEND_URL = "https://api.intention.maybeitssoftware.co.uk"

    // Must match server/src/config.js's topUps table and the Play Console
    // product IDs.
    const val PRODUCT_CREDIT_1 = "intention1pound"
    const val PRODUCT_CREDIT_2 = "intention2pound"
    const val PRODUCT_CREDIT_5 = "intention5pound"
    private val PRODUCT_IDS = listOf(PRODUCT_CREDIT_1, PRODUCT_CREDIT_2, PRODUCT_CREDIT_5)

    private const val PLAY_STORE_PACKAGE = "com.android.vending"

    // Named here because res/xml/backup_rules.xml and
    // res/xml/data_extraction_rules.xml both list this file by hand as the one
    // thing Intention backs up — a self-blocking app must not restore its own
    // blocking state, but must never lose the account id that keys a paid
    // balance. Renaming this string silently un-backs-up that balance, so it
    // is a constant with a comment rather than a literal in two places.
    private const val BILLING_PREFS = "intention_billing"

    // The Block Store key the account id is mirrored under. Block Store keeps
    // it across an uninstall and reinstall on the same device (and carries it
    // to a new one), which is the gap Auto Backup leaves: Auto Backup only
    // runs about once a day and restores only at install, so a same-day
    // reinstall — every Play internal-testing reinstall, for a start — minted
    // a fresh id and orphaned the paid balance. Renaming this string orphans
    // every balance it was protecting.
    private const val BLOCKSTORE_ACCOUNT_KEY = "uk.co.maybeitssoftware.intention.billing_account_id"
    private const val BLOCKSTORE_TIMEOUT_SECONDS = 5L
    @Volatile private var blockStoreSynced = false
    // Set on a fresh install whose Block Store lookup failed rather than came
    // back empty; see stableAccountId.
    private const val PREF_BLOCKSTORE_UNCONFIRMED = "account_id_blockstore_unconfirmed"
    private val accountIdLock = Any()
    @Volatile private var settledAccountId: String? = null

    // How long redeem() waits for a Play-side grant to show up (~2 minutes).
    private const val REDEEM_POLL_INTERVAL_MS = 2_000L
    // Connect and read limits on the backend verify; see verifyWithBackend.
    private const val VERIFY_TIMEOUT_MS = 15_000
    private const val REDEEM_POLL_ATTEMPTS = 60

    private var billingClient: BillingClient? = null
    private var productCache: List<ProductDetails> = emptyList()

    // Held from init() so the stable account id — which lives in
    // SharedPreferences — can be read on the backend-verify thread, which has
    // no Activity to hand.
    private var appContext: Context? = null

    // A purchase arrives asynchronously through onPurchasesUpdated, long after
    // launchBillingFlow returns, so the JS callback waiting on it is parked
    // here until Play answers.
    private var pendingPurchaseCallback: ((JSONObject) -> Unit)? = null

    // Told about a purchase credited with no JS callback waiting on it — a
    // redeemed code picked up by the poll below. The backend balance moves
    // either way, but the web layer only learns of it from a receipt it can
    // verify itself, and dropping this result is how a redeemed code showed
    // "item added" in Play and nothing in the app. Set by MainActivity.
    var onBackgroundCredit: ((JSONObject) -> Unit)? = null

    fun init(context: Context) {
        appContext = context.applicationContext
        if (billingClient != null) return
        // Settle the account id off the main thread before anything asks for
        // it, so the Block Store lookup (which has to block) never happens on
        // the UI thread. launchFlow runs on the main thread and would
        // otherwise mint a fresh id when the app is opened straight into the
        // paywall.
        val ctx = context.applicationContext
        Thread { stableAccountId(ctx) }.start()
        val pendingPurchasesParams = PendingPurchasesParams.newBuilder()
            .enableOneTimeProducts()
            .build()
        val client = BillingClient.newBuilder(context.applicationContext)
            .setListener(this)
            .enablePendingPurchases(pendingPurchasesParams)
            .build()
        billingClient = client
        connect { }
    }

    private fun connect(onReady: (Boolean) -> Unit) {
        val client = billingClient
        if (client == null) {
            onReady(false)
            return
        }
        if (client.isReady) {
            onReady(true)
            return
        }
        client.startConnection(object : BillingClientStateListener {
            override fun onBillingSetupFinished(result: BillingResult) {
                val ok = result.responseCode == BillingClient.BillingResponseCode.OK
                if (!ok) Log.w(TAG, "Billing setup failed: ${result.debugMessage}")
                onReady(ok)
            }

            override fun onBillingServiceDisconnected() {
                Log.w(TAG, "Billing service disconnected")
            }
        })
    }

    /** Resolves `{ available, products: [...] }` for billing.js. */
    fun products(callback: (JSONObject) -> Unit) {
        connect { ready ->
            val client = billingClient
            if (!ready || client == null) {
                callback(JSONObject().put("available", false)
                    .put("error", "Google Play billing is unavailable on this device."))
                return@connect
            }
            val params = QueryProductDetailsParams.newBuilder()
                .setProductList(PRODUCT_IDS.map {
                    QueryProductDetailsParams.Product.newBuilder()
                        .setProductId(it)
                        .setProductType(BillingClient.ProductType.INAPP)
                        .build()
                })
                .build()
            client.queryProductDetailsAsync(params) { result, productDetailsResult ->
                if (result.responseCode != BillingClient.BillingResponseCode.OK) {
                    callback(JSONObject().put("available", true)
                        .put("error", "Top-ups are unavailable right now."))
                    return@queryProductDetailsAsync
                }
                val details = productDetailsResult.productDetailsList ?: emptyList()
                productCache = details
                val array = JSONArray()
                // Cheapest first — the smallest top-up leads, per the "show
                // the lowest amount first" decision.
                for (product in details.sortedBy { priceMicrosOf(it) }) {
                    val offer = product.oneTimePurchaseOfferDetails
                    array.put(
                        JSONObject()
                            .put("id", product.productId)
                            .put("title", product.title)
                            .put("description", product.description)
                            .put("price", offer?.formattedPrice ?: "")
                            .put("type", "one-time")
                    )
                }
                callback(JSONObject().put("available", true).put("products", array))
            }
        }
    }

    private fun priceMicrosOf(product: ProductDetails): Long =
        product.oneTimePurchaseOfferDetails?.priceAmountMicros ?: Long.MAX_VALUE

    /**
     * Launches Play's purchase sheet. Resolves the same shape the Apple bridge
     * does: `{ status, platform, receipt: { purchaseToken, productId } }`.
     */
    fun purchase(activity: Activity, productId: String, callback: (JSONObject) -> Unit) {
        connect { ready ->
            val client = billingClient
            if (!ready || client == null) {
                callback(failed("Google Play billing is unavailable on this device."))
                return@connect
            }
            val product = productCache.firstOrNull { it.productId == productId }
            if (product == null) {
                // The cache is filled by products(); a cold call has to fill it first.
                products {
                    val retry = productCache.firstOrNull { it.productId == productId }
                    if (retry == null) callback(failed("That top-up isn't available right now."))
                    else launchFlow(activity, client, retry, callback)
                }
                return@connect
            }
            launchFlow(activity, client, product, callback)
        }
    }

    private fun launchFlow(
        activity: Activity,
        client: BillingClient,
        product: ProductDetails,
        callback: (JSONObject) -> Unit
    ) {
        // Null only in the first seconds of a fresh install, while init()'s
        // worker asks Block Store whether a previous install left an id.
        // Buying under a stand-in id would put the credit where neither
        // install can find it.
        val accountId = peekAccountId(activity)
            ?: return callback(failed("Still getting ready. Try again in a moment."))
        pendingPurchaseCallback = callback
        val params = BillingFlowParams.newBuilder()
            // A consumable's purchase token isn't stable across repeat buys —
            // this is what the backend keys the credit balance by instead.
            .setObfuscatedAccountId(accountId)
            .setProductDetailsParamsList(
                listOf(
                    BillingFlowParams.ProductDetailsParams.newBuilder()
                        .setProductDetails(product)
                        .build()
                )
            )
            .build()
        val result = client.launchBillingFlow(activity, params)
        if (result.responseCode != BillingClient.BillingResponseCode.OK) {
            pendingPurchaseCallback = null
            callback(failed(result.debugMessage.ifEmpty { "Couldn't open Google Play." }))
        }
    }

    override fun onPurchasesUpdated(result: BillingResult, purchases: MutableList<Purchase>?) {
        val callback = pendingPurchaseCallback
        pendingPurchaseCallback = null
        when (result.responseCode) {
            BillingClient.BillingResponseCode.OK -> {
                val purchase = purchases?.firstOrNull { it.products.any { p -> p in PRODUCT_IDS } }
                if (purchase == null) {
                    callback?.invoke(failed("No purchase was returned."))
                    return
                }
                if (purchase.purchaseState == Purchase.PurchaseState.PENDING) {
                    callback?.invoke(JSONObject().put("status", "pending"))
                    return
                }
                creditThenConsume(purchase) { callback?.invoke(purchaseResult(purchase)) }
            }
            BillingClient.BillingResponseCode.USER_CANCELED ->
                callback?.invoke(JSONObject().put("status", "cancelled"))
            else ->
                callback?.invoke(failed(result.debugMessage.ifEmpty { "The purchase didn't complete." }))
        }
    }

    /**
     * Recovers a purchase that was bought but never durably credited (app
     * killed, offline at the time) — the consumable-appropriate meaning of
     * "restore," since Play's INAPP query only ever returns not-yet-consumed
     * purchases, not an ongoing plan.
     */
    fun restore(callback: (JSONObject) -> Unit) {
        connect { ready ->
            val client = billingClient
            if (!ready || client == null) {
                callback(JSONObject().put("status", "none")
                    .put("error", "Google Play billing is unavailable on this device."))
                return@connect
            }
            val params = QueryPurchasesParams.newBuilder()
                .setProductType(BillingClient.ProductType.INAPP)
                .build()
            client.queryPurchasesAsync(params) { result, purchases ->
                val owed = if (result.responseCode == BillingClient.BillingResponseCode.OK)
                    creditable(purchases) else emptyList()
                if (owed.isEmpty()) {
                    callback(JSONObject().put("status", "none")
                        .put("error", "No pending purchase found."))
                    return@queryPurchasesAsync
                }
                creditAll(owed, callback)
            }
        }
    }

    /**
     * Opens Play's own redemption screen for a promo code. Play has no
     * in-process redeem API for one-time products, so this is the documented
     * route: hand the user to the Play Store, where the grant is applied to
     * their Play account, and pick the resulting purchase up afterwards.
     *
     * Because the redemption happens in another app, there is no callback to
     * wait on — the granted purchase simply turns up in queryPurchasesAsync.
     * The caller re-runs restore() when the user comes back (see
     * WebAppInterface.billingRedeem), which is the same sweep that recovers an
     * interrupted purchase and credits it identically.
     */
    fun redeem(activity: Activity, callback: (JSONObject) -> Unit) {
        val route = openRedeemScreen(activity)
        if (route == null) {
            callback(failed("Couldn't open Google Play to redeem a code."))
            return
        }
        // Resolves as soon as the redemption screen is up, NOT when a grant
        // arrives. It used to wait for the poll below to finish, which meant
        // the paywall's button sat on "Opening…" for the poll's full two
        // minutes and then reported failure — while the user was in another
        // app entirely, and long after anything had finished opening. The
        // grant is picked up by the poll and by the sweep on resume; the UI's
        // job here is only to say where the user has been sent.
        callback(JSONObject().put("status", "opened").put("route", route))
        pollForRedeemedPurchase(0) { result ->
            if (result.optString("status") == "purchased") onBackgroundCredit?.invoke(result)
        }
    }

    // Where the user actually ended up. The redemption itself happens in
    // another app, so this is the only thing we can tell them for certain.
    private const val ROUTE_PLAY_APP = "play"
    private const val ROUTE_BROWSER = "browser"

    /**
     * Opens Play's redemption screen, preferring the Play Store app, and
     * reports which route was taken (null if neither could be opened).
     *
     * This used to try the Play-scoped intent and, on ANY exception, silently
     * retry unscoped — so a device that has the Play Store but whose Play
     * Store doesn't claim the /redeem URL landed in a web browser without a
     * word. That is worse than it sounds: the browser is often signed into a
     * different Google account than the device's Play Store, so the code is
     * granted to an account the app will never see, and queryPurchasesAsync
     * stays empty forever.
     *
     * Resolved deliberately rather than by catching ActivityNotFoundException,
     * so the fallback is a decision we report instead of an accident. Safe
     * against Android 11 package-visibility filtering because the app already
     * holds QUERY_ALL_PACKAGES (see AndroidManifest).
     */
    private fun openRedeemScreen(activity: Activity): String? {
        val uri = Uri.parse("https://play.google.com/redeem")
        val pm = activity.packageManager

        val playIntent = Intent(Intent.ACTION_VIEW, uri).setPackage(PLAY_STORE_PACKAGE)
        if (playIntent.resolveActivity(pm) != null) {
            try {
                activity.startActivity(playIntent)
                return ROUTE_PLAY_APP
            } catch (e: Exception) {
                Log.w(TAG, "Play Store resolved the redeem URL but wouldn't start: ${e.message}")
            }
        }

        val webIntent = Intent(Intent.ACTION_VIEW, uri)
        if (webIntent.resolveActivity(pm) != null) {
            try {
                activity.startActivity(webIntent)
                return ROUTE_BROWSER
            } catch (e: Exception) {
                Log.w(TAG, "Couldn't open Play redemption in a browser: ${e.message}")
            }
        }
        return null
    }

    // The redemption happens in the Play Store, in another process, so there
    // is nothing to await — the granted purchase just turns up in
    // queryPurchasesAsync some time after the user taps Redeem. Poll for it so
    // a grant that lands while the app is still alive is credited without the
    // user doing anything.
    //
    // Nothing waits on this any more: redeem() answers the UI immediately and
    // this runs on for its own two minutes underneath. It is a convenience,
    // not the guarantee — the guarantee is the sweep MainActivity.onResume
    // runs when the user comes back, which has no time limit and catches a
    // grant that lands after this has given up.
    private fun pollForRedeemedPurchase(attempt: Int, callback: (JSONObject) -> Unit) {
        if (attempt >= REDEEM_POLL_ATTEMPTS) {
            // Not a failure — a Play grant can land later, and the next
            // restore() sweep will credit it.
            callback(JSONObject().put("status", "none")
                .put("error", "No redeemed code has come through yet. It can take a moment — the credit will appear on its own."))
            return
        }
        Handler(Looper.getMainLooper()).postDelayed({
            val client = billingClient
            if (client == null || !client.isReady) {
                pollForRedeemedPurchase(attempt + 1, callback)
                return@postDelayed
            }
            val params = QueryPurchasesParams.newBuilder()
                .setProductType(BillingClient.ProductType.INAPP)
                .build()
            client.queryPurchasesAsync(params) { result, purchases ->
                val owed = if (result.responseCode == BillingClient.BillingResponseCode.OK)
                    creditable(purchases) else emptyList()
                if (owed.isEmpty()) {
                    pollForRedeemedPurchase(attempt + 1, callback)
                    return@queryPurchasesAsync
                }
                creditAll(owed, callback)
            }
        }, REDEEM_POLL_INTERVAL_MS)
    }

    // Every bought-and-unconsumed purchase of ours, not just the first. Taking
    // firstOrNull meant one purchase the backend kept refusing — a revoked
    // token, a product it no longer knows — sat at the head of the list and
    // stood in front of every purchase behind it, on every sweep, for good.
    private fun creditable(purchases: List<Purchase>): List<Purchase> =
        purchases.filter {
            it.purchaseState == Purchase.PurchaseState.PURCHASED &&
                it.products.any { p -> p in PRODUCT_IDS }
        }

    // Credits each in turn — one at a time, so two verifies never race for
    // the same balance — and answers once, after the last, with that one's
    // result: the same shape a single restored purchase always answered
    // with, and the web layer only needs it to know to refresh the balance.
    // A purchase the backend refused stays unconsumed for the next sweep,
    // as before; it just no longer holds the others back.
    private fun creditAll(owed: List<Purchase>, callback: (JSONObject) -> Unit) {
        fun next(index: Int) {
            val purchase = owed[index]
            creditThenConsume(purchase) {
                if (index + 1 < owed.size) next(index + 1) else callback(purchaseResult(purchase))
            }
        }
        next(0)
    }

    /**
     * The device-local UUID a balance is keyed by, handed to the web layer so
     * it can name the subject on a verify. A promo-redeemed purchase carries
     * no obfuscatedAccountId of its own — this is what gives that grant a
     * balance to land in, and it is the same value every bought purchase
     * already carries, so both end up in one balance.
     */
    fun accountToken(): String {
        val context = appContext ?: return ""
        return stableAccountId(context)
    }

    /** Local view of billing state; the backend balance stays the authority. */
    fun status(callback: (JSONObject) -> Unit) {
        callback(JSONObject().put("available", true).put("entitled", false))
    }

    // Verifies-and-credits against the backend first, then consumes only on
    // success — required for a consumable, or the product can never be
    // bought again by this user. If verification fails (offline, server
    // hiccup), it's left unconsumed so restore() can retry it later.
    private fun creditThenConsume(purchase: Purchase, onDone: () -> Unit) {
        val productId = purchase.products.firstOrNull() ?: ""
        verifyWithBackend(purchase, productId) { verified ->
            if (verified) consume(purchase)
            onDone()
        }
    }

    private fun verifyWithBackend(purchase: Purchase, productId: String, onResult: (Boolean) -> Unit) {
        Thread {
            var connection: HttpURLConnection? = null
            val ok = try {
                val url = URL("$DEFAULT_BACKEND_URL/v1/entitlement/verify")
                connection = url.openConnection() as HttpURLConnection
                connection.requestMethod = "POST"
                connection.doOutput = true
                // Without these a backend that accepts the connection and then
                // says nothing holds this thread — and the purchase's
                // "pending" — forever. Unconsumed is the safe failure: the
                // next restore() sweep tries again.
                connection.connectTimeout = VERIFY_TIMEOUT_MS
                connection.readTimeout = VERIFY_TIMEOUT_MS
                connection.setRequestProperty("Content-Type", "application/json")
                // A device that recovered its balance by code holds a live
                // token for that balance, while its own account id still names
                // the empty one it minted on reinstall. The backend lets a
                // valid same-platform bearer name the subject a top-up lands
                // in (see bearerSubjectFor in server/src/app.js), and ignores
                // one that is stale or forged — so sending it whenever there
                // is one costs nothing, and without it the top-up they just
                // paid for went to the empty balance.
                entitlementToken()?.let { connection.setRequestProperty("Authorization", "Bearer $it") }
                val body = JSONObject()
                    .put("platform", "google")
                    // Only *used* by the backend when the purchase has no
                    // obfuscatedAccountId of its own (a redeemed promo code);
                    // for a bought one Play's own value wins and this is
                    // ignored.
                    .put("accountToken", accountToken())
                    .put(
                        "receipt",
                        JSONObject()
                            .put("purchaseToken", purchase.purchaseToken)
                            .put("productId", productId)
                    )
                connection.outputStream.use { it.write(body.toString().toByteArray()) }
                connection.responseCode == 200
            } catch (e: Exception) {
                Log.w(TAG, "Backend verify failed: ${e.message}")
                false
            } finally {
                connection?.disconnect()
            }
            onResult(ok)
        }.start()
    }

    // The entitlement token background.js saved (saveEntitlement), read
    // straight out of the storage it shares with this process — objects are
    // kept there as plain JSON (BackgroundJsHelper.setSharedStorage).
    private fun entitlementToken(): String? {
        val context = appContext ?: return null
        return try {
            val raw = context.getSharedPreferences(SharedState.PREFS, Context.MODE_PRIVATE)
                .getString("entitlement", null) ?: return null
            val entitlement = org.json.JSONTokener(raw).nextValue() as? JSONObject ?: return null
            entitlement.optString("token").trim().takeIf { it.isNotEmpty() }
        } catch (e: Exception) {
            null
        }
    }

    // Both consumes and acknowledges in one call — required for a consumable
    // (unlike a subscription, acknowledging alone leaves it permanently
    // "owned" and unpurchasable again).
    private fun consume(purchase: Purchase) {
        val params = ConsumeParams.newBuilder()
            .setPurchaseToken(purchase.purchaseToken)
            .build()
        billingClient?.consumeAsync(params) { result, _ ->
            if (result.responseCode != BillingClient.BillingResponseCode.OK) {
                Log.w(TAG, "Consume failed: ${result.debugMessage}")
            }
        }
    }

    /**
     * The id without blocking: what is settled or already in prefs, else null
     * while init()'s worker is still asking Block Store. For the main thread,
     * which must never wait on that lookup.
     */
    private fun peekAccountId(context: Context): String? =
        settledAccountId ?: context.getSharedPreferences(BILLING_PREFS, Context.MODE_PRIVATE)
            .getString("account_id", null)

    /**
     * Blocks for up to a few Block Store lookups on a fresh install, so it is
     * never called on the main thread — launchFlow uses peekAccountId. The
     * lock is not held by anyone who already has an answer: settledAccountId
     * is set before the Block Store mirror below does its own I/O.
     */
    private fun stableAccountId(context: Context): String {
        settledAccountId?.let { return it }
        synchronized(accountIdLock) {
            settledAccountId?.let { return it }
            val prefs = context.getSharedPreferences(BILLING_PREFS, Context.MODE_PRIVATE)
            prefs.getString("account_id", null)?.let { existing ->
                settledAccountId = existing
                mirrorToBlockStore(context, prefs, existing, prefs.getLong("account_id_minted_at", 0L))
                return existing
            }
            var lookup = lookUpBlockStore(context)
            if (lookup is BlockStoreLookup.Unknown) lookup = lookUpBlockStore(context)
            if (lookup is BlockStoreLookup.Found) {
                // Carries the ORIGINAL install's stamp, exactly as an Auto
                // Backup restore does, so accountTokenRestored() answers from
                // the same timestamp comparison either way. An id that
                // predates the stamp comes back without one and stays "cannot
                // tell".
                val edit = prefs.edit().putString("account_id", lookup.id)
                if (lookup.mintedAt > 0L) edit.putLong("account_id_minted_at", lookup.mintedAt)
                edit.apply()
                blockStoreSynced = true
                settledAccountId = lookup.id
                return lookup.id
            }
            val newId = UUID.randomUUID().toString()
            val now = System.currentTimeMillis()
            // Stamped only when the id is minted, never on a read, and never
            // back-filled onto an id that predates this field. Back-filling
            // would set it to "now" for someone who has had the same id for
            // months and so make accountTokenRestored() below call their
            // perfectly good account freshly minted forever after. An id with
            // no stamp is the honest "we cannot tell" case and is treated as
            // such.
            val edit = prefs.edit()
                .putString("account_id", newId)
                .putLong("account_id_minted_at", now)
            // Block Store couldn't be read, which is not the same as empty: it
            // may still hold a previous install's id, and writing this one
            // over it would orphan that balance for good — the one thing this
            // exists to prevent. Hold the write until a lookup proves it empty.
            if (lookup is BlockStoreLookup.Unknown) edit.putBoolean(PREF_BLOCKSTORE_UNCONFIRMED, true)
            edit.apply()
            settledAccountId = newId
            if (lookup is BlockStoreLookup.Empty) saveToBlockStore(context, newId, now)
            return newId
        }
    }

    // Mirrored once per process rather than once ever: it back-fills every id
    // that predates Block Store, and a persisted "done" flag would ride Auto
    // Backup onto a new device whose Block Store is empty and stop the write
    // ever happening there. An id minted while Block Store was unreadable is
    // only written once a lookup finds the slot empty (or already ours); if it
    // holds a different id, that one is left alone for a future reinstall.
    private fun mirrorToBlockStore(context: Context, prefs: SharedPreferences, id: String, mintedAt: Long) {
        if (blockStoreSynced) return
        if (!prefs.getBoolean(PREF_BLOCKSTORE_UNCONFIRMED, false)) {
            saveToBlockStore(context, id, mintedAt)
            return
        }
        when (val lookup = lookUpBlockStore(context)) {
            is BlockStoreLookup.Empty -> {
                prefs.edit().remove(PREF_BLOCKSTORE_UNCONFIRMED).apply()
                saveToBlockStore(context, id, mintedAt)
            }
            is BlockStoreLookup.Found -> {
                if (lookup.id == id) prefs.edit().remove(PREF_BLOCKSTORE_UNCONFIRMED).apply()
                blockStoreSynced = true
            }
            is BlockStoreLookup.Unknown -> Unit
        }
    }

    private sealed class BlockStoreLookup {
        data class Found(val id: String, val mintedAt: Long) : BlockStoreLookup()
        object Empty : BlockStoreLookup()
        // Play services missing, slow or erroring: says nothing about the slot.
        object Unknown : BlockStoreLookup()
    }

    /** What a previous install of this app left in Block Store. Blocks. */
    private fun lookUpBlockStore(context: Context): BlockStoreLookup {
        if (Looper.myLooper() == Looper.getMainLooper()) return BlockStoreLookup.Unknown
        return try {
            val request = RetrieveBytesRequest.Builder()
                .setKeys(listOf(BLOCKSTORE_ACCOUNT_KEY))
                .build()
            val response = Tasks.await(
                Blockstore.getClient(context).retrieveBytes(request),
                BLOCKSTORE_TIMEOUT_SECONDS, TimeUnit.SECONDS
            )
            val bytes = response.blockstoreDataMap[BLOCKSTORE_ACCOUNT_KEY]?.bytes
                ?: return BlockStoreLookup.Empty
            val stored = JSONObject(String(bytes, Charsets.UTF_8))
            val id = stored.optString("id").takeIf { it.isNotBlank() }
                ?: return BlockStoreLookup.Empty
            BlockStoreLookup.Found(id, stored.optLong("mintedAt", 0L))
        } catch (e: Exception) {
            Log.w(TAG, "Block Store lookup failed: ${e.message}")
            BlockStoreLookup.Unknown
        }
    }

    private fun saveToBlockStore(context: Context, id: String, mintedAt: Long) {
        try {
            val stored = JSONObject().put("id", id)
            if (mintedAt > 0L) stored.put("mintedAt", mintedAt)
            val data = StoreBytesData.Builder()
                .setBytes(stored.toString().toByteArray(Charsets.UTF_8))
                .setKey(BLOCKSTORE_ACCOUNT_KEY)
                // Also carried to a new phone when the user restores from
                // their Google backup.
                .setShouldBackupToCloud(true)
                .build()
            Blockstore.getClient(context).storeBytes(data)
                .addOnSuccessListener { blockStoreSynced = true }
                .addOnFailureListener { e -> Log.w(TAG, "Block Store save failed: ${e.message}") }
        } catch (e: Exception) {
            Log.w(TAG, "Block Store unavailable: ${e.message}")
        }
    }

    /**
     * Did this device's account id arrive from a backup or a device transfer,
     * rather than being minted here?
     *
     * It matters because the id is the only durable link between a device and
     * a paid balance: a top-up is a consumable, consumed the moment it is
     * credited, so Play will never re-report it and there is nothing else left
     * to prove the purchase with. If the id came back, silent recovery
     * (`POST /v1/entitlement/recover`) will find the balance. If we minted it
     * on this install, the old balance is still on the server but nothing on
     * this device can name it, and only the written-down recovery code can
     * reach it.
     *
     * The comparison is `minted_at < firstInstallTime`. Auto Backup restores
     * the whole of intention_billing.xml, so a restored id brings the ORIGINAL
     * device's timestamp with it, which is necessarily older than this
     * install; an id minted here is stamped seconds after the install and so
     * is necessarily newer. An app *update* leaves firstInstallTime alone,
     * which is what we want — an update restores nothing and changes nothing.
     *
     * The honest gap this exists to detect: Auto Backup runs roughly daily, on
     * Wi-Fi, charging and idle, and restores only at install time. A same-day
     * uninstall-and-reinstall will not have a restored id, and no amount of
     * cleverness here changes that — which is precisely why the answer is
     * reported rather than papered over.
     *
     * The answer is genuinely three-valued, so the return type is too. `null`
     * is "cannot tell", and there are three honest ways to get there: no
     * context yet, no stamp because the id predates this field (which is EVERY
     * install that existed before the release adding it, since stableAccountId
     * stamps only on mint and nothing back-fills), and PackageManager refusing
     * to answer. `true` is an assertion that something put the id back, and
     * `false` an assertion that it was minted here; both are only ever
     * returned when the timestamps actually say so.
     *
     * Collapsing "cannot tell" into `true` — which is what this used to do —
     * is not the conservative direction, it is a claim. shared/billing.js's
     * storeAccountRestored() is explicit that `undefined` means "this build
     * cannot tell" and that every caller must treat it as "say nothing" rather
     * than as false; Apple's bridge already answers that way by omitting the
     * field. Today's only consumer tests `accountRestored === false`, so a
     * wrong `true` merely fails soft — but the first caller to write
     * `if (accountRestored)` would tell every install predating this field
     * that its account had been restored from a backup that never existed.
     *
     * `null` reaches the web layer as an ABSENT key, not as JSON null:
     * WebAppInterface builds the reply with `JSONObject.put(String, Object)`,
     * which removes the mapping when the value is null rather than storing
     * one. So the wire shape for "cannot tell" is `{"token":"..."}` —
     * byte-identical to what Apple's accountToken() sends, and read back as
     * `undefined` by storeAccountRestored(). That is also why this fix needs
     * no change at the call site, and why an older web layer that reads only
     * `token` is unaffected.
     */
    fun accountTokenRestored(): Boolean? {
        val context = appContext ?: return null
        val prefs = context.getSharedPreferences(BILLING_PREFS, Context.MODE_PRIVATE)
        val mintedAt = prefs.getLong("account_id_minted_at", 0L)
        if (mintedAt <= 0L) return null
        return try {
            val info = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                context.packageManager.getPackageInfo(
                    context.packageName,
                    PackageManager.PackageInfoFlags.of(0L)
                )
            } else {
                @Suppress("DEPRECATION")
                context.packageManager.getPackageInfo(context.packageName, 0)
            }
            mintedAt < info.firstInstallTime
        } catch (e: PackageManager.NameNotFoundException) {
            // Our own package always exists, so this is unreachable in
            // practice; if the platform ever disagrees, say "cannot tell".
            Log.w(TAG, "Could not read firstInstallTime: ${e.message}")
            null
        }
    }

    private fun purchaseResult(purchase: Purchase): JSONObject =
        JSONObject()
            .put("status", "purchased")
            .put("platform", "google")
            .put(
                "receipt",
                JSONObject()
                    .put("purchaseToken", purchase.purchaseToken)
                    .put("productId", purchase.products.firstOrNull() ?: "")
            )

    private fun failed(message: String): JSONObject =
        JSONObject().put("status", "failed").put("error", message)
}
