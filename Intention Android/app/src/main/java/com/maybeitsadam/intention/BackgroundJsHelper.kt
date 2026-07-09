package com.maybeitsadam.intention

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.webkit.JavascriptInterface
import android.webkit.WebView
import android.webkit.WebViewClient
import org.json.JSONObject

object BackgroundJsHelper {
    private const val TAG = "BackgroundJsHelper"
    private var webView: WebView? = null
    private val pendingCallbacks = mutableMapOf<String, (String?) -> Unit>()

    fun init(context: Context) {
        if (webView != null) return
        
        Handler(Looper.getMainLooper()).post {
            val wv = WebView(context.applicationContext)
            wv.settings.javaScriptEnabled = true
            wv.settings.allowFileAccess = true
            
            wv.addJavascriptInterface(object {
                @JavascriptInterface
                fun getStorage(keysJson: String, callbackId: String) {
                    val result = getSharedStorage(context, keysJson)
                    runOnJs(wv, "window.AndroidCallbacks.invoke('$callbackId', ${JSONObject.quote(result)})")
                }

                @JavascriptInterface
                fun setStorage(itemsJson: String, callbackId: String) {
                    setSharedStorage(context, itemsJson)
                    runOnJs(wv, "window.AndroidCallbacks.invoke('$callbackId', '{}')")
                }

                @JavascriptInterface
                fun onMessageResponse(callbackId: String, responseJson: String?) {
                    synchronized(pendingCallbacks) {
                        val cb = pendingCallbacks.remove(callbackId)
                        cb?.let { it(responseJson) }
                    }
                }

                @JavascriptInterface
                fun createAlarm(name: String, infoJson: String) {
                    Log.d(TAG, "createAlarm: $name, $infoJson")
                    AlarmHelper.createAlarm(context, name, infoJson)
                }

                @JavascriptInterface
                fun clearAlarm(name: String) {
                    Log.d(TAG, "clearAlarm: $name")
                    AlarmHelper.clearAlarm(context, name)
                }
            }, "AndroidInterface")

            wv.webViewClient = object : WebViewClient() {
                override fun onPageFinished(view: WebView?, url: String?) {
                    Log.d(TAG, "Background scripts loaded in WebView")
                }
            }
            
            wv.loadUrl("file:///android_asset/background.html")
            webView = wv
        }
    }

    fun sendMessage(messageJson: String, callback: (String?) -> Unit) {
        val wv = webView ?: run {
            callback("{\"error\":\"Background JS helper not initialized\"}")
            return
        }
        val callbackId = "native_cb_" + System.currentTimeMillis() + "_" + (0..1000).random()
        synchronized(pendingCallbacks) {
            pendingCallbacks[callbackId] = callback
        }
        Handler(Looper.getMainLooper()).post {
            val senderJson = "{\"tab\":{\"id\":1}}" 
            val escapedMessage = messageJson.replace("'", "\\'")
            val escapedSender = senderJson.replace("'", "\\'")
            wv.evaluateJavascript("window.triggerMessage('$escapedMessage', '$escapedSender', '$callbackId')", null)
        }
    }

    private fun runOnJs(wv: WebView, script: String) {
        Handler(Looper.getMainLooper()).post {
            wv.evaluateJavascript(script, null)
        }
    }

    fun getSharedStorage(context: Context, keysJson: String): String {
        val prefs = context.getSharedPreferences("intention_prefs", Context.MODE_PRIVATE)
        val response = JSONObject()
        try {
            val keys = mutableListOf<String>()
            try {
                val json = JSONObject(keysJson)
                if (json.has("keys")) {
                    val arr = json.getJSONArray("keys")
                    for (i in 0 until arr.length()) {
                        keys.add(arr.getString(i))
                    }
                } else {
                    val iter = json.keys()
                    while (iter.hasNext()) {
                        keys.add(iter.next())
                    }
                }
            } catch (e: Exception) {
                try {
                    val arr = org.json.JSONArray(keysJson)
                    for (i in 0 until arr.length()) {
                        keys.add(arr.getString(i))
                    }
                } catch (e2: Exception) {
                    val key = keysJson.trim('"')
                    if (key.isNotEmpty()) {
                        keys.add(key)
                    }
                }
            }
            
            for (key in keys) {
                val valueStr = prefs.getString(key, null)
                if (valueStr != null) {
                    try {
                        response.put(key, JSONObject(valueStr))
                    } catch (e: Exception) {
                        try {
                            response.put(key, org.json.JSONArray(valueStr))
                        } catch (e2: Exception) {
                            if (valueStr == "true") response.put(key, true)
                            else if (valueStr == "false") response.put(key, false)
                            else {
                                val num = valueStr.toDoubleOrNull()
                                if (num != null) response.put(key, num)
                                else response.put(key, valueStr)
                            }
                        }
                    }
                }
            }
        } catch (e: Exception) {
            Log.e(TAG, "Error in getSharedStorage: ", e)
        }
        return response.toString()
    }

    fun setSharedStorage(context: Context, itemsJson: String) {
        val prefs = context.getSharedPreferences("intention_prefs", Context.MODE_PRIVATE)
        val editor = prefs.edit()
        try {
            val json = JSONObject(itemsJson)
            val iter = json.keys()
            while (iter.hasNext()) {
                val key = iter.next()
                val value = json.get(key)
                editor.putString(key, value.toString())
            }
            editor.apply()
        } catch (e: Exception) {
            Log.e(TAG, "Error saving to storage: ", e)
        }
    }
}
