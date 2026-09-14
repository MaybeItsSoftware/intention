package uk.co.maybeitssoftware.intention

import android.app.Activity
import android.app.AppOpsManager
import android.app.usage.UsageEvents
import android.app.usage.UsageStatsManager
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.drawable.Drawable
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.Process
import android.provider.Settings
import android.util.Base64
import android.util.Log
import android.webkit.JavascriptInterface
import android.webkit.WebView
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Date
import java.util.Locale

class WebAppInterface(
    private val context: Context,
    private val webView: WebView,
    private val onClose: (() -> Unit)? = null
) {

    @JavascriptInterface
    fun getStorage(keysJson: String, callbackId: String) {
        val result = BackgroundJsHelper.getSharedStorage(context, keysJson)
        runOnJs("window.AndroidCallbacks.invoke(${JSONObject.quote(callbackId)},${JSONObject.quote(result)})")
    }

    @JavascriptInterface
    fun setStorage(itemsJson: String, callbackId: String) {
        BackgroundJsHelper.setSharedStorage(context, itemsJson)
        runOnJs("window.AndroidCallbacks.invoke(${JSONObject.quote(callbackId)},'{}')")
    }

    @JavascriptInterface
    fun sendMessage(messageJson: String, callbackId: String) {
        try {
            val json = JSONObject(messageJson)
            val action = json.optString("action")
            if (action == "closeCurrentTab") {
                onClose?.invoke()
                runOnJs("window.AndroidCallbacks.invoke(${JSONObject.quote(callbackId)},'{\"ok\":true}')")
                return
            }
            // The shared handler routes this through chrome.tabs/openOptionsPage,
            // neither of which exists on Android — bring up MainActivity, which
            // hosts the same options page, instead of silently doing nothing.
            if (action == "openOptions") {
                openOptions(json.optString("section").takeIf { it.isNotEmpty() })
                runOnJs("window.AndroidCallbacks.invoke(${JSONObject.quote(callbackId)},'{\"ok\":true}')")
                return
            }
            // ---- Leaving Intention: the two places the shared code asks a
            // question only the host can answer ----------------------------
            //
            // background.js's completeRemoval() ends in
            // chrome.management.uninstallSelf(), which does not exist on
            // Android and would not be the right verb if it did: removal here
            // is an OS-level uninstall of the whole app, not the retirement of
            // an extension. So the message is still FORWARDED first — that is
            // what writes the fifteen-minute stand-down, through the same
            // beginLeave() the browser build uses, and keeping that one
            // definition is worth more than the round trip costs — and the
            // removal itself is then performed with the system uninstaller.
            //
            // Ordering matters for the same reason it does in the JS: the
            // stand-down is recorded BEFORE the uninstaller appears, so a user
            // who reads the system's "are you sure" and decides not to is not
            // met by the same conversation the moment they walk back into
            // Settings.
            if (action == "completeRemoval") {
                BackgroundJsHelper.sendMessage(messageJson) { _ ->
                    requestUninstall()
                    runOnJs("window.AndroidCallbacks.invoke(${JSONObject.quote(callbackId)},'{\"ok\":true}')")
                }
                return
            }
            // canSelfUninstall is background.js asking "can this build remove
            // itself?", and it answers false on Android purely because the
            // background WebView's chrome shim has no management namespace.
            // On this platform the honest answer is yes — the line above is
            // how — and it has to be true or the leaving card renders the
            // "remove it from your device's own settings" note instead of the
            // button that starts the conversation. Patched on the way out
            // rather than in shared/options.js, which this package does not
            // own; see the handoff note in android-bridge.js.
            if (action == "getLeaveState") {
                BackgroundJsHelper.sendMessage(messageJson) { response ->
                    runOnJs(
                        "window.AndroidCallbacks.invoke(" +
                            "${JSONObject.quote(callbackId)}," +
                            "${JSONObject.quote(withNativeUninstall(response))})"
                    )
                }
                return
            }
        } catch (e: Exception) {}

        BackgroundJsHelper.sendMessage(messageJson) { response ->
            runOnJs("window.AndroidCallbacks.invoke(${JSONObject.quote(callbackId)},${JSONObject.quote(response ?: "")})")
        }
    }

    // ---- In-app purchases (Google Play Billing) ----
    //
    // Mirrors the Apple bridge in ios-bridge.js: billing.js sees the same
    // window.intentionBilling shape on both platforms, so the paywall itself is
    // platform-agnostic. Purchases can only happen through Play from here.

    @JavascriptInterface
    fun billingProducts(callbackId: String) {
        BillingManager.products { result -> respond(callbackId, result) }
    }

    @JavascriptInterface
    fun billingPurchase(productId: String, callbackId: String) {
        val activity = context as? Activity
        if (activity == null) {
            respond(callbackId, JSONObject().put("status", "failed")
                .put("error", "Purchases can only be started from the Intention app."))
            return
        }
        Handler(Looper.getMainLooper()).post {
            BillingManager.purchase(activity, productId) { result -> respond(callbackId, result) }
        }
    }

    @JavascriptInterface
    fun billingRestore(callbackId: String) {
        BillingManager.restore { result -> respond(callbackId, result) }
    }

    // Hands off to Play's own redemption screen and waits for the grant to
    // come back through queryPurchasesAsync. Needs the Activity for the same
    // reason a purchase does — it starts an activity.
    @JavascriptInterface
    fun billingRedeem(callbackId: String) {
        val activity = context as? Activity
        if (activity == null) {
            respond(callbackId, JSONObject().put("status", "failed")
                .put("error", "Codes can only be redeemed from the Intention app."))
            return
        }
        Handler(Looper.getMainLooper()).post {
            BillingManager.redeem(activity) { result -> respond(callbackId, result) }
        }
    }

    // The device-local UUID a balance is keyed by. billing.js sends it on
    // every verify so a redeemed code — which carries no obfuscatedAccountId
    // of its own — has a balance to land in.
    //
    // `restored` rides alongside it and says whether that UUID came back from
    // a backup or was minted on this install. Silent recovery is attempted
    // either way; the field only decides what the web layer says when recovery
    // finds nothing — "no credit here" versus "this looks like a fresh install
    // and the backup has not caught up, use your recovery code". Additive on
    // purpose: an older web layer reads only `token` and is unaffected by the
    // extra key.
    //
    // Order matters. accountToken() mints the id if there is none, stamping
    // account_id_minted_at as it goes; asking whether it was restored has to
    // happen after that, or a first-ever call would ask about an id that does
    // not exist yet. Hence two statements rather than one chained expression.
    @JavascriptInterface
    fun billingAccountToken(callbackId: String) {
        val token = BillingManager.accountToken()
        respond(
            callbackId,
            JSONObject()
                .put("token", token)
                .put("restored", BillingManager.accountTokenRestored())
        )
    }

    @JavascriptInterface
    fun billingStatus(callbackId: String) {
        BillingManager.status { result -> respond(callbackId, result) }
    }

    // No-op: a consumable top-up has nothing to manage/cancel. Kept as a stub
    // purely so android-bridge.js/billing.js's `manage` call still resolves
    // without needing a bridge contract change.
    @JavascriptInterface
    fun billingManage(callbackId: String) {
        respond(callbackId, JSONObject().put("ok", true))
    }

    private fun respond(callbackId: String, payload: JSONObject) {
        runOnJs("window.AndroidCallbacks.invoke(${JSONObject.quote(callbackId)},${JSONObject.quote(payload.toString())})")
    }

    @JavascriptInterface
    fun getInstalledApps(callbackId: String) {
        val pm = context.packageManager
        val launcherIntent = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER)
        val apps = pm.queryIntentActivities(launcherIntent, 0)
            .map { it.activityInfo.packageName }
            .distinct()
            .filter { it != context.packageName }
            .mapNotNull { pkg ->
                try {
                    val info = pm.getApplicationInfo(pkg, 0)
                    val icon = try {
                        drawableToBase64Png(pm.getApplicationIcon(info))
                    } catch (e: Exception) {
                        ""
                    }
                    Triple(pkg, pm.getApplicationLabel(info).toString(), icon)
                } catch (e: Exception) {
                    null
                }
            }
            .sortedBy { it.second.lowercase() }
        val array = JSONArray()
        for ((pkg, label, icon) in apps) {
            array.put(JSONObject().put("packageName", pkg).put("label", label).put("icon", icon))
        }
        runOnJs("window.AndroidCallbacks.invoke(${JSONObject.quote(callbackId)},${JSONObject.quote(array.toString())})")
    }

    /**
     * The exit, and it has to work.
     *
     * ACTION_DELETE with a `package:` Uri raises the system's own uninstall
     * confirmation — the OS asks, the OS removes, and Intention is not in the
     * loop for either. That system dialog IS the friction here, and it is
     * exactly the right amount: the conversation has already happened by the
     * time anything calls this.
     *
     * The fallback is App info rather than nothing. ACTION_DELETE is honoured
     * by AOSP and every skin I can find, but it is not a contract, and a ROM
     * that declines to handle it must not leave the user staring at a button
     * that silently did nothing — App info is one tap from Uninstall on every
     * Android there has ever been. ACTION_UNINSTALL_PACKAGE is deliberately
     * not the fallback: it was deprecated in API 29 and needs
     * REQUEST_DELETE_PACKAGES, a permission to ask for on the strength of a
     * ROM we have never seen.
     */
    @JavascriptInterface
    fun requestUninstall() {
        val uninstall = Intent(Intent.ACTION_DELETE, Uri.fromParts("package", context.packageName, null))
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        Handler(Looper.getMainLooper()).post {
            try {
                context.startActivity(uninstall)
            } catch (e: Exception) {
                Log.w("WebAppInterface", "ACTION_DELETE was refused; falling back to App info", e)
                try {
                    context.startActivity(
                        Intent(
                            Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                            Uri.fromParts("package", context.packageName, null)
                        ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    )
                } catch (e2: Exception) {
                    Log.e("WebAppInterface", "Could not open the uninstaller: ", e2)
                }
            }
        }
    }

    // getLeaveState's answer with canSelfUninstall corrected for this host.
    // Anything unparseable, or an error response, is passed through untouched:
    // a leaving card that renders one degree too cautiously is a far better
    // failure than one that throws while somebody is trying to leave.
    private fun withNativeUninstall(response: String?): String {
        if (response.isNullOrEmpty()) return response ?: ""
        return try {
            val json = JSONObject(response)
            if (json.has("error")) response else json.put("canSelfUninstall", true).toString()
        } catch (e: Exception) {
            response
        }
    }

    private fun openOptions(section: String? = null) {
        val intent = Intent(context, MainActivity::class.java).apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            if (section != null) putExtra("section", section)
        }
        Handler(Looper.getMainLooper()).post {
            context.startActivity(intent)
            if (context is CoachingActivity) {
                context.finish()
            }
        }
    }

    private fun drawableToBase64Png(drawable: Drawable, size: Int = 64): String {
        val bitmap = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(bitmap)
        drawable.setBounds(0, 0, size, size)
        drawable.draw(canvas)
        val stream = ByteArrayOutputStream()
        bitmap.compress(Bitmap.CompressFormat.PNG, 100, stream)
        bitmap.recycle()
        return "data:image/png;base64," + Base64.encodeToString(stream.toByteArray(), Base64.NO_WRAP)
    }

    @JavascriptInterface
    fun launchApp(packageName: String) {
        val launchIntent = context.packageManager.getLaunchIntentForPackage(packageName) ?: return
        launchIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        Handler(Looper.getMainLooper()).post {
            context.startActivity(launchIntent)
            if (context is CoachingActivity) {
                context.finish()
            }
        }
    }

    // Usage Access is a special-access permission (no runtime dialog) — the
    // user grants it via Settings, mirrored to shared/options.js the same way
    // as the Accessibility gate in MainActivity.
    @JavascriptInterface
    fun hasUsageAccess(): Boolean {
        val appOps = context.getSystemService(Context.APP_OPS_SERVICE) as AppOpsManager
        val mode = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            appOps.unsafeCheckOpNoThrow(AppOpsManager.OPSTR_GET_USAGE_STATS, Process.myUid(), context.packageName)
        } else {
            @Suppress("DEPRECATION")
            appOps.checkOpNoThrow(AppOpsManager.OPSTR_GET_USAGE_STATS, Process.myUid(), context.packageName)
        }
        return mode == AppOpsManager.MODE_ALLOWED
    }

    @JavascriptInterface
    fun openUsageAccessSettings() {
        val intent = Intent(Settings.ACTION_USAGE_ACCESS_SETTINGS)
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        context.startActivity(intent)
    }

    // The gate's seven-day strip for one blocked app (gate-ui.js's
    // loadUsageHistory, via coaching.js). Resolves
    //   { granted: false }                                   no Usage Access
    //   { granted: true, days: [{ date, minutes }, ...] }    oldest first, ending today
    //
    // Foreground time is rebuilt from queryEvents rather than read from
    // queryUsageStats(INTERVAL_DAILY): see ForegroundTime for why the daily
    // buckets cannot be trusted to mean a calendar day. Same privacy posture as
    // getAppUsageStats below: only a package the user has blocked is answered
    // for, so the page cannot use this to read the rest of the device.
    //
    // @JavascriptInterface calls arrive on a WebView binder thread, not the main
    // thread, so a week of events is read here without blocking the UI.
    @JavascriptInterface
    fun getAppUsageHistory(packageName: String, days: Int, callbackId: String) {
        val payload = JSONObject()
        try {
            if (!hasUsageAccess()) {
                payload.put("granted", false)
            } else {
                payload.put("granted", true)
                val count = days.coerceIn(1, 14)
                val fmt = SimpleDateFormat("yyyy-MM-dd", Locale.US)
                val now = System.currentTimeMillis()
                // Local midnights, oldest first. Calendar, not fixed 24h steps,
                // so a DST change lands the boundary on the real midnight.
                val dayStarts = LongArray(count)
                val cal = Calendar.getInstance()
                for (i in 0 until count) {
                    cal.timeInMillis = now
                    cal.add(Calendar.DAY_OF_YEAR, -(count - 1 - i))
                    cal.set(Calendar.HOUR_OF_DAY, 0)
                    cal.set(Calendar.MINUTE, 0)
                    cal.set(Calendar.SECOND, 0)
                    cal.set(Calendar.MILLISECOND, 0)
                    dayStarts[i] = cal.timeInMillis
                }

                val totals = if (isBlockedApp(packageName)) {
                    // A few hours of lookback so an app already open at the
                    // first midnight is seen resuming rather than only pausing.
                    val queryStart = dayStarts[0] - 3L * 60 * 60 * 1000
                    val usm = context.getSystemService(Context.USAGE_STATS_SERVICE) as UsageStatsManager
                    val events = usm.queryEvents(queryStart, now)
                    val relevant = ArrayList<ForegroundTime.Event>()
                    val ev = UsageEvents.Event()
                    while (events.hasNextEvent()) {
                        events.getNextEvent(ev)
                        val type = ev.eventType
                        if (!ForegroundTime.isRelevant(type)) continue
                        if (ForegroundTime.isDeviceWide(type) || ev.packageName == packageName) {
                            relevant.add(ForegroundTime.Event(ev.timeStamp, type, ev.className))
                        }
                    }
                    ForegroundTime.perDay(relevant, queryStart, dayStarts, now)
                } else {
                    LongArray(count)
                }

                val list = JSONArray()
                for (i in 0 until count) {
                    list.put(
                        JSONObject()
                            .put("date", fmt.format(Date(dayStarts[i])))
                            .put("minutes", Math.round(totals[i] / 60000.0))
                    )
                }
                payload.put("days", list)
            }
        } catch (e: Exception) {
            Log.e("WebAppInterface", "Error in getAppUsageHistory: ", e)
            // Neither granted nor refused: the page falls back to Intention's
            // own tracking and does not offer a trip to Settings that would
            // not fix anything.
            payload.remove("granted")
            payload.remove("days")
            payload.put("error", true)
        }
        respond(callbackId, payload)
    }

    private fun isBlockedApp(packageName: String): Boolean {
        val storage = JSONObject(BackgroundJsHelper.getSharedStorage(context, "[\"blockedApps\"]"))
        val arr = storage.optJSONArray("blockedApps") ?: return false
        for (i in 0 until arr.length()) if (arr.optString(i) == packageName) return true
        return false
    }

    // Returns [{date: "YYYY-MM-DD", packageName, minutes}] for the last `days`
    // days, restricted to currently-blocked apps. The OS already aggregates
    // per-app foreground time for its own Digital Wellbeing feature, so this
    // is an on-demand read, not a continuous background poll.
    @JavascriptInterface
    fun getAppUsageStats(days: Int, callbackId: String) {
        val result = JSONArray()
        try {
            val blockedApps = mutableSetOf<String>()
            val storage = JSONObject(BackgroundJsHelper.getSharedStorage(context, "[\"blockedApps\"]"))
            if (storage.has("blockedApps")) {
                val arr = storage.getJSONArray("blockedApps")
                for (i in 0 until arr.length()) blockedApps.add(arr.getString(i))
            }

            if (blockedApps.isNotEmpty() && hasUsageAccess()) {
                val usm = context.getSystemService(Context.USAGE_STATS_SERVICE) as UsageStatsManager
                val fmt = SimpleDateFormat("yyyy-MM-dd", Locale.US)
                val cal = Calendar.getInstance()
                for (i in 0 until days) {
                    cal.time = Date()
                    cal.add(Calendar.DAY_OF_YEAR, -i)
                    cal.set(Calendar.HOUR_OF_DAY, 0)
                    cal.set(Calendar.MINUTE, 0)
                    cal.set(Calendar.SECOND, 0)
                    cal.set(Calendar.MILLISECOND, 0)
                    val dayStart = cal.timeInMillis
                    val dayEnd = dayStart + 24L * 60 * 60 * 1000
                    val dateKey = fmt.format(Date(dayStart))

                    val totals = mutableMapOf<String, Long>()
                    for (stat in usm.queryUsageStats(UsageStatsManager.INTERVAL_DAILY, dayStart, dayEnd)) {
                        if (stat.packageName in blockedApps) {
                            totals[stat.packageName] = (totals[stat.packageName] ?: 0L) + stat.totalTimeInForeground
                        }
                    }
                    for ((pkg, ms) in totals) {
                        val minutes = Math.round(ms / 60000.0)
                        if (minutes > 0) {
                            result.put(JSONObject().put("date", dateKey).put("packageName", pkg).put("minutes", minutes))
                        }
                    }
                }
            }
        } catch (e: Exception) {
            Log.e("WebAppInterface", "Error in getAppUsageStats: ", e)
        }
        runOnJs("window.AndroidCallbacks.invoke(${JSONObject.quote(callbackId)},${JSONObject.quote(result.toString())})")
    }

    private fun runOnJs(script: String) {
        Handler(Looper.getMainLooper()).post {
            webView.evaluateJavascript(script, null)
        }
    }
}
