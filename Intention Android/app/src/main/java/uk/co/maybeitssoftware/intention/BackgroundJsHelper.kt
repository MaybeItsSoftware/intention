package uk.co.maybeitssoftware.intention

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.webkit.JavascriptInterface
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import org.json.JSONObject

object BackgroundJsHelper {
    private const val TAG = "BackgroundJsHelper"
    private var webView: WebView? = null
    private var isReady = false
    private val pendingCallbacks = mutableMapOf<String, (String?) -> Unit>()
    private val pendingMessages = mutableListOf<() -> Unit>()

    fun init(context: Context) {
        if (webView != null) return

        Handler(Looper.getMainLooper()).post {
            // BootReceiver initializes us straight out of a device restart, where
            // the WebView provider can still be settling. A throw here would be
            // an uncaught exception on the main thread — i.e. a crash at every
            // boot — so fail quietly and let the next entry point retry.
            val wv = try {
                WebView(context.applicationContext)
            } catch (e: Exception) {
                Log.e(TAG, "Could not create the background WebView: ", e)
                return@post
            }
            wv.settings.javaScriptEnabled = true
            wv.settings.allowFileAccess = true
            wv.settings.cacheMode = WebSettings.LOAD_NO_CACHE

            wv.addJavascriptInterface(object {
                @JavascriptInterface
                fun getStorage(keysJson: String, callbackId: String) {
                    val result = getSharedStorage(context, keysJson)
                    runOnJs(wv, "window.AndroidCallbacks.invoke(${JSONObject.quote(callbackId)},${JSONObject.quote(result)})")
                }

                @JavascriptInterface
                fun setStorage(itemsJson: String, callbackId: String) {
                    setSharedStorage(context, itemsJson)
                    runOnJs(wv, "window.AndroidCallbacks.invoke(${JSONObject.quote(callbackId)},'{}')")
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
                    isReady = true
                    val queued = synchronized(pendingMessages) {
                        val copy = pendingMessages.toList()
                        pendingMessages.clear()
                        copy
                    }
                    queued.forEach { it() }
                    // A fresh background page means a fresh process — after a
                    // reboot, an update, a force stop, or the system reclaiming
                    // us — and the alarms backing any live session went with the
                    // old one. Rebuild them.
                    reconcileSessions()
                }
            }
            
            wv.loadUrl("file:///android_asset/background.html")
            webView = wv
        }
    }

    fun sendMessage(messageJson: String, callback: (String?) -> Unit) {
        val callbackId = "native_cb_" + System.currentTimeMillis() + "_" + (0..1000).random()
        // init() creates the WebView on a main-thread post, so `webView` is still
        // null when a caller that just called init() gets here — which is what
        // every entry point does (BootReceiver, MainActivity, CoachingActivity).
        // Resolving it inside our own post puts this behind that creation rather
        // than failing the call outright.
        Handler(Looper.getMainLooper()).post {
            val wv = webView
            if (wv == null) {
                callback("{\"error\":\"Background JS helper not initialized\"}")
                return@post
            }
            synchronized(pendingCallbacks) {
                pendingCallbacks[callbackId] = callback
            }
            val dispatch = {
                // No tab: Android has no browser tabs of its own, and faking one id
                // made every site and app on the device share a single session,
                // chat history and check-in alarm. The shared background.js keys
                // per blocked target when the sender has no tab (sessionKeyFor),
                // which is also what the iOS host sends.
                val senderJson = "{}"
                // messageJson is already-escaped JSON text (e.g. multi-line userContext
                // becomes literal "\n" sequences). Wrapping it in a hand-escaped single-quoted
                // JS literal double-unescapes those sequences into raw control characters,
                // which then fail JSON.parse inside triggerMessage. JSONObject.quote produces
                // a JS-literal-safe string that round-trips correctly.
                wv.evaluateJavascript(
                    "window.triggerMessage(${JSONObject.quote(messageJson)}, ${JSONObject.quote(senderJson)}, ${JSONObject.quote(callbackId)})",
                    null
                )
            }
            if (isReady) {
                dispatch()
            } else {
                synchronized(pendingMessages) {
                    pendingMessages.add(dispatch)
                }
            }
        }
    }

    // Banks any pass that ran out while the process was gone and re-arms the
    // check-in alarms a restart destroyed — see reconcileSessions() in
    // background.js. `onDone` fires once the background page has answered, which
    // BootReceiver uses to hold its broadcast open until the work is finished.
    fun reconcileSessions(onDone: () -> Unit = {}) {
        sendMessage("{\"action\":\"reconcileSessions\"}") { onDone() }
    }

    // Fires the chrome.alarms.onAlarm listener registered by the shared
    // background.js (exposed as window.alarmListener by background.html).
    fun dispatchAlarm(name: String) {
        val script = "window.alarmListener && window.alarmListener({name: ${JSONObject.quote(name)}})"
        Handler(Looper.getMainLooper()).post {
            val wv = webView ?: return@post
            if (isReady) {
                wv.evaluateJavascript(script, null)
            } else {
                synchronized(pendingMessages) {
                    pendingMessages.add { wv.evaluateJavascript(script, null) }
                }
            }
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
                val valueStr = prefs.getString(key, null) ?: continue
                response.put(key, decodeStoredValue(valueStr))
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
                // Strings are stored quoted so they survive the round trip.
                // Without it, decodeStoredValue has to guess, and a setting
                // whose text happens to read as "true" or "1.5" comes back as
                // a boolean or a number. Objects and arrays keep their plain
                // JSON form — IntentionAccessibilityService reads blockedApps,
                // blockedDomains and activeSessions straight out of prefs.
                editor.putString(key, if (value is String) JSONObject.quote(value) else value.toString())
            }
            editor.apply()
        } catch (e: Exception) {
            Log.e(TAG, "Error saving to storage: ", e)
        }
    }

    // Inverse of the encoding in setSharedStorage. Values written by older
    // builds are unquoted, so a bare string still has to decode as itself —
    // JSONTokener handles both, and anything it can't parse is raw text.
    private fun decodeStoredValue(valueStr: String): Any {
        return try {
            org.json.JSONTokener(valueStr).nextValue() ?: valueStr
        } catch (e: Exception) {
            valueStr
        }
    }
}
