package uk.co.maybeitssoftware.intention

import android.app.AppOpsManager
import android.app.usage.UsageStatsManager
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.drawable.Drawable
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
        runOnJs("window.AndroidCallbacks.invoke('$callbackId', ${JSONObject.quote(result)})")
    }

    @JavascriptInterface
    fun setStorage(itemsJson: String, callbackId: String) {
        BackgroundJsHelper.setSharedStorage(context, itemsJson)
        runOnJs("window.AndroidCallbacks.invoke('$callbackId', '{}')")
    }

    @JavascriptInterface
    fun sendMessage(messageJson: String, callbackId: String) {
        try {
            val json = JSONObject(messageJson)
            val action = json.optString("action")
            if (action == "closeCurrentTab") {
                onClose?.invoke()
                runOnJs("window.AndroidCallbacks.invoke('$callbackId', '{\"ok\":true}')")
                return
            }
        } catch (e: Exception) {}

        BackgroundJsHelper.sendMessage(messageJson) { response ->
            runOnJs("window.AndroidCallbacks.invoke('$callbackId', ${JSONObject.quote(response ?: "")})")
        }
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
        runOnJs("window.AndroidCallbacks.invoke('$callbackId', ${JSONObject.quote(array.toString())})")
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
        runOnJs("window.AndroidCallbacks.invoke('$callbackId', ${JSONObject.quote(result.toString())})")
    }

    private fun runOnJs(script: String) {
        Handler(Looper.getMainLooper()).post {
            webView.evaluateJavascript(script, null)
        }
    }
}
