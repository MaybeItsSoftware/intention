package uk.co.maybeitssoftware.intention

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.os.Bundle
import android.provider.Browser
import android.util.Log
import android.view.View
import android.webkit.WebSettings
import android.webkit.WebView
import android.widget.TextView
import androidx.activity.enableEdgeToEdge
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat

class CoachingActivity : AppCompatActivity() {

    companion object {
        private const val TAG = "CoachingActivity"
        // Blank page to send the browser to on decline. No network, no content,
        // and its "host" has no dot, so findBlockedDomain never matches it.
        private const val BLANK_TAB_URL = "about:blank"

        // Why the whole app is being blocked when the user asked for only part
        // of it to be. Set by the accessibility service from
        // AppParts.PartVerdict; absent for every ordinary block, which is
        // almost all of them.
        const val EXTRA_PART_NOTICE = "partNotice"
        const val PART_NOTICE_UNRESOLVED = "unresolved"
        const val PART_NOTICE_REFUSED = "refused"

        // The dark surface the coach page itself uses, so the strip reads as
        // part of the same screen rather than as system chrome, with the amber
        // hairline the in-app warning card already uses for caution.
        private const val COLOR_SURFACE = "#25232f"
        private const val COLOR_TEXT = "#f5f4f7"
        private const val COLOR_AMBER = "#ffbf00"
    }

    private lateinit var webView: WebView
    private var domain: String = ""
    private var isApp: Boolean = true
    private var browserPackage: String? = null

    // Launching this screen over a playing video looks, to the player, like a
    // background switch — so YouTube and friends pop into picture-in-picture
    // ON TOP of the coach and keep playing, which defeats the entire
    // intervention. Every well-behaved player also pauses on a permanent
    // audio-focus loss and stays paused, so the gate holds exclusive focus
    // for as long as it is on screen: the miniplayer freezes the moment the
    // coach appears. Focus is dropped in onStop, so a granted pass gets its
    // sound back as soon as the coach goes away.
    private var focusRequest: AudioFocusRequest? = null

    override fun onStart() {
        super.onStart()
        // Nothing may sit on top of the block, least of all a pass timer: this
        // screen goes up when a pass has run out, or for a second blocked
        // target while another one's pass is still running. The accessibility
        // service hides it for our own package anyway; this is the guarantee,
        // not the mechanism.
        SessionOverlay.hide(applicationContext)

        val audioManager = getSystemService(Context.AUDIO_SERVICE) as AudioManager
        val request = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
            .setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_MEDIA)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                    .build()
            )
            .build()
        audioManager.requestAudioFocus(request)
        focusRequest = request
    }

    override fun onStop() {
        focusRequest?.let {
            (getSystemService(Context.AUDIO_SERVICE) as AudioManager).abandonAudioFocusRequest(it)
        }
        focusRequest = null
        super.onStop()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()

        // This screen must fully cover the display so the block can't be swiped
        // away. The old android:windowFullscreen theme flag doesn't play well
        // with SDK 35+ edge-to-edge enforcement, so hide the bars explicitly
        // instead; BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE lets a swipe reveal
        // them temporarily without the coach ever losing fullscreen on resume.
        WindowCompat.getInsetsController(window, window.decorView).apply {
            hide(WindowInsetsCompat.Type.systemBars())
            systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        }

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
        // The gate is the WebView, plus — only when a part rule could not be
        // carried out — one line above it saying so. See buildPartNotice.
        val notice = buildPartNotice(intent.getStringExtra(EXTRA_PART_NOTICE), appLabel)
        if (notice == null) {
            setContentView(webView)
        } else {
            val root = android.widget.LinearLayout(this).apply {
                orientation = android.widget.LinearLayout.VERTICAL
                setBackgroundColor(android.graphics.Color.parseColor(COLOR_SURFACE))
            }
            root.addView(notice)
            webView.layoutParams = android.widget.LinearLayout.LayoutParams(
                android.view.ViewGroup.LayoutParams.MATCH_PARENT,
                0,
                1f
            )
            root.addView(webView)
            setContentView(root)
        }

        // The keyboard. Edge-to-edge turns adjustResize off, so the WebView
        // kept its full height and the keyboard covered the bottom of the
        // gate — the composer, Send, the close button, the reason field and
        // the Unlock button under it — leaving the user to type blind and
        // hunt for a button. Padding by the IME inset shrinks the page to the
        // space above the keyboard instead, as MainActivity does. Only the IME
        // and the cutout: the system bars are hidden on this screen.
        val content = findViewById<View>(android.R.id.content)
        ViewCompat.setOnApplyWindowInsetsListener(content) { view, insets ->
            val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
            val cutout = insets.getInsets(WindowInsetsCompat.Type.displayCutout())
            view.setPadding(cutout.left, cutout.top, cutout.right, maxOf(cutout.bottom, ime.bottom))
            insets
        }

        // Initialize background helper
        BackgroundJsHelper.init(applicationContext)

        // The gate is usually the first thing to run in the process — the
        // accessibility service launches it the moment a blocked app opens,
        // with MainActivity never having been touched. BillingManager is an
        // object, so without this its client stayed null here and connect()
        // short-circuited to onReady(false): the paywall reported "Google Play
        // billing is unavailable on this device" and could sell nothing, at
        // the exact moment someone was being asked to buy.
        BillingManager.init(applicationContext)

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

    /**
     * The one line that keeps fail-closed honest.
     *
     * With APP_PARTS unverified on every signal, "block only Reels" is in
     * practice "block Instagram" — AppParts gates whenever it cannot tell what
     * is on screen, because the alternative is an app that quietly never
     * blocks. That is the right call, but it means a user can meet a gate they
     * were told they would not meet, and the only other place Intention admits
     * it is a card inside the app they are deliberately not opening. So the
     * gate says it here, where they are actually standing.
     *
     * Deliberately text and nothing else. It is one sentence, it does not
     * cover the coach, and it offers no button — the exit and the settings are
     * the coach's own, already a tap away below this strip, and a second route
     * out of a block is a second thing to get wrong. The two wordings differ
     * because the two causes suggest different repairs: a part this build can
     * never recognise will not start working, where a screen we simply missed
     * may well come back after the next app update.
     *
     * Returns null — and the activity then lays out exactly as it always did —
     * for every block that is not a degraded part verdict.
     */
    private fun buildPartNotice(kind: String?, appLabel: String): View? {
        val body = when (kind) {
            PART_NOTICE_REFUSED -> R.string.part_gate_notice_refused
            PART_NOTICE_UNRESOLVED -> R.string.part_gate_notice_unresolved
            else -> return null
        }
        val density = resources.displayMetrics.density
        fun dp(value: Float) = (value * density).toInt()
        return TextView(this).apply {
            text = getString(body, appLabel)
            setTextColor(android.graphics.Color.parseColor(COLOR_TEXT))
            textSize = 13f
            layoutParams = android.widget.LinearLayout.LayoutParams(
                android.view.ViewGroup.LayoutParams.MATCH_PARENT,
                android.view.ViewGroup.LayoutParams.WRAP_CONTENT
            )
            // Enough top padding to clear the status bar the coach hides but a
            // swipe can bring back transiently.
            setPadding(dp(16f), dp(28f), dp(16f), dp(12f))
            // A single hairline under the strip, in the caution hue: the
            // surface is drawn over an amber rectangle, inset by 1dp at the
            // bottom so only that edge shows through. No card, no shadow — it
            // is a rule, not a dialog.
            background = android.graphics.drawable.LayerDrawable(
                arrayOf(
                    android.graphics.drawable.GradientDrawable().apply {
                        shape = android.graphics.drawable.GradientDrawable.RECTANGLE
                        setColor(android.graphics.Color.parseColor(COLOR_AMBER))
                    },
                    android.graphics.drawable.GradientDrawable().apply {
                        shape = android.graphics.drawable.GradientDrawable.RECTANGLE
                        setColor(android.graphics.Color.parseColor(COLOR_SURFACE))
                    }
                )
            ).apply { setLayerInset(1, 0, 0, 0, dp(1f).coerceAtLeast(1)) }
        }
    }

    // singleInstance + SINGLE_TOP: a second gate request while this one is up
    // arrives here instead of building a new screen. It used to be dropped,
    // so a link that went from the browser into the app left the site's gate
    // standing in front of the app — with a decline that opened a blank tab in
    // a browser the user had already left. Show the gate for what is actually
    // in front; the same target asking again changes nothing.
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        val next = intent.getStringExtra("domain") ?: return
        if (next == domain && intent.getStringExtra("mode") == this.intent.getStringExtra("mode")) return
        setIntent(intent)
        recreate()
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
