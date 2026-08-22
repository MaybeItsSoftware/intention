package uk.co.maybeitssoftware.intention

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.net.Uri
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
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.util.UUID

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

    // How long redeem() waits for a Play-side grant to show up (~2 minutes).
    private const val REDEEM_POLL_INTERVAL_MS = 2_000L
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

    fun init(context: Context) {
        appContext = context.applicationContext
        if (billingClient != null) return
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
        pendingPurchaseCallback = callback
        val params = BillingFlowParams.newBuilder()
            // A consumable's purchase token isn't stable across repeat buys —
            // this is what the backend keys the credit balance by instead.
            .setObfuscatedAccountId(stableAccountId(activity))
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
                val purchase = purchases.firstOrNull {
                    it.purchaseState == Purchase.PurchaseState.PURCHASED &&
                        it.products.any { p -> p in PRODUCT_IDS }
                }
                if (result.responseCode != BillingClient.BillingResponseCode.OK || purchase == null) {
                    callback(JSONObject().put("status", "none")
                        .put("error", "No pending purchase found."))
                    return@queryPurchasesAsync
                }
                creditThenConsume(purchase) { callback(purchaseResult(purchase)) }
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
        pollForRedeemedPurchase(0) { }
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
                val purchase = purchases.firstOrNull {
                    it.purchaseState == Purchase.PurchaseState.PURCHASED &&
                        it.products.any { p -> p in PRODUCT_IDS }
                }
                if (result.responseCode != BillingClient.BillingResponseCode.OK || purchase == null) {
                    pollForRedeemedPurchase(attempt + 1, callback)
                    return@queryPurchasesAsync
                }
                creditThenConsume(purchase) { callback(purchaseResult(purchase)) }
            }
        }, REDEEM_POLL_INTERVAL_MS)
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
            val ok = try {
                val url = URL("$DEFAULT_BACKEND_URL/v1/entitlement/verify")
                val connection = url.openConnection() as HttpURLConnection
                connection.requestMethod = "POST"
                connection.doOutput = true
                connection.setRequestProperty("Content-Type", "application/json")
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
            }
            onResult(ok)
        }.start()
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

    private fun stableAccountId(context: Context): String {
        val prefs = context.getSharedPreferences("intention_billing", Context.MODE_PRIVATE)
        prefs.getString("account_id", null)?.let { return it }
        val newId = UUID.randomUUID().toString()
        prefs.edit().putString("account_id", newId).apply()
        return newId
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
