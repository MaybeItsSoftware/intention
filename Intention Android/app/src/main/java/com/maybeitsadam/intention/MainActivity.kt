package com.maybeitsadam.intention

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.provider.Settings
import android.text.TextUtils
import android.util.Log
import android.view.View
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity

class MainActivity : AppCompatActivity() {

    private lateinit var webView: WebView
    private lateinit var accessibilityAlert: View
    private lateinit var enableServiceBtn: Button

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        
        // Dynamic layouts are cleaner for extension wrappers
        val rootLayout = android.widget.LinearLayout(this).apply {
            orientation = android.widget.LinearLayout.VERTICAL
            layoutParams = android.view.ViewGroup.LayoutParams(
                android.view.ViewGroup.LayoutParams.MATCH_PARENT,
                android.view.ViewGroup.LayoutParams.MATCH_PARENT
            )
            setBackgroundColor(android.graphics.Color.parseColor("#0f1115"))
        }

        // Accessibility service warning bar
        accessibilityAlert = android.widget.LinearLayout(this).apply {
            orientation = android.widget.LinearLayout.HORIZONTAL
            layoutParams = android.widget.LinearLayout.LayoutParams(
                android.view.ViewGroup.LayoutParams.MATCH_PARENT,
                android.view.ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply {
                setMargins(24, 24, 24, 24)
            }
            setBackgroundColor(android.graphics.Color.parseColor("#1f242e"))
            setPadding(32, 32, 32, 32)
            visibility = View.GONE
        }

        val alertText = TextView(this).apply {
            text = "Intention needs Accessibility permission to coach you on opening distracting apps."
            setTextColor(android.graphics.Color.parseColor("#e7e7ea"))
            layoutParams = android.widget.LinearLayout.LayoutParams(
                0,
                android.view.ViewGroup.LayoutParams.WRAP_CONTENT,
                1.0f
            )
        }

        enableServiceBtn = Button(this).apply {
            text = "Enable"
            setBackgroundColor(android.graphics.Color.parseColor("#e7e7ea"))
            setTextColor(android.graphics.Color.parseColor("#0f1115"))
            setOnClickListener {
                val intent = Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)
                startActivity(intent)
            }
        }

        (accessibilityAlert as android.widget.LinearLayout).addView(alertText)
        (accessibilityAlert as android.widget.LinearLayout).addView(enableServiceBtn)

        // Options WebView
        webView = WebView(this).apply {
            layoutParams = android.widget.LinearLayout.LayoutParams(
                android.view.ViewGroup.LayoutParams.MATCH_PARENT,
                0,
                1.0f
            )
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.allowFileAccess = true
            webViewClient = object : WebViewClient() {
                override fun shouldInterceptRequest(
                    view: WebView?,
                    request: WebResourceRequest?
                ): WebResourceResponse? {
                    val url = request?.url?.toString() ?: return null
                    if (url.startsWith("file:///android_asset/") && url.endsWith(".html")) {
                        try {
                            val assetPath = url.substring("file:///android_asset/".length).split("?")[0]
                            val inputStream = view?.context?.assets?.open(assetPath) ?: return null
                            val html = inputStream.bufferedReader().use { it.readText() }
                            val modifiedHtml = html.replace("<head>", "<head><script src=\"android-bridge.js\"></script>")
                            return WebResourceResponse(
                                "text/html",
                                "UTF-8",
                                modifiedHtml.byteInputStream()
                            )
                        } catch (e: Exception) {
                            Log.e("MainActivity", "Error intercepting request", e)
                        }
                    }
                    return null
                }
            }
        }

        rootLayout.addView(accessibilityAlert)
        rootLayout.addView(webView)
        setContentView(rootLayout)

        // Initialize background helper
        BackgroundJsHelper.init(applicationContext)

        // Set up bridge
        webView.addJavascriptInterface(WebAppInterface(this, webView) {
            finish()
        }, "AndroidInterface")

        // Load options
        webView.loadUrl("file:///android_asset/options.html")
    }

    override fun onResume() {
        super.onResume()
        if (!isAccessibilityServiceEnabled()) {
            accessibilityAlert.visibility = View.VISIBLE
        } else {
            accessibilityAlert.visibility = View.GONE
        }
    }

    private fun isAccessibilityServiceEnabled(): Boolean {
        val service = "$packageName/${IntentionAccessibilityService::class.java.canonicalName}"
        val enabled = Settings.Secure.getInt(
            contentResolver,
            Settings.Secure.ACCESSIBILITY_ENABLED, 0
        )
        if (enabled == 1) {
            val settingValue = Settings.Secure.getString(
                contentResolver,
                Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES
            )
            if (settingValue != null) {
                val splitter = TextUtils.SimpleStringSplitter(':')
                splitter.setString(settingValue)
                while (splitter.hasNext()) {
                    val accessService = splitter.next()
                    if (accessService.equals(service, ignoreCase = true)) {
                        return true
                    }
                }
            }
        }
        return false
    }
}
