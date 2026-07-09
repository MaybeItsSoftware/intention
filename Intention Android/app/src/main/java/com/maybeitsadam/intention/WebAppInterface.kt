package com.maybeitsadam.intention

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.webkit.JavascriptInterface
import android.webkit.WebView
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

    private fun runOnJs(script: String) {
        Handler(Looper.getMainLooper()).post {
            webView.evaluateJavascript(script, null)
        }
    }
}
