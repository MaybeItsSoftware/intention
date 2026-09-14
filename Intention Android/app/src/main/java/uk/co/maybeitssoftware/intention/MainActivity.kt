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
import androidx.core.view.WindowCompat
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
        // Amber is the warning role: pending, caution, "this is not working the
        // way you asked". Same tinted-fill-plus-stronger-border treatment the
        // azure card uses, never a solid block.
        private const val COLOR_AMBER = "#ffbf00"
        private const val COLOR_AMBER_FILL = "#1affbf00"
        private const val COLOR_AMBER_BORDER = "#66ffbf00"
        private const val REQUEST_POST_NOTIFICATIONS = 0x1973

        // The accessibility gate's own background. The page's paper is
        // R.color.paper (values / values-night), see paintSystemBars.
        private const val COLOR_GATE = "#0f1115"

        // "Open the leaving conversation rather than the settings page you
        // were going to open anyway." Set by IntentionAccessibilityService
        // when it sees Settings showing Intention's own App info page or the
        // Accessibility entry for its service, and by nothing else.
        //
        // It becomes `?leave=1` on the options URL, which is the address the
        // browser build's own interposition opens (background.js's
        // interposeOnRemovalSurface). options.js reads the query string, not
        // the Intent, so there is exactly one leaving flow and this is one of
        // its two doors.
        const val EXTRA_LEAVE = "leave"

        // The section deep link, e.g. from the chat's "invalid API key" error.
        private const val EXTRA_SECTION = "section"
    }

    private lateinit var webView: WebView
    private lateinit var accessibilityGate: View
    // The pass timer's permission prompt. Unlike the accessibility gate this
    // blocks nothing: it is an offer, dismissible for the session, and gone for
    // good once the permission is granted.
    private lateinit var overlayPrompt: View
    private var overlayPromptDismissed = false
    private var notificationPermissionAsked = false
    private lateinit var rootLayout: android.widget.LinearLayout

    // The "we can't tell which part of this app you're in" card. Unlike the
    // overlay prompt this is not an offer — it is a report that a rule the user
    // wrote is not being honoured the way they wrote it (see the degradation
    // rules at the head of AppParts.kt), so it is worth a permanent place above
    // the settings UI rather than a toast that vanishes.
    private lateinit var partsWarning: View
    private lateinit var partsWarningTitle: TextView
    private lateinit var partsWarningBody: TextView
    private var partsWarningTarget: String? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        // enableEdgeToEdge lays a translucent scrim over a three-button
        // navigation bar so its icons stay legible on arbitrary content. Ours
        // is never arbitrary — paintSystemBars puts a flat colour there and
        // picks the icon shade for it — so the scrim would only be a grey band
        // across the bottom of the page.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            window.isNavigationBarContrastEnforced = false
        }

        // Dynamic layouts are cleaner for extension wrappers
        rootLayout = android.widget.LinearLayout(this).apply {
            orientation = android.widget.LinearLayout.VERTICAL
            layoutParams = android.view.ViewGroup.LayoutParams(
                android.view.ViewGroup.LayoutParams.MATCH_PARENT,
                android.view.ViewGroup.LayoutParams.MATCH_PARENT
            )
            setBackgroundColor(paperColor())
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
                    paintSystemBars(gate = false)
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
        partsWarning = buildPartsWarning()

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
            // The page paints the same colour once it loads; this is only so
            // the first frame is not a white flash on a dark phone.
            setBackgroundColor(paperColor())
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
        rootLayout.addView(partsWarning)
        rootLayout.addView(webView)
        setContentView(rootLayout)

        // With edge-to-edge enforced on SDK 35+, content draws behind the system
        // bars by default — pad the root so the gate/webview stay clear of them.
        // The padding shows the root's background, which paintSystemBars keeps
        // the same colour as whatever is on screen, so the app still reads as
        // filling the display edge to edge.
        //
        // The keyboard is part of this too. Edge-to-edge turns off
        // adjustResize, so without the IME inset the WebView kept its full
        // height and the keyboard simply covered the bottom of the page —
        // including the setup's pinned Continue button and whatever field was
        // being typed into. Padding by the larger of the two shrinks the
        // WebView to the space above the keyboard instead, and the page (a
        // fixed-height column, see #setup-view in options.css) fits itself
        // into that. The display cutout is folded in for phones held sideways,
        // where a notch is not a system bar.
        ViewCompat.setOnApplyWindowInsetsListener(rootLayout) { view, insets ->
            val bars = insets.getInsets(
                WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout()
            )
            val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
            view.setPadding(bars.left, bars.top, bars.right, maxOf(bars.bottom, ime.bottom))
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

        loadOptionsPage(intent)
    }

    // singleTask, so an Intent aimed at an instance that is already alive
    // arrives here instead of at onCreate — which is the normal case for both
    // deep links, since anyone with the accessibility service enabled has had
    // this activity open at least once. Without this the service's leaving
    // Intent would bring an unchanged settings page to the front and the
    // conversation would never open.
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        // Only a deep link reloads the page. Bringing the task forward from
        // the launcher icon arrives here too, and reloading on that would
        // throw away whatever the WebView was holding — a half-finished setup
        // wizard keeps its draft in memory, so a free reload every time
        // somebody tapped home and came back would silently restart it.
        val leave = intent.getBooleanExtra(EXTRA_LEAVE, false)
        val section = intent.getStringExtra(EXTRA_SECTION)
        if (leave || section != null) loadOptionsPage(intent)
    }

    // The options page, with the native bridge script injected into <head>.
    //
    // A deep link arrives as an Intent extra rather than as a real URL, since
    // this page is injected via loadDataWithBaseURL rather than navigated to —
    // folding the extras into the base URL's query string is what lets
    // options.js read them exactly the way it would from a ?section= or
    // ?leave=1 link on the other platforms, with no Android-only branch in the
    // shared code.
    private fun loadOptionsPage(source: Intent?) {
        val html = assets.open("options.html").bufferedReader().use { it.readText() }
        val modifiedHtml = html.replace("<head>", "<head><script src=\"android-bridge.js\"></script>")
        val query = mutableListOf<String>()
        source?.getStringExtra(EXTRA_SECTION)?.let { query.add("section=${Uri.encode(it)}") }
        if (source?.getBooleanExtra(EXTRA_LEAVE, false) == true) {
            query.add("leave=1")
            // One shot. The Intent that started a singleTask activity is kept
            // by the system and handed back on every recreation, so without
            // this a rotation or a process death would reopen the leaving
            // conversation out of nowhere — a modal about removing the app,
            // raised by turning the phone sideways.
            source.removeExtra(EXTRA_LEAVE)
        }
        val baseUrl = if (query.isEmpty()) {
            "file:///android_asset/"
        } else {
            "file:///android_asset/options.html?" + query.joinToString("&")
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

    /**
     * The in-app report that section detection has stopped working.
     *
     * In-app section detection leans on view IDs that belong to Instagram and
     * YouTube, not to us, so it will periodically stop matching and there is no
     * fix available without a new APK. AppParts degrades in ONE direction at
     * the moment of failure — both scopes block the whole target rather than
     * risk an app that quietly never blocks — and this card is the other half
     * of that bargain: the user is told, in the app, which rule is not being
     * honoured and offered the one repair that is entirely in their gift. The
     * gate says it too, for the user who never opens this screen (see
     * CoachingActivity.buildPartNotice); this card is the one that can
     * actually change the rule.
     *
     * Same construction as the overlay prompt above (flat, bordered, one
     * hairline, a micro-label eyebrow), in amber rather than azure because this
     * is a caution rather than an offer.
     */
    private fun buildPartsWarning(): View {
        val card = android.widget.LinearLayout(this).apply {
            orientation = android.widget.LinearLayout.VERTICAL
            layoutParams = android.widget.LinearLayout.LayoutParams(
                android.view.ViewGroup.LayoutParams.MATCH_PARENT,
                android.view.ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply {
                setMargins(dp(16f), dp(16f), dp(16f), 0)
            }
            setPadding(dp(16f), dp(14f), dp(16f), dp(14f))
            background = android.graphics.drawable.GradientDrawable().apply {
                shape = android.graphics.drawable.GradientDrawable.RECTANGLE
                setColor(android.graphics.Color.parseColor(COLOR_SURFACE))
                cornerRadius = dp(8f).toFloat()
                setStroke(dp(1f).coerceAtLeast(1), android.graphics.Color.parseColor(COLOR_AMBER_BORDER))
            }
            visibility = View.GONE
        }

        // The micro-label, in the warning hue: this one is carrying status, so
        // it takes the accent rather than the muted neutral the optional card
        // uses.
        card.addView(TextView(this).apply {
            text = getString(R.string.part_detection_warning_eyebrow)
            setTextColor(android.graphics.Color.parseColor(COLOR_AMBER))
            textSize = 10f
            typeface = android.graphics.Typeface.create(android.graphics.Typeface.DEFAULT, android.graphics.Typeface.BOLD)
            letterSpacing = 0.15f
        })

        partsWarningTitle = TextView(this).apply {
            setTextColor(android.graphics.Color.parseColor(COLOR_TEXT))
            textSize = 16f
            setPadding(0, dp(6f), 0, 0)
        }
        card.addView(partsWarningTitle)

        partsWarningBody = TextView(this).apply {
            setTextColor(android.graphics.Color.parseColor(COLOR_MUTED))
            textSize = 13f
            setPadding(0, dp(6f), 0, dp(12f))
        }
        card.addView(partsWarningBody)

        val actions = android.widget.LinearLayout(this).apply {
            orientation = android.widget.LinearLayout.HORIZONTAL
        }

        actions.addView(Button(this).apply {
            text = getString(R.string.part_detection_warning_block_all)
            setTextColor(android.graphics.Color.parseColor(COLOR_TEXT))
            background = android.graphics.drawable.GradientDrawable().apply {
                shape = android.graphics.drawable.GradientDrawable.RECTANGLE
                setColor(android.graphics.Color.parseColor(COLOR_AMBER_FILL))
                cornerRadius = dp(6f).toFloat()
                setStroke(dp(1f).coerceAtLeast(1), android.graphics.Color.parseColor(COLOR_AMBER_BORDER))
            }
            minHeight = dp(44f)
            setOnClickListener { blockAllOfWarnedTarget() }
        })

        actions.addView(Button(this).apply {
            text = getString(R.string.part_detection_warning_dismiss)
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
                // "Keep trying" resets the run of misses rather than setting a
                // dismissed flag. The rule stays exactly as the user wrote it,
                // and if detection is still broken the card comes back after
                // another MISS_WARNING_THRESHOLD failures — which is the truth,
                // and is recoverable if the next app update fixes it.
                partsWarningTarget?.let { AppParts.clearMisses(this@MainActivity, it) }
                partsWarning.visibility = View.GONE
                partsWarningTarget = null
            }
        })

        card.addView(actions)
        return card
    }

    // Shows the card for the worst-affected target, or hides it. Cheap enough
    // to run on every resume: one SharedPreferences read of a map that is empty
    // for everyone whose rules are working.
    private fun refreshPartsWarning() {
        val warning = AppParts.pendingWarning(this)
        if (warning == null) {
            partsWarningTarget = null
            partsWarning.visibility = View.GONE
            return
        }
        val label = targetLabel(warning.target)
        partsWarningTarget = warning.target
        partsWarningTitle.text = getString(R.string.part_detection_warning_title, label)
        // Three bodies for two scopes, because an 'only' rule degrades for two
        // different reasons — a part we can never recognise, or a screen we
        // missed — and the two call for different repairs. Both block all of
        // the app, as does 'except', which is why 'except' keeps one piece of
        // copy. See DetectionWarning.refused and the head of AppParts.kt.
        partsWarningBody.text = getString(
            when {
                warning.scope == AppParts.SCOPE_EXCEPT -> R.string.part_detection_warning_body_except
                warning.refused -> R.string.part_detection_warning_body_only_refused
                else -> R.string.part_detection_warning_body_only
            },
            label
        )
        partsWarning.visibility = View.VISIBLE
    }

    private fun blockAllOfWarnedTarget() {
        val target = partsWarningTarget ?: return
        val label = targetLabel(target)
        AppParts.blockAllOf(this, target)
        partsWarning.visibility = View.GONE
        partsWarningTarget = null
        android.widget.Toast.makeText(
            this,
            getString(R.string.part_detection_warning_blocked_toast, label),
            android.widget.Toast.LENGTH_LONG
        ).show()
        // The settings UI behind this card read appLimits when it rendered and
        // will write the whole map back on its next save, so a native edit it
        // never saw would be silently undone. Reloading is the cheap, obviously
        // correct fix — the page is injected from assets and holds no state
        // worth preserving across it.
        webView.reload()
    }

    // An app's own name where the package is installed, the raw target
    // otherwise — which is also the right answer for a website, since a
    // hostname is its own best label.
    private fun targetLabel(target: String): String = try {
        packageManager.getApplicationLabel(packageManager.getApplicationInfo(target, 0)).toString()
    } catch (e: Exception) {
        target
    }

    /**
     * Coming back from the Play Store is the one moment a redeemed code can
     * have landed, and nothing used to look. The redeem poll gave up after two
     * minutes; a user who took longer than that — or who redeemed on the web
     * and came back later — had a granted purchase sitting in their Play
     * account that the app would only notice if they thought to press
     * "Recover an interrupted purchase" by hand.
     *
     * This is the same sweep that button runs, so a grant is credited whenever
     * the user returns, however long it took. It is cheap when there is
     * nothing to find: queryPurchasesAsync answers from Play's local cache and
     * no backend call happens unless an actual purchase turns up.
     *
     * The WebView is told either way, because the paywall it is showing was
     * rendered before any of this and has a stale balance on it.
     */
    private fun sweepForPurchasesOnReturn() {
        BillingManager.restore {
            runOnUiThread {
                webView.evaluateJavascript(
                    "window.dispatchEvent(new Event('intention-app-active'))", null
                )
            }
        }
    }

    override fun onResume() {
        super.onResume()
        sweepForPurchasesOnReturn()
        if (!isAccessibilityServiceEnabled()) {
            accessibilityGate.visibility = View.VISIBLE
            webView.visibility = View.GONE
            overlayPrompt.visibility = View.GONE
            // Detection cannot have been running without the service, and the
            // gate is a hard stop: nothing else belongs on top of it.
            partsWarning.visibility = View.GONE
            paintSystemBars(gate = true)
        } else {
            paintSystemBars(gate = false)
            accessibilityGate.visibility = View.GONE
            webView.visibility = View.VISIBLE
            refreshPartsWarning()
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

    private fun isDarkTheme(): Boolean =
        (resources.configuration.uiMode and android.content.res.Configuration.UI_MODE_NIGHT_MASK) ==
            android.content.res.Configuration.UI_MODE_NIGHT_YES

    // The options page's --paper (shared/tokens.css) for the current theme.
    // The root layout is padded clear of the status and navigation bars, and
    // that padding shows the root's background — so unless it is the page's
    // colour, the page sits between two bands that are not part of it. It used
    // to be the gate's #0f1115: a dark strip under the status bar and another
    // behind the navigation bar, with dark icons on them on a light phone.
    private fun paperColor(): Int = ContextCompat.getColor(this, R.color.paper)

    // The strips behind the status and navigation bars belong to whatever is
    // on screen: the page's paper for the WebView, the gate's own near-black
    // while the accessibility gate is up (its text is light-on-dark whatever
    // the system theme). The bar icons follow, so they stay legible on it.
    private fun paintSystemBars(gate: Boolean) {
        val dark = gate || isDarkTheme()
        rootLayout.setBackgroundColor(
            if (gate) android.graphics.Color.parseColor(COLOR_GATE) else paperColor()
        )
        WindowCompat.getInsetsController(window, window.decorView).apply {
            isAppearanceLightStatusBars = !dark
            isAppearanceLightNavigationBars = !dark
        }
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
