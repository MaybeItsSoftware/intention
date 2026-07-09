package com.maybeitsadam.intention

import android.content.Intent
import android.os.Bundle
import android.util.Log
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.appcompat.app.AppCompatActivity

class CoachingActivity : AppCompatActivity() {

    private lateinit var webView: WebView
    private var domain: String = ""

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        
        domain = intent.getStringExtra("domain") ?: ""

        webView = WebView(this).apply {
            layoutParams = android.view.ViewGroup.LayoutParams(
                android.view.ViewGroup.LayoutParams.MATCH_PARENT,
                android.view.ViewGroup.LayoutParams.MATCH_PARENT
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
                            Log.e("CoachingActivity", "Error intercepting request", e)
                        }
                    }
                    return null
                }
            }
        }
        setContentView(webView)

        // Initialize background helper
        BackgroundJsHelper.init(applicationContext)

        // Set up bridge. When closeCurrentTab is called, it triggers the callback which calls goHome()
        webView.addJavascriptInterface(WebAppInterface(this, webView) {
            goHome()
        }, "AndroidInterface")

        // Load coaching page for the target package name
        webView.loadUrl("file:///android_asset/coaching.html?domain=$domain")
    }

    override fun onBackPressed() {
        // Overriding back button to prevent bypassing the coach: send them to home screen
        goHome()
    }

    private fun goHome() {
        val startMain = Intent(Intent.ACTION_MAIN).apply {
            addCategory(Intent.CATEGORY_HOME)
            flags = Intent.FLAG_ACTIVITY_NEW_TASK
        }
        startActivity(startMain)
        finish()
    }
}
