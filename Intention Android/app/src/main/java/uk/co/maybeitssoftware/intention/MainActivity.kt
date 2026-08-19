package uk.co.maybeitssoftware.intention

import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.text.TextUtils
import android.view.View
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.TextView
import androidx.activity.enableEdgeToEdge
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : AppCompatActivity() {

    companion object {
        // House palette, dark mode — used only by the overlay prompt below.
        // The accessibility gate above it predates these tokens and is left
        // on its own older hex rather than half-restyled.
        private const val COLOR_SURFACE = "#25232f"
        private const val COLOR_BORDER = "#34313f"
        private const val COLOR_TEXT = "#f5f4f7"
        private const val COLOR_MUTED = "#b6b3bf"
        private const val COLOR_AZURE = "#007fff"
        private const val COLOR_AZURE_FILL = "#1a007fff"
        private const val COLOR_AZURE_BORDER = "#66007fff"
        private const val REQUEST_POST_NOTIFICATIONS = 0x1973
    }

    private lateinit var webView: WebView
    private lateinit var accessibilityGate: View
    // The pass timer's permission prompt. Unlike the accessibility gate this
    // blocks nothing: it is an offer, dismissible for the session, and gone for
    // good once the permission is granted.
    private lateinit var overlayPrompt: View
    private var overlayPromptDismissed = false
    private var notificationPermissionAsked = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()

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
            text = "Intention needs Accessibility permission to coach you when you open distracting apps."
            setTextColor(android.graphics.Color.parseColor("#9a9aa5"))
            gravity = android.view.Gravity.CENTER
            setPadding(0, 24, 0, 24)
        }

        // Some OEM settings screens (MIUI, One UI, etc.) drop the app straight
        // into a long "Downloaded apps" list rather than Intention's toggle, so
        // spell out every tap rather than assuming the deep link lands exactly.
        val stepsText = TextView(this).apply {
            text = "1. Tap \"Open Accessibility Settings\" below\n" +
                "2. Find \"Intention\" in the list (it may be under \"Downloaded apps\" or \"Installed apps\")\n" +
                "3. Tap it, then turn the switch on\n" +
                "4. Confirm \"Allow\" on the popup, then come back here"
            setTextColor(android.graphics.Color.parseColor("#c7c7d1"))
            gravity = android.view.Gravity.START
            setPadding(0, 0, 0, 48)
        }

        val enableServiceBtn = Button(this).apply {
            text = "Open Accessibility Settings"
            setBackgroundColor(android.graphics.Color.parseColor("#e7e7ea"))
            setTextColor(android.graphics.Color.parseColor("#0f1115"))
            setOnClickListener { openAccessibilitySettings() }
        }

        val recheckBtn = Button(this).apply {
            text = "I've turned it on — check again"
            setBackgroundColor(android.graphics.Color.parseColor("#0f1115"))
            setTextColor(android.graphics.Color.parseColor("#e7e7ea"))
            setPadding(0, 24, 0, 0)
            setOnClickListener {
                if (isAccessibilityServiceEnabled()) {
                    accessibilityGate.visibility = View.GONE
                    webView.visibility = View.VISIBLE
                } else {
                    android.widget.Toast.makeText(
                        this@MainActivity,
                        "Still not enabled — make sure the switch next to Intention is on",
                        android.widget.Toast.LENGTH_LONG
                    ).show()
                }
            }
        }

        (accessibilityGate as android.widget.LinearLayout).addView(alertTitle)
        (accessibilityGate as android.widget.LinearLayout).addView(alertText)
        (accessibilityGate as android.widget.LinearLayout).addView(stepsText)
        (accessibilityGate as android.widget.LinearLayout).addView(enableServiceBtn)
        (accessibilityGate as android.widget.LinearLayout).addView(recheckBtn)

        overlayPrompt = buildOverlayPrompt()

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
            settings.cacheMode = WebSettings.LOAD_NO_CACHE
            visibility = View.GONE
            // options.html is injected with loadDataWithBaseURL, so this WebView
            // has no history to go back to. A tapped link would replace the
            // whole settings UI with a web page and leave the system back
            // button as the only way out — so anything off-app is handed to a
            // real browser instead.
            webViewClient = object : WebViewClient() {
                override fun shouldOverrideUrlLoading(
                    view: WebView,
                    request: WebResourceRequest
                ): Boolean = openExternally(request.url)
            }
        }

        rootLayout.addView(accessibilityGate)
        rootLayout.addView(overlayPrompt)
        rootLayout.addView(webView)
        setContentView(rootLayout)

        // With edge-to-edge enforced on SDK 35+, content draws behind the system
        // bars by default — pad the root so the gate/webview stay clear of them.
        ViewCompat.setOnApplyWindowInsetsListener(rootLayout) { view, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars())
            view.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            insets
        }

        // Initialize background helper
        BackgroundJsHelper.init(applicationContext)

        // Connect to Play Billing up front so the paywall has prices ready by
        // the time onboarding reaches it.
        BillingManager.init(applicationContext)

        // Set up bridge
        webView.addJavascriptInterface(WebAppInterface(this, webView) {
            finish()
        }, "AndroidInterface")

        // Load options, with the native bridge script injected into <head>
        val html = assets.open("options.html").bufferedReader().use { it.readText() }
        val modifiedHtml = html.replace("<head>", "<head><script src=\"android-bridge.js\"></script>")
        // A deep-linked section (e.g. from the chat's "invalid API key" error)
        // arrives as an Intent extra rather than a real URL, since this page is
        // injected via loadDataWithBaseURL rather than navigated to — folding it
        // into the base URL's query string is what lets options.js read it the
        // same way it would from a normal ?section= link on the other platforms.
        val section = intent.getStringExtra("section")
        val baseUrl = if (section != null) {
            "file:///android_asset/options.html?section=${Uri.encode(section)}"
        } else {
            "file:///android_asset/"
        }
        webView.loadDataWithBaseURL(
            baseUrl,
            modifiedHtml,
            "text/html",
            "UTF-8",
            null
        )
    }

    // Hands an http(s) link to whatever browser the user actually uses.
    // Returns whether the WebView should consider the navigation handled —
    // false for anything else (file:// and the bridge's own URLs), which lets
    // the page load normally.
    private fun openExternally(uri: Uri?): Boolean {
        val scheme = uri?.scheme?.lowercase()
        if (scheme != "http" && scheme != "https") return false
        try {
            startActivity(Intent(Intent.ACTION_VIEW, uri).apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            })
        } catch (e: android.content.ActivityNotFoundException) {
            // No browser installed. Doing nothing is the right failure here —
            // the alternative is navigating the settings UI away from itself.
        }
        return true
    }

    // The offer to draw the pass timer over other apps. Same shape as the
    // accessibility gate above — a title, what it buys the user, a button into
    // the right Settings screen — but deliberately not a gate: SYSTEM_ALERT_WINDOW
    // adds a timer to a pass and nothing else, so refusing it has to leave a
    // working app rather than a dead end.
    private fun buildOverlayPrompt(): View {
        val card = android.widget.LinearLayout(this).apply {
            orientation = android.widget.LinearLayout.VERTICAL
            layoutParams = android.widget.LinearLayout.LayoutParams(
                android.view.ViewGroup.LayoutParams.MATCH_PARENT,
                android.view.ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply {
                setMargins(dp(16f), dp(16f), dp(16f), 0)
            }
            setPadding(dp(16f), dp(14f), dp(16f), dp(14f))
            // Flat and bordered: a hairline and half a step of tone, no shadow.
            background = android.graphics.drawable.GradientDrawable().apply {
                shape = android.graphics.drawable.GradientDrawable.RECTANGLE
                setColor(android.graphics.Color.parseColor(COLOR_SURFACE))
                cornerRadius = dp(8f).toFloat()
                setStroke(dp(1f).coerceAtLeast(1), android.graphics.Color.parseColor(COLOR_BORDER))
            }
            visibility = View.GONE
        }

        // The micro-label: 10sp, bold, uppercase, wide tracking, muted.
        card.addView(TextView(this).apply {
            text = "OPTIONAL"
            setTextColor(android.graphics.Color.parseColor(COLOR_MUTED))
            textSize = 10f
            typeface = android.graphics.Typeface.create(android.graphics.Typeface.DEFAULT, android.graphics.Typeface.BOLD)
            letterSpacing = 0.15f
        })

        card.addView(TextView(this).apply {
            text = "Show a timer while a pass is running"
            setTextColor(android.graphics.Color.parseColor(COLOR_TEXT))
            textSize = 16f
            setPadding(0, dp(6f), 0, 0)
        })

        card.addView(TextView(this).apply {
            text = "Intention can float the time you asked for over the app you're in, " +
                "with a Finished button for when you're done early. Blocking works the " +
                "same either way."
            setTextColor(android.graphics.Color.parseColor(COLOR_MUTED))
            textSize = 13f
            setPadding(0, dp(6f), 0, dp(12f))
        })

        val actions = android.widget.LinearLayout(this).apply {
            orientation = android.widget.LinearLayout.HORIZONTAL
        }

        actions.addView(Button(this).apply {
            text = "Allow"
            setTextColor(android.graphics.Color.parseColor(COLOR_TEXT))
            // Accents keep their hex in dark mode and are used as a low-alpha
            // fill behind a stronger border, never as a solid block.
            background = android.graphics.drawable.GradientDrawable().apply {
                shape = android.graphics.drawable.GradientDrawable.RECTANGLE
                setColor(android.graphics.Color.parseColor(COLOR_AZURE_FILL))
                cornerRadius = dp(6f).toFloat()
                setStroke(dp(1f).coerceAtLeast(1), android.graphics.Color.parseColor(COLOR_AZURE_BORDER))
            }
            minHeight = dp(44f)
            setOnClickListener { openOverlaySettings() }
        })

        actions.addView(Button(this).apply {
            text = "Not now"
            setTextColor(android.graphics.Color.parseColor(COLOR_MUTED))
            background = android.graphics.drawable.GradientDrawable().apply {
                shape = android.graphics.drawable.GradientDrawable.RECTANGLE
                setColor(android.graphics.Color.TRANSPARENT)
                cornerRadius = dp(6f).toFloat()
                setStroke(dp(1f).coerceAtLeast(1), android.graphics.Color.parseColor(COLOR_BORDER))
            }
            minHeight = dp(44f)
            layoutParams = android.widget.LinearLayout.LayoutParams(
                android.view.ViewGroup.LayoutParams.WRAP_CONTENT,
                android.view.ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply { leftMargin = dp(8f) }
            setOnClickListener {
                overlayPromptDismissed = true
                overlayPrompt.visibility = View.GONE
                // They have turned the overlay down, so the notification is now
                // the only way a running pass can show itself — which makes this
                // the honest moment to ask for POST_NOTIFICATIONS, rather than
                // on first launch when we don't yet need it.
                requestNotificationFallback()
            }
        })

        card.addView(actions)
        return card
    }

    override fun onResume() {
        super.onResume()
        if (!isAccessibilityServiceEnabled()) {
            accessibilityGate.visibility = View.VISIBLE
            webView.visibility = View.GONE
            overlayPrompt.visibility = View.GONE
        } else {
            accessibilityGate.visibility = View.GONE
            webView.visibility = View.VISIBLE
            // Only once the app actually works, and only while there is
            // something to ask for — coming back from Settings with the
            // permission granted takes the card away for good.
            overlayPrompt.visibility =
                if (!overlayPromptDismissed && !Settings.canDrawOverlays(this)) {
                    View.VISIBLE
                } else {
                    View.GONE
                }
        }
    }

    // Deep-links to Intention's own row in "Display over other apps". The
    // package Uri is honoured by AOSP and most skins; a device that rejects it
    // still gets the plain list rather than a crash, as with the accessibility
    // deep link above.
    private fun openOverlaySettings() {
        val intent = Intent(
            Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
            Uri.parse("package:$packageName")
        )
        try {
            startActivity(intent)
        } catch (e: Exception) {
            try {
                startActivity(Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION))
            } catch (e2: Exception) {
                android.widget.Toast.makeText(
                    this,
                    "Couldn't open the overlay settings on this device",
                    android.widget.Toast.LENGTH_LONG
                ).show()
            }
        }
    }

    // Nothing here reacts to the answer: a granted permission lets
    // SessionOverlay post its fallback notification, and a refused one leaves
    // the pass invisible — which is exactly how Android behaved before the
    // timer existed. Asked at most once per visit to this screen.
    private fun requestNotificationFallback() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return
        if (notificationPermissionAsked) return
        notificationPermissionAsked = true
        val granted = ContextCompat.checkSelfPermission(
            this,
            android.Manifest.permission.POST_NOTIFICATIONS
        ) == PackageManager.PERMISSION_GRANTED
        if (granted) return
        ActivityCompat.requestPermissions(
            this,
            arrayOf(android.Manifest.permission.POST_NOTIFICATIONS),
            REQUEST_POST_NOTIFICATIONS
        )
    }

    private fun dp(value: Float): Int =
        (value * resources.displayMetrics.density).toInt()

    // Deep-links to Intention's own toggle where supported; some OEM skins
    // (MIUI, One UI, etc.) reject the fragment-args extras and throw, so fall
    // back to the plain accessibility settings list rather than leaving the
    // user stuck on a crash.
    private fun openAccessibilitySettings() {
        val componentName = android.content.ComponentName(
            this,
            IntentionAccessibilityService::class.java
        )
        val deepLinkIntent = Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS).apply {
            putExtra(":settings:fragment_args_key", componentName.flattenToString())
            putExtra(
                ":settings:show_fragment_args",
                Bundle().apply {
                    putString(":settings:fragment_args_key", componentName.flattenToString())
                }
            )
        }
        try {
            startActivity(deepLinkIntent)
        } catch (e: Exception) {
            startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))
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
