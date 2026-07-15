package uk.co.maybeitssoftware.intention

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.provider.Settings
import android.text.TextUtils
import android.view.View
import android.webkit.WebView
import android.widget.Button
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity

class MainActivity : AppCompatActivity() {

    private lateinit var webView: WebView
    private lateinit var accessibilityGate: View

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

        // Full-screen gate shown until the accessibility service is enabled.
        // The rest of the app (webview) is not reachable until this passes.
        accessibilityGate = android.widget.LinearLayout(this).apply {
            orientation = android.widget.LinearLayout.VERTICAL
            gravity = android.view.Gravity.CENTER
            layoutParams = android.widget.LinearLayout.LayoutParams(
                android.view.ViewGroup.LayoutParams.MATCH_PARENT,
                0,
                1.0f
            )
            setPadding(64, 64, 64, 64)
            visibility = View.GONE
        }

        val alertTitle = TextView(this).apply {
            text = "Accessibility permission required"
            setTextColor(android.graphics.Color.parseColor("#e7e7ea"))
            textSize = 20f
            gravity = android.view.Gravity.CENTER
        }

        val alertText = TextView(this).apply {
            text = "Intention needs Accessibility permission to coach you when you open distracting apps. Enable it to continue."
            setTextColor(android.graphics.Color.parseColor("#9a9aa5"))
            gravity = android.view.Gravity.CENTER
            setPadding(0, 24, 0, 48)
        }

        val enableServiceBtn = Button(this).apply {
            text = "Open Accessibility Settings"
            setBackgroundColor(android.graphics.Color.parseColor("#e7e7ea"))
            setTextColor(android.graphics.Color.parseColor("#0f1115"))
            setOnClickListener {
                val intent = Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)
                startActivity(intent)
            }
        }

        (accessibilityGate as android.widget.LinearLayout).addView(alertTitle)
        (accessibilityGate as android.widget.LinearLayout).addView(alertText)
        (accessibilityGate as android.widget.LinearLayout).addView(enableServiceBtn)

        // Options WebView — the rest of the app, hidden until accessibility is enabled
        webView = WebView(this).apply {
            layoutParams = android.widget.LinearLayout.LayoutParams(
                android.view.ViewGroup.LayoutParams.MATCH_PARENT,
                0,
                1.0f
            )
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.allowFileAccess = true
            visibility = View.GONE
        }

        rootLayout.addView(accessibilityGate)
        rootLayout.addView(webView)
        setContentView(rootLayout)

        // Initialize background helper
        BackgroundJsHelper.init(applicationContext)

        // Set up bridge
        webView.addJavascriptInterface(WebAppInterface(this, webView) {
            finish()
        }, "AndroidInterface")

        // Load options, with the native bridge script injected into <head>
        val html = assets.open("options.html").bufferedReader().use { it.readText() }
        val modifiedHtml = html.replace("<head>", "<head><script src=\"android-bridge.js\"></script>")
        webView.loadDataWithBaseURL(
            "file:///android_asset/",
            modifiedHtml,
            "text/html",
            "UTF-8",
            null
        )
    }

    override fun onResume() {
        super.onResume()
        if (!isAccessibilityServiceEnabled()) {
            accessibilityGate.visibility = View.VISIBLE
            webView.visibility = View.GONE
        } else {
            accessibilityGate.visibility = View.GONE
            webView.visibility = View.VISIBLE
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
