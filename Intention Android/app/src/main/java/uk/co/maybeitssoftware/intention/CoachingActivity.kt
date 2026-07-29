package uk.co.maybeitssoftware.intention

import android.content.ActivityNotFoundException
import android.content.Intent
import android.os.Bundle
import android.provider.Browser
import android.util.Log
import android.webkit.WebSettings
import android.webkit.WebView
import androidx.appcompat.app.AppCompatActivity

class CoachingActivity : AppCompatActivity() {

    companion object {
        private const val TAG = "CoachingActivity"
        // Blank page to send the browser to on decline. No network, no content,
        // and its "host" has no dot, so findBlockedDomain never matches it.
        private const val BLANK_TAB_URL = "about:blank"
    }

    private lateinit var webView: WebView
    private var domain: String = ""
    private var isApp: Boolean = true
    private var browserPackage: String? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        domain = intent.getStringExtra("domain") ?: ""
        isApp = intent.getBooleanExtra("isApp", true)
        browserPackage = intent.getStringExtra("browserPackage")
        // "checkin" when a granted session just ran out (the coach asks whether
        // they got what they came for); "gate" for a fresh block.
        val mode = intent.getStringExtra("mode") ?: "gate"
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

        // Set up bridge. When closeCurrentTab is called, it triggers the callback
        webView.addJavascriptInterface(WebAppInterface(this, webView) {
            closeBlockedTab()
        }, "AndroidInterface")

        // Load coaching page for the target package name, with the native bridge injected
        val html = assets.open("coaching.html").bufferedReader().use { it.readText() }
        val modifiedHtml = html.replace("<head>", "<head><script src=\"android-bridge.js\"></script>")
        val encodedDomain = android.net.Uri.encode(domain)
        val encodedLabel = android.net.Uri.encode(appLabel)
        val appParam = if (isApp) "1" else "0"
        val encodedBrowserPackage = android.net.Uri.encode(browserPackage ?: "")
        val encodedMode = android.net.Uri.encode(mode)
        webView.loadDataWithBaseURL(
            "file:///android_asset/coaching.html?domain=$encodedDomain&app=$appParam&label=$encodedLabel&browserPackage=$encodedBrowserPackage&mode=$encodedMode",
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

    // Another app's specific tab can't be closed via any public Android API,
    // so for a website we do the next best thing: open a fresh blank tab in the
    // same browser. That puts a neutral page in front of the user instead of
    // dropping them straight back onto the distracting site, while the original
    // tab (and every other tab) stays open and reachable.
    private fun closeBlockedTab() {
        val pkg = browserPackage
        if (!isApp && pkg != null) {
            // A short grace is needed even when the divert works, since the URL
            // bar can still report the blocked host while the new tab opens.
            // The service drops it as soon as it sees the blank tab, so closing
            // that tab puts the coach straight back in front of the site.
            val diverted = openBlankTab(pkg)
            IntentionAccessibilityService.instance?.recordDismissal(pkg, domain, diverted)
            finish()
            return
        }
        goHome()
    }

    // ACTION_VIEW + EXTRA_CREATE_NEW_TAB is the standard way to ask a browser
    // for a new tab; Chromium- and Gecko-based browsers both honour it. Returns
    // false if this browser doesn't handle about: URLs, in which case we leave
    // it as it was rather than booting the user out to the home screen.
    private fun openBlankTab(pkg: String): Boolean {
        val intent = Intent(Intent.ACTION_VIEW, android.net.Uri.parse(BLANK_TAB_URL)).apply {
            `package` = pkg
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            putExtra(Browser.EXTRA_CREATE_NEW_TAB, true)
        }
        return try {
            startActivity(intent)
            true
        } catch (e: ActivityNotFoundException) {
            Log.w(TAG, "$pkg doesn't handle $BLANK_TAB_URL; leaving the browser untouched", e)
            false
        }
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
