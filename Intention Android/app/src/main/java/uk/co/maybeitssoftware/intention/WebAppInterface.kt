package uk.co.maybeitssoftware.intention

import android.content.Context
import android.content.Intent
import android.os.Handler
import android.os.Looper
import android.webkit.JavascriptInterface
import android.webkit.WebView
import org.json.JSONArray
import org.json.JSONObject

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
                    pkg to pm.getApplicationLabel(info).toString()
                } catch (e: Exception) {
                    null
                }
            }
            .sortedBy { it.second.lowercase() }
        val array = JSONArray()
        for ((pkg, label) in apps) {
            array.put(JSONObject().put("packageName", pkg).put("label", label))
        }
        runOnJs("window.AndroidCallbacks.invoke('$callbackId', ${JSONObject.quote(array.toString())})")
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

    private fun runOnJs(script: String) {
        Handler(Looper.getMainLooper()).post {
            webView.evaluateJavascript(script, null)
        }
    }
}
