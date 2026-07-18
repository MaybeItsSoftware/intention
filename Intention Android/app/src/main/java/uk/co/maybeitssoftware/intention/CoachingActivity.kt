package uk.co.maybeitssoftware.intention

import android.content.Intent
import android.os.Bundle
import android.webkit.WebSettings
import android.webkit.WebView
import androidx.appcompat.app.AppCompatActivity

class CoachingActivity : AppCompatActivity() {

    private lateinit var webView: WebView
    private var domain: String = ""
    private var isApp: Boolean = true

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        domain = intent.getStringExtra("domain") ?: ""
        isApp = intent.getBooleanExtra("isApp", true)
        val appLabel = intent.getStringExtra("appLabel") ?: domain

        webView = WebView(this).apply {
            layoutParams = android.view.ViewGroup.LayoutParams(
                android.view.ViewGroup.LayoutParams.MATCH_PARENT,
                android.view.ViewGroup.LayoutParams.MATCH_PARENT
            )
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.allowFileAccess = true
            settings.cacheMode = WebSettings.LOAD_NO_CACHE
        }
        setContentView(webView)

        // Initialize background helper
        BackgroundJsHelper.init(applicationContext)

        // Set up bridge. When closeCurrentTab is called, it triggers the callback which calls goHome()
        webView.addJavascriptInterface(WebAppInterface(this, webView) {
            goHome()
        }, "AndroidInterface")

        // Load coaching page for the target package name, with the native bridge injected
        val html = assets.open("coaching.html").bufferedReader().use { it.readText() }
        val modifiedHtml = html.replace("<head>", "<head><script src=\"android-bridge.js\"></script>")
        val encodedDomain = android.net.Uri.encode(domain)
        val encodedLabel = android.net.Uri.encode(appLabel)
        val appParam = if (isApp) "1" else "0"
        webView.loadDataWithBaseURL(
            "file:///android_asset/coaching.html?domain=$encodedDomain&app=$appParam&label=$encodedLabel",
            modifiedHtml,
            "text/html",
            "UTF-8",
            null
        )
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
