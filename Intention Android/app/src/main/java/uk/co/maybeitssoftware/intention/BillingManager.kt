package uk.co.maybeitssoftware.intention

import android.app.Activity
import android.content.Context
import android.util.Log
import com.android.billingclient.api.AcknowledgePurchaseParams
import com.android.billingclient.api.BillingClient
import com.android.billingclient.api.BillingClientStateListener
import com.android.billingclient.api.BillingFlowParams
import com.android.billingclient.api.BillingResult
import com.android.billingclient.api.ProductDetails
import com.android.billingclient.api.Purchase
import com.android.billingclient.api.PurchasesUpdatedListener
import com.android.billingclient.api.QueryProductDetailsParams
import com.android.billingclient.api.QueryPurchasesParams
import org.json.JSONArray
import org.json.JSONObject

/**
 * Google Play Billing wrapper for Intention Pro — the subscription that turns
 * on the built-in coach.
 *
 * This mirrors IntentionStore.swift on Apple: the web layer (billing.js) sees
 * a `window.intentionBilling` object, and every purchase it can make goes
 * through Play. The purchase token that comes back is verified server-side
 * (Play Developer API) before any coaching call is allowed, so a tampered
 * client can't mint itself access.
 */
object BillingManager : PurchasesUpdatedListener {

    private const val TAG = "IntentionBilling"

    const val PRODUCT_MONTHLY = "intention_pro_monthly"
    const val PRODUCT_YEARLY = "intention_pro_yearly"
    private val PRODUCT_IDS = listOf(PRODUCT_MONTHLY, PRODUCT_YEARLY)

    private var billingClient: BillingClient? = null
    private var productCache: List<ProductDetails> = emptyList()

    // A purchase arrives asynchronously through onPurchasesUpdated, long after
    // launchBillingFlow returns, so the JS callback waiting on it is parked
    // here until Play answers.
    private var pendingPurchaseCallback: ((JSONObject) -> Unit)? = null

    fun init(context: Context) {
        if (billingClient != null) return
        val client = BillingClient.newBuilder(context.applicationContext)
            .setListener(this)
            .enablePendingPurchases()
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
                        .setProductType(BillingClient.ProductType.SUBS)
                        .build()
                })
                .build()
            client.queryProductDetailsAsync(params) { result, details ->
                if (result.responseCode != BillingClient.BillingResponseCode.OK) {
                    callback(JSONObject().put("available", true)
                        .put("error", "Plans are unavailable right now."))
                    return@queryProductDetailsAsync
                }
                productCache = details
                val array = JSONArray()
                for (product in details.sortedBy { priceMicrosOf(it) }) {
                    val offer = product.subscriptionOfferDetails?.firstOrNull()
                    val phase = offer?.pricingPhases?.pricingPhaseList?.firstOrNull()
                    array.put(
                        JSONObject()
                            .put("id", product.productId)
                            .put("title", product.title)
                            .put("description", product.description)
                            .put("price", phase?.formattedPrice ?: "")
                            .put("period", periodLabel(phase?.billingPeriod))
                            .put("type", "subscription")
                    )
                }
                callback(JSONObject().put("available", true).put("products", array))
            }
        }
    }

    private fun priceMicrosOf(product: ProductDetails): Long =
        product.subscriptionOfferDetails
            ?.firstOrNull()
            ?.pricingPhases?.pricingPhaseList?.firstOrNull()
            ?.priceAmountMicros ?: Long.MAX_VALUE

    // ISO-8601 billing periods ("P1M", "P1Y") read as gibberish in a paywall.
    private fun periodLabel(period: String?): String {
        if (period.isNullOrEmpty()) return ""
        val match = Regex("^P(\\d+)([DWMY])$").find(period) ?: return ""
        val count = match.groupValues[1].toIntOrNull() ?: return ""
        val unit = when (match.groupValues[2]) {
            "D" -> "day"
            "W" -> "week"
            "M" -> "month"
            "Y" -> "year"
            else -> return ""
        }
        return if (count == 1) unit else "$count ${unit}s"
    }

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
                    if (retry == null) callback(failed("That plan isn't available right now."))
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
        val offerToken = product.subscriptionOfferDetails?.firstOrNull()?.offerToken
        if (offerToken == null) {
            callback(failed("That plan isn't available right now."))
            return
        }
        pendingPurchaseCallback = callback
        val params = BillingFlowParams.newBuilder()
            .setProductDetailsParamsList(
                listOf(
                    BillingFlowParams.ProductDetailsParams.newBuilder()
                        .setProductDetails(product)
                        .setOfferToken(offerToken)
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
                acknowledge(purchase)
                if (purchase.purchaseState == Purchase.PurchaseState.PENDING) {
                    callback?.invoke(JSONObject().put("status", "pending"))
                } else {
                    callback?.invoke(purchaseResult(purchase))
                }
            }
            BillingClient.BillingResponseCode.USER_CANCELED ->
                callback?.invoke(JSONObject().put("status", "cancelled"))
            else ->
                callback?.invoke(failed(result.debugMessage.ifEmpty { "The purchase didn't complete." }))
        }
    }

    /** Re-reads what this Google account already owns. */
    fun restore(callback: (JSONObject) -> Unit) {
        connect { ready ->
            val client = billingClient
            if (!ready || client == null) {
                callback(JSONObject().put("status", "none")
                    .put("error", "Google Play billing is unavailable on this device."))
                return@connect
            }
            val params = QueryPurchasesParams.newBuilder()
                .setProductType(BillingClient.ProductType.SUBS)
                .build()
            client.queryPurchasesAsync(params) { result, purchases ->
                val purchase = purchases.firstOrNull {
                    it.purchaseState == Purchase.PurchaseState.PURCHASED &&
                        it.products.any { p -> p in PRODUCT_IDS }
                }
                if (result.responseCode != BillingClient.BillingResponseCode.OK || purchase == null) {
                    callback(JSONObject().put("status", "none")
                        .put("error", "No previous purchase found on this Google account."))
                    return@queryPurchasesAsync
                }
                acknowledge(purchase)
                callback(purchaseResult(purchase))
            }
        }
    }

    /** Local view of the subscription; the backend stays the authority. */
    fun status(callback: (JSONObject) -> Unit) {
        restore { result ->
            val entitled = result.optString("status") == "purchased"
            val out = JSONObject().put("available", true).put("entitled", entitled)
            if (entitled) {
                out.put("platform", "google")
                out.put("receipt", result.opt("receipt"))
            }
            callback(out)
        }
    }

    // Play auto-refunds an unacknowledged purchase after three days, so this
    // has to happen whether or not the backend verification round-trip works.
    private fun acknowledge(purchase: Purchase) {
        if (purchase.isAcknowledged || purchase.purchaseState != Purchase.PurchaseState.PURCHASED) return
        val params = AcknowledgePurchaseParams.newBuilder()
            .setPurchaseToken(purchase.purchaseToken)
            .build()
        billingClient?.acknowledgePurchase(params) { result ->
            if (result.responseCode != BillingClient.BillingResponseCode.OK) {
                Log.w(TAG, "Acknowledge failed: ${result.debugMessage}")
            }
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
