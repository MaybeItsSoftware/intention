package uk.co.maybeitssoftware.intention

import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.drawable.Drawable
import android.os.Handler
import android.os.Looper
import android.util.Base64
import android.webkit.JavascriptInterface
import android.webkit.WebView
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream

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

    private fun runOnJs(script: String) {
        Handler(Looper.getMainLooper()).post {
            webView.evaluateJavascript(script, null)
        }
    }
}
