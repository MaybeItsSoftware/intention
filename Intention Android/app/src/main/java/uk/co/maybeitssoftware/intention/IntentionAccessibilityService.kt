package uk.co.maybeitssoftware.intention

import android.accessibilityservice.AccessibilityService
import android.content.Context
import android.content.BroadcastReceiver
import android.content.Intent
import android.content.IntentFilter
import android.media.AudioManager
import android.os.PowerManager
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.KeyEvent
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import org.json.JSONObject

class IntentionAccessibilityService : AccessibilityService() {

    companion object {
        private const val TAG = "IntentionAccessService"
        private const val CONTENT_CHECK_THROTTLE_MS = 400L
        // Fire the re-check just after the session's expiration timestamp so
        // the timestamp comparison in sessionExpiresAt sees it as expired.
        private const val EXPIRY_RECHECK_BUFFER_MS = 250L
        // How long to hold off re-showing the coach for a (browser, domain)
        // pair after the user dismisses it and the browser could not be
        // diverted off the blocked page (see CoachingActivity.closeBlockedTab).
        // The blocked tab is still in front, so without this the dedupe-clearing
        // on every browser-foreground event would re-trigger the coach at once.
        private const val DISMISS_DEBOUNCE_MS = 60_000L
        // The same grace when the divert did work. It only has to cover the
        // hand-off — the URL bar can still read the blocked host for a moment
        // while the blank tab opens — and is dropped as soon as the browser is
        // seen off the blocked site, so closing that tab re-arms the coach.
        private const val DIVERTED_GRACE_MS = 10_000L
        // Coaching modes understood by coaching.js (via CoachingActivity).
        private const val MODE_GATE = "gate"
        private const val MODE_CHECKIN = "checkin"
        // How recently a session must have run out for the relaunched coach to
        // open as a check-in rather than a fresh gate.
        private const val CHECKIN_WINDOW_MS = 5 * 60_000L
        // Floor between picture-in-picture pause dispatches, so a stream of
        // content events from a playing PiP surface can't machine-gun the
        // active media session.
        private const val PIP_PAUSE_THROTTLE_MS = 1_000L

        @Volatile
        var instance: IntentionAccessibilityService? = null
            private set

        // Best-effort address-bar view IDs for popular Android browsers. These are
        // internal view IDs, not a public API, so a browser update can rename them
        // and silently stop matching for that browser.
        private val BROWSER_URL_BAR_IDS: Map<String, List<String>> = mapOf(
            "com.android.chrome" to listOf("url_bar"),
            "com.chrome.beta" to listOf("url_bar"),
            "com.chrome.dev" to listOf("url_bar"),
            "com.chrome.canary" to listOf("url_bar"),
            "com.microsoft.emmx" to listOf("url_bar"),
            "com.brave.browser" to listOf("url_bar"),
            "com.vivaldi.browser" to listOf("url_bar"),
            "com.kiwibrowser.browser" to listOf("url_bar"),
            "com.sec.android.app.sbrowser" to listOf("location_bar_edit_text"),
            "org.mozilla.firefox" to listOf("mozac_browser_toolbar_url_view", "url_bar_title"),
            "org.mozilla.firefox_beta" to listOf("mozac_browser_toolbar_url_view", "url_bar_title"),
            "org.mozilla.fenix" to listOf("mozac_browser_toolbar_url_view"),
            "org.mozilla.focus" to listOf("mozac_browser_toolbar_url_view"),
            "com.duckduckgo.mobile.android" to listOf("omnibarTextInput"),
            "com.opera.browser" to listOf("url_field"),
            "com.opera.browser.beta" to listOf("url_field"),
            "com.opera.gx" to listOf("url_field"),
            // Lower-confidence entries: view IDs guessed from the browser's
            // underlying engine rather than confirmed on-device.
            "com.opera.mini.native" to listOf("url_field"),
            "com.opera.mini.native.beta" to listOf("url_field"),
            "com.UCMobile.intl" to listOf("address"),
            "com.ecosia.android" to listOf("mozac_browser_toolbar_url_view"),
            "com.cloudmosa.puffinFree" to listOf("address_bar", "url"),
            "com.cloudmosa.puffin" to listOf("address_bar", "url")
        )

        // ===================================================================
        // LEAVING: INTERPOSING WHEN THE USER HEADS FOR UNINSTALL
        // ===================================================================
        //
        // The boundary first, because it is the licence to ship any of this:
        // the coach NEVER reads an accessibility node, and NEVER drives an
        // accessibility action. Everything below answers exactly one question
        // — "is Settings showing Intention's own App info page, or this
        // service's own page under Accessibility?" — from the fixed table of
        // package names and view-id suffixes compiled into the APK, and its
        // only response is to launch OUR OWN activity. From there it is the
        // ordinary WebView flow: the same leaving conversation the browser
        // build opens at options.html?leave=1, one flow with two entry points.
        //
        // Note "this service's own page", not "the Accessibility list". An
        // earlier version matched the list, which is to say it matched every
        // accessibility service installed on the device, ours among them;
        // the head of RemovalSurface.kt records what that cost the user who
        // had gone there for a screen reader.
        // The model is never shown a node, never asked what to look for, and
        // cannot press anything. Play's AccessibilityService policy requires
        // this automation to be deterministic, rule-based and script-
        // following; a `setOf` of literals and a bounded walk is what that
        // looks like. If a future change lets the model choose what to match
        // on, or lets anything here call `performAction`, the app becomes
        // removable from Play — the same rule the head of AppParts.kt states.
        //
        // Deliberately NOT performGlobalAction(GLOBAL_ACTION_BACK). Fighting
        // the user for control of the Back button is the behaviour that gets
        // an accessibility app pulled, and worse, it traps people: they are
        // pressing the one control that is supposed to always work and it is
        // not working. Launching over the top interrupts just as well, is
        // dismissible with the very Back press we refuse to steal, and leaves
        // Settings exactly where they left it for when they come back to
        // finish the job. They can always finish the job.
        //
        // The Play Permissions Declaration Form must describe this use BEFORE
        // the next publish-android.yml run. That is a release blocker, not a
        // code detail.

        // Settings, as shipped by AOSP and by the skins that replace it. A
        // package missing from here costs nothing but silence on that device;
        // a wrong one costs a walk over an unrelated app's window, which is
        // why this is a fixed set rather than anything matched by prefix.
        private val SETTINGS_PACKAGES = setOf(
            "com.android.settings",
            "com.samsung.android.settings",
            "com.miui.securitycenter",
            "com.oplus.settings",
            "com.coloros.settings"
        )

        // Both floors under how often our activity can appear — the ten-minute
        // debounce and the fifteen-minute stand-down after every outcome —
        // live in LeavePolicy, in shared storage, where a restart of this
        // service process cannot reset them. They used to be a field on this
        // class and thirty seconds long, which is a rate limit rather than a
        // floor; read the head of LeavePolicy.kt before changing either.

        // The bounded walk, with the same numbers and the same reasoning as
        // AppParts.MAX_NODES/MAX_DEPTH — held separately because that bound is
        // tuned for finding a tab strip inside a feed and this one is tuned for
        // finding a header on a Settings page; a future change to either
        // should not silently move the other. 400 handles covers an App info
        // page in full, 12 levels covers its preference list.
        private const val REMOVAL_WALK_MAX_NODES = 400
        private const val REMOVAL_WALK_MAX_DEPTH = 12

        // Which shapes count as "Settings is showing Intention's own page" is
        // RemovalSurfaceMatcher's, not this class's: it is a decision worth
        // testing without a device, and the view ids it turns on belong next
        // to the reasoning about why each one is safe.
    }

    private val lastContentCheckAt = mutableMapOf<String, Long>()
    private val lastSeenHost = mutableMapOf<String, String>()
    private val dismissedUntil = mutableMapOf<String, Long>()

    private val handler = Handler(Looper.getMainLooper())
    private val expiryRecheck = Runnable { recheckForeground() }
    private val screenReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            if (intent.action == Intent.ACTION_SCREEN_OFF) {
                ForegroundPass.sync(applicationContext, null)
                SessionOverlay.hide(applicationContext)
                handler.removeCallbacks(expiryRecheck)
            } else if (intent.action == Intent.ACTION_SCREEN_ON) {
                recheckForeground()
            }
        }
    }
    private var screenReceiverRegistered = false
    // An app installed after setup that is the same service as a blocked site
    // (Instagram, with instagram.com blocked) would be a way round the block,
    // so the background joins it to the blocklist on install — see
    // linkInstalledApp in background.js, which owns the site↔app table and the
    // rules. Registered here rather than in the manifest because Android 8+
    // no longer delivers PACKAGE_ADDED to manifest receivers; this service is
    // what does the blocking, so while it is off there is nothing to protect.
    // An update arrives as a PACKAGE_ADDED too, flagged EXTRA_REPLACING, and
    // is ignored: that app was already here, and a choice already made.
    private val installReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            if (intent.getBooleanExtra(Intent.EXTRA_REPLACING, false)) return
            val pkg = intent.data?.schemeSpecificPart ?: return
            val message = JSONObject()
                .put("action", "appInstalled")
                .put("packageName", pkg)
                .put("label", getAppLabel(pkg))
            BackgroundJsHelper.init(applicationContext)
            BackgroundJsHelper.sendMessage(message.toString()) { response ->
                Log.d(TAG, "Install of $pkg: $response")
            }
        }
    }
    private var installReceiverRegistered = false
    private var lastForegroundPackage: String? = null
    private var lastPipPauseAt = 0L
    // Which blocked packages have already eaten their one pause for the
    // current PiP appearance — see checkPipBypass.
    private val pipPausedOnce = mutableSetOf<String>()

    override fun onServiceConnected() {
        super.onServiceConnected()
        instance = this
        // A pass can outlive this service — a reboot, an app update, the system
        // reclaiming the process — so put its timer back rather than waiting
        // for the next app switch to notice.
        if (!screenReceiverRegistered) {
            registerReceiver(screenReceiver, IntentFilter().apply {
                addAction(Intent.ACTION_SCREEN_OFF)
                addAction(Intent.ACTION_SCREEN_ON)
            })
            screenReceiverRegistered = true
        }
        if (!installReceiverRegistered) {
            registerReceiver(installReceiver, IntentFilter(Intent.ACTION_PACKAGE_ADDED).apply {
                addDataScheme("package")
            })
            installReceiverRegistered = true
        }
        val root = rootInActiveWindow
        val target = foregroundTarget(root?.packageName?.toString(), root)
        ForegroundPass.sync(applicationContext, target)
        SessionOverlay.sync(applicationContext, target)
    }

    override fun onDestroy() {
        if (instance == this) instance = null
        unregisterReceivers()
        ForegroundPass.sync(applicationContext, null)
        handler.removeCallbacks(expiryRecheck)
        // The pass timer is a window this service added to the WindowManager,
        // so it does not go away with the service: left behind it would sit on
        // the user's screen with nothing left to tick it. Both teardown paths
        // are covered — onUnbind runs when accessibility is switched off,
        // onDestroy when the process is going.
        SessionOverlay.hide(applicationContext)
        super.onDestroy()
    }

    override fun onUnbind(intent: Intent?): Boolean {
        unregisterReceivers()
        ForegroundPass.sync(applicationContext, null)
        SessionOverlay.hide(applicationContext)
        return super.onUnbind(intent)
    }

    private fun unregisterReceivers() {
        if (screenReceiverRegistered) {
            unregisterReceiver(screenReceiver)
            screenReceiverRegistered = false
        }
        if (installReceiverRegistered) {
            unregisterReceiver(installReceiver)
            installReceiverRegistered = false
        }
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent) {
        val eventType = event.eventType
        if (eventType != AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED &&
            eventType != AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED
        ) return

        // Before anything package-specific: a blocked app may be living on in
        // a picture-in-picture window regardless of which app this event is
        // from, so the check can't sit behind the per-package filtering below.
        checkPipBypass()

        val packageName = event.packageName?.toString() ?: return

        // Update the pass before checking it, and remove its floating window
        // as soon as a different app comes to the foreground.
        val activeRoot = rootInActiveWindow ?: getRootFromEvent(event)
        val activePackage = activeRoot?.packageName?.toString() ?: packageName
        val target = foregroundTarget(activePackage, activeRoot)
        ForegroundPass.sync(applicationContext, target)
        SessionOverlay.sync(applicationContext, target)
        if (target == null) handler.removeCallbacks(expiryRecheck)

        // Skip our own app packages
        if (packageName == this.packageName) return

        // Initialize background helper if not already done
        BackgroundJsHelper.init(applicationContext)

        if (eventType == AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED) {
            Log.d(TAG, "Foreground app changed to: $packageName")
            lastForegroundPackage = packageName

            // On a window state change only, never on the content changes a
            // scrolling Settings list emits by the dozen — see the head of the
            // leaving section in the companion above. Returning when it fired
            // is not a policy, just an economy: our own activity is in front
            // now, so evaluating this Settings window as a blockable app or a
            // browser would be answering a question about a window nobody is
            // looking at.
            if (packageName in SETTINGS_PACKAGES && checkRemovalSurface(event)) return

            if (isAppBlocked(packageName)) {
                Log.d(TAG, "App is blocked: $packageName. Checking for active session...")
                val expiresAt = sessionExpiresAt(packageName)
                if (expiresAt == null) {
                    // "Block only Reels" is answered here, and only here — on a
                    // window state change, never on the content changes a
                    // scrolling feed emits by the dozen. AppParts costs one
                    // prefs read when the target has no part rule, which is
                    // every target that existed before this feature, so the
                    // common path is unchanged. Only a screen we positively
                    // recognised as outside the rule lets the app through:
                    // every flavour of "we could not tell" gates, for both
                    // scopes. See the head of AppParts.kt for why that is the
                    // right way round with an unverified table, and why the
                    // gate has to say so when it happens.
                    val verdict = AppParts.verdictForApp(this, packageName) {
                        rootInActiveWindow ?: getRootFromEvent(event)
                    }
                    if (verdict.gated) {
                        Log.d(TAG, "No active session for $packageName. Blocking and launching Coach!")
                        launchCoachingOverlay(
                            packageName,
                            isApp = true,
                            label = getAppLabel(packageName),
                            partNotice = partNoticeFor(verdict)
                        )
                    } else {
                        // partId is never null here: the only way past the
                        // gate now is a screen we positively recognised.
                        Log.d(TAG, "No active session for $packageName, but its part rule does not " +
                            "cover this section (${verdict.partId}). Letting it through.")
                    }
                } else {
                    Log.d(TAG, "Active session exists for $packageName. Allowing access until $expiresAt.")
                    scheduleExpiryRecheck(expiresAt)
                }
            }

            // A browser coming (back) to the foreground must be re-evaluated
            // even when the URL bar still shows the same host — e.g. the user
            // swiped the coach away and reopened the browser from recents.
            // Drop the dedupe/throttle state so checkWebsiteBlock runs fresh.
            if (BROWSER_URL_BAR_IDS.containsKey(packageName)) {
                lastSeenHost.remove(packageName)
                lastContentCheckAt.remove(packageName)
            }
        }

        val urlBarIds = BROWSER_URL_BAR_IDS[packageName] ?: return
        checkWebsiteBlock(event, packageName, urlBarIds)
    }

    override fun onInterrupt() {
        Log.d(TAG, "Accessibility Service Interrupted")
    }

    // Called by CoachingActivity when the user dismisses the coach for a
    // website without granting a pass, so the still-open blocked tab doesn't
    // immediately re-trigger the coach the next time this browser is checked.
    // `divertedAway` says whether we managed to open a blank tab over it, which
    // is a much shorter grace — see the two constants above.
    fun recordDismissal(browserPackage: String, domain: String, divertedAway: Boolean) {
        val grace = if (divertedAway) DIVERTED_GRACE_MS else DISMISS_DEBOUNCE_MS
        dismissedUntil["$browserPackage|$domain"] = System.currentTimeMillis() + grace
    }

    private fun isDismissed(browserPackage: String, domain: String): Boolean {
        val until = dismissedUntil["$browserPackage|$domain"] ?: return false
        return System.currentTimeMillis() < until
    }

    // Once this browser is seen showing anything but the blocked site, the
    // dismissal has done its job. Dropping it here — rather than waiting the
    // full grace period out — is what stops "decline, then close the blank tab"
    // from being a free pass back onto the site.
    private fun clearDismissals(browserPackage: String) {
        if (dismissedUntil.isEmpty()) return
        dismissedUntil.keys.removeAll { it.startsWith("$browserPackage|") }
    }

    private fun checkWebsiteBlock(event: AccessibilityEvent, packageName: String, urlBarIds: List<String>) {
        val now = System.currentTimeMillis()
        val lastCheck = lastContentCheckAt[packageName] ?: 0L
        if (now - lastCheck < CONTENT_CHECK_THROTTLE_MS) return

        val root = rootInActiveWindow ?: getRootFromEvent(event) ?: return
        val urlText = findBrowserUrlText(root, packageName, urlBarIds) ?: return
        lastContentCheckAt[packageName] = now
        if (isBlankPage(urlText)) {
            onBrowserLeftBlockedSite(packageName)
            return
        }
        val host = extractHost(urlText) ?: return
        val hostChanged = lastSeenHost[packageName] != host
        lastSeenHost[packageName] = host

        val matchedDomain = findBlockedDomain(host)
        if (matchedDomain == null) {
            clearDismissals(packageName)
            return
        }
        val expiresAt = sessionExpiresAt(matchedDomain)
        if (expiresAt != null) {
            // Keep an expiry re-check armed while the user stays on the site,
            // since no further host change will trigger a check.
            scheduleExpiryRecheck(expiresAt)
        } else if (hostChanged && !isDismissed(packageName, matchedDomain)) {
            Log.d(TAG, "Website is blocked: $host (matched $matchedDomain), no active session. Launching Coach!")
            launchCoachingOverlay(matchedDomain, isApp = false, label = matchedDomain, browserPackage = packageName)
        }
    }

    // The coach covering a playing video looks, to the player, like a
    // background switch, so the video pops into picture-in-picture on top of
    // the gate. CoachingActivity freezes it by holding audio focus while the
    // gate is up — but nothing stops the user tapping play in the leftover
    // PiP window afterwards and watching on with no session and no tracking.
    // Android has no API to dismiss another app's PiP window, so the
    // effective equivalent is a pause dispatched at whatever is playing
    // whenever a blocked, session-less package is caught in one.
    //
    // The media-key route is deliberately blunt (it hits the ACTIVE session,
    // which is not provably the PiP app without Notification Access), so two
    // guards keep it from harassing innocent audio: it only fires while
    // something is actually playing, and only once per playback burst —
    // re-armed when the audio stops — so every tap of play in the PiP is
    // answered with a pause, while unrelated music next to a parked PiP
    // window costs at most one wrongly-eaten pause per resume.
    private fun checkPipBypass() {
        val now = System.currentTimeMillis()
        if (now - lastPipPauseAt < PIP_PAUSE_THROTTLE_MS) return

        val pipPackages = windows
            .filter { it.isInPictureInPictureMode }
            .mapNotNull { it.root?.packageName?.toString() }
        if (pipPackages.isEmpty()) {
            // Every PiP window is gone; the next appearance earns a fresh pause.
            pipPausedOnce.clear()
            return
        }

        val offender = pipPackages.firstOrNull {
            it != packageName && isAppBlocked(it) && sessionExpiresAt(it) == null
        } ?: return

        val audioManager = getSystemService(Context.AUDIO_SERVICE) as AudioManager
        if (!audioManager.isMusicActive) {
            // Nothing is playing: the pause landed, or the user stopped it
            // themselves. Re-arm so the next tap of play with this PiP still
            // on screen gets paused again — otherwise one pause per
            // appearance would make "tap play twice" the workaround.
            pipPausedOnce.remove(offender)
            return
        }
        if (offender in pipPausedOnce) return

        lastPipPauseAt = now
        pipPausedOnce.add(offender)
        Log.d(TAG, "Blocked app $offender playing in PiP without a session — pausing playback")
        // KEYCODE_MEDIA_PAUSE, not PLAY_PAUSE: idempotent, so a mis-aimed
        // dispatch can pause something but never start it.
        audioManager.dispatchMediaKeyEvent(KeyEvent(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_MEDIA_PAUSE))
        audioManager.dispatchMediaKeyEvent(KeyEvent(KeyEvent.ACTION_UP, KeyEvent.KEYCODE_MEDIA_PAUSE))
    }

    // Re-evaluates whatever is currently in the foreground, independent of
    // accessibility events. Called when a session expiry timer or the native
    // check-in alarm fires, so the user is cut off mid-use instead of only on
    // the next app switch or navigation.
    fun recheckForeground() {
        handler.removeCallbacks(expiryRecheck)
        val root = rootInActiveWindow
        val foreground = root?.packageName?.toString() ?: lastForegroundPackage
        // Expiry is the pass timer's most important moment. This runs when a
        // pass runs out — from the alarm or from the in-process re-check — and
        // again once one has been ended early, and the badge has to go in both
        // cases; a live pass that is merely still running re-renders instead.
        val target = foregroundTarget(foreground, root)
        // Hosts were deduped while the pass was live; an expiry needs a fresh
        // check, but first retain the loaded host for address-bar edit mode.
        lastSeenHost.clear()
        ForegroundPass.sync(applicationContext, target)
        SessionOverlay.sync(applicationContext, target)
        if (target != null) sessionExpiresAt(target)?.let { scheduleExpiryRecheck(it) }

        val packageName = foreground ?: return
        if (packageName == this.packageName) return

        if (isAppBlocked(packageName)) {
            val expiresAt = sessionExpiresAt(packageName)
            if (expiresAt == null) {
                // The same part check as the foreground path. This one is
                // driven by a timer rather than an event, so it happens once
                // when a pass runs out — it is not the per-event walk the
                // bound in AppParts exists to prevent — and skipping it would
                // mean a pass expiring while the user is in their DMs gates
                // them out of a section their rule never covered.
                val verdict = AppParts.verdictForApp(this, packageName) { root }
                if (verdict.gated) {
                    Log.d(TAG, "Session expired while $packageName in foreground. Launching Coach!")
                    launchCoachingOverlay(
                        packageName,
                        isApp = true,
                        label = getAppLabel(packageName),
                        mode = if (justExpired(packageName)) MODE_CHECKIN else MODE_GATE,
                        partNotice = partNoticeFor(verdict)
                    )
                }
            } else {
                scheduleExpiryRecheck(expiresAt)
            }
            return
        }

        val urlBarIds = BROWSER_URL_BAR_IDS[packageName] ?: return
        val urlText = findBrowserUrlText(root ?: return, packageName, urlBarIds) ?: return
        if (isBlankPage(urlText)) {
            onBrowserLeftBlockedSite(packageName)
            return
        }
        val host = extractHost(urlText) ?: return
        lastSeenHost[packageName] = host
        val matchedDomain = findBlockedDomain(host)
        if (matchedDomain == null) {
            clearDismissals(packageName)
            return
        }
        val expiresAt = sessionExpiresAt(matchedDomain)
        if (expiresAt == null && !isDismissed(packageName, matchedDomain)) {
            Log.d(TAG, "Session expired while $host in foreground. Launching Coach!")
            launchCoachingOverlay(
                matchedDomain,
                isApp = false,
                label = matchedDomain,
                browserPackage = packageName,
                mode = if (justExpired(matchedDomain)) MODE_CHECKIN else MODE_GATE
            )
        } else if (expiresAt != null) {
            scheduleExpiryRecheck(expiresAt)
        }
    }

    private fun scheduleExpiryRecheck(expiresAt: Long) {
        val delay = (expiresAt - System.currentTimeMillis()).coerceAtLeast(0L) + EXPIRY_RECHECK_BUFFER_MS
        handler.removeCallbacks(expiryRecheck)
        handler.postDelayed(expiryRecheck, delay)
    }

    private fun foregroundTarget(packageName: String?, root: AccessibilityNodeInfo?): String? {
        if (packageName == null || packageName == this.packageName) return null
        val power = getSystemService(Context.POWER_SERVICE) as PowerManager
        if (!power.isInteractive) return null
        if (isAppBlocked(packageName)) return packageName
        val urlIds = BROWSER_URL_BAR_IDS[packageName] ?: return null
        val url = root?.let { findBrowserUrlText(it, packageName, urlIds) }
        // Editing an address does not change the loaded page. Keep its pass
        // until a committed URL appears or the browser leaves the foreground.
        val host = if (url == null && lastForegroundPackage == packageName) {
            lastSeenHost[packageName]
        } else url?.let { extractHost(it) }
        return host?.let { findBlockedDomain(it) }
    }

    // Raw URL-bar text, or null when no URL bar could be read at all (the
    // toolbar is mid-animation, hidden while scrolling, a browser update
    // renamed the view ID…). An empty string is not the same thing: it means
    // the bar is there and showing nothing, i.e. a blank/new tab.
    private fun findBrowserUrlText(root: AccessibilityNodeInfo, packageName: String, urlBarIds: List<String>): String? {
        val bars = urlBarIds.flatMap { idName ->
            root.findAccessibilityNodeInfosByViewId("$packageName:id/$idName") ?: emptyList()
        }
        // Some browsers expose both a display label and an edit field. Check
        // every field before taking text from either one, so autocomplete in
        // the second field cannot be mistaken for a loaded URL in the first.
        if (bars.any { it.isFocused && it.isEditable }) return null
        var sawEmptyBar = false
        for (node in bars) {
            val text = node.text?.toString()
            if (!text.isNullOrBlank()) return text
            sawEmptyBar = true
        }
        return if (sawEmptyBar) "" else null
    }

    // A blank/new tab or an internal about: page — definitively not a blocked
    // site, unlike an unreadable URL bar. This is what the tab we open on
    // dismissal looks like once it has actually loaded.
    private fun isBlankPage(urlText: String): Boolean {
        val text = urlText.trim().lowercase()
        return text.isEmpty() || text.startsWith("about:")
    }

    // Forget both the dismissal grace and the last-host dedupe for this
    // browser, so whatever it navigates to next is evaluated from scratch —
    // including a return to the blocked tab that is still open behind this one.
    private fun onBrowserLeftBlockedSite(packageName: String) {
        lastSeenHost.remove(packageName)
        clearDismissals(packageName)
    }

    private fun getRootFromEvent(event: AccessibilityEvent): AccessibilityNodeInfo? {
        var node = event.source ?: return null
        var parent = node.parent
        while (parent != null) {
            node = parent
            parent = node.parent
        }
        return node
    }

    private fun extractHost(raw: String): String? {
        var text = raw.trim()
        if (text.isEmpty()) return null
        val schemeIdx = text.indexOf("://")
        if (schemeIdx != -1) text = text.substring(schemeIdx + 3)
        val cutIdx = text.indexOfFirst { it == '/' || it == '?' || it == '#' || it == ' ' }
        if (cutIdx != -1) text = text.substring(0, cutIdx)
        text = text.lowercase()
        return text.takeIf { it.contains(".") }
    }

    private fun findBlockedDomain(host: String): String? {
        val prefs = getSharedPreferences("intention_prefs", Context.MODE_PRIVATE)
        val blockedDomainsStr = prefs.getString("blockedDomains", "[]") ?: "[]"
        try {
            // blockedDomains is stored as a JSON string of array: ["instagram.com", ...]
            val array = org.json.JSONArray(blockedDomainsStr)
            for (i in 0 until array.length()) {
                val d = array.getString(i)
                if (host == d || host.endsWith(".$d")) return d
            }
        } catch (e: Exception) {
            Log.e(TAG, "Error checking blocked domains: ", e)
        }
        return null
    }

    private fun isAppBlocked(packageName: String): Boolean {
        val prefs = getSharedPreferences("intention_prefs", Context.MODE_PRIVATE)
        val blockedAppsStr = prefs.getString("blockedApps", "[]") ?: "[]"
        try {
            // blockedApps is stored as a JSON string of array: ["com.instagram.android", ...]
            val array = org.json.JSONArray(blockedAppsStr)
            for (i in 0 until array.length()) {
                if (packageName == array.getString(i)) {
                    return true
                }
            }
        } catch (e: Exception) {
            Log.e(TAG, "Error checking blocked apps: ", e)
        }
        return false
    }

    // Returns the latest future expiration time of any active session for
    // this app/domain, or null if there is no unexpired session.
    private fun sessionExpiresAt(key: String): Long? {
        val latest = latestSessionExpiry(key) ?: return null
        return latest.takeIf { System.currentTimeMillis() < it }
    }

    // Latest expiration among this app/domain's sessions, whether or not it has
    // passed. Sessions the background JS has already banked stay in storage
    // (their reason feeds the check-in prompt), so "expired" and "never had
    // one" have to be told apart — see justExpired.
    private fun latestSessionExpiry(key: String): Long? {
        val prefs = getSharedPreferences("intention_prefs", Context.MODE_PRIVATE)
        val activeSessionsStr = prefs.getString("activeSessions", "{}") ?: "{}"
        var latest: Long? = null
        try {
            // activeSessions is a JSON object keyed "tab:<id>:<domain>" in the
            // browser extensions, or "target:<domain|package>" on Android/iOS,
            // which have no tabs. This loop matches on each session's own
            // `domain` field rather than parsing keys, so it is unaffected by
            // the key format -- keep it that way.
            // {"target:instagram.com": {"domain": "instagram.com", "startTime": 12345, "intervalMinutes": 10}}
            val json = JSONObject(activeSessionsStr)
            val keys = json.keys()
            while (keys.hasNext()) {
                val sessionKey = keys.next()
                val session = json.getJSONObject(sessionKey)
                val domain = session.optString("domain")
                if (domain == key) {
                    val startTime = session.optLong("startTime", 0)
                    val intervalMinutes = session.optLong("intervalMinutes", 0)
                    val paused = session.optLong("pausedDurationMs", 0L)
                    val pausedAt = session.optLong("pausedAt", 0L)
                    val foregroundExpiry = PassClock.expiresAt(startTime, intervalMinutes, paused) +
                        (if (pausedAt > 0L) (System.currentTimeMillis() - pausedAt).coerceAtLeast(0L) else 0L)
                    val wallExpiresAt = session.optLong("wallExpiresAt", 0L)
                    val expirationTime = if (wallExpiresAt > 0L) minOf(foregroundExpiry, wallExpiresAt)
                        else foregroundExpiry
                    if (expirationTime > (latest ?: 0L)) {
                        latest = expirationTime
                    }
                }
            }
        } catch (e: Exception) {
            Log.e(TAG, "Error checking active sessions: ", e)
        }
        return latest
    }

    // True when a session for this target ran out just now, rather than there
    // never having been one — the difference between the coach opening with
    // "your time is up" and opening with "what are you here for?". Bounded so
    // a session from hours ago doesn't resurface as a stale check-in.
    private fun justExpired(key: String): Boolean {
        val expiry = latestSessionExpiry(key) ?: return false
        val sinceExpiry = System.currentTimeMillis() - expiry
        return sinceExpiry in 0..CHECKIN_WINDOW_MS
    }

    // =======================================================================
    // LEAVING: THE ONE QUESTION THIS SERVICE ANSWERS ABOUT SETTINGS
    // =======================================================================

    /**
     * "Is Settings showing Intention's own App info page, or the Accessibility
     * entry for this service?" — and if so, open the leaving conversation over
     * the top of it. Returns whether it launched, which is the caller's cue to
     * stop evaluating a window that is no longer in front.
     *
     * The order of the two checks is the whole performance story. This runs on
     * every window state change inside Settings, and only the second of them
     * crosses into another app's process:
     *
     *   1. the stored leaving policy (LeavePolicy), which is a
     *      SharedPreferences read the OS has already cached in this process —
     *      and which is where BOTH floors now live, so a restart of this
     *      service cannot wipe them;
     *   2. the bounded walk.
     *
     * So the walk only happens on a screen change we would actually act on.
     *
     * What is NOT here: the uninstall confirmation dialog. That dialog belongs
     * to the package installer, not to Settings, and it is deliberately left
     * alone twice over — a user who has already tapped Uninstall and is
     * looking at the system's own "are you sure" has made the decision, and
     * interrupting it is the fighting-for-control shape this whole feature
     * refuses; and it is the very dialog our own WebAppInterface.requestUninstall()
     * raises at the end of the conversation, so interposing on it would mean
     * interposing on our own completion.
     */
    private fun checkRemovalSurface(event: AccessibilityEvent): Boolean {
        val now = System.currentTimeMillis()
        if (!leaveInterposeAllowed(now)) return false

        val root = rootInActiveWindow ?: getRootFromEvent(event) ?: return false
        if (!isRemovalSurface(root)) return false

        // Spent BEFORE the launch, and durably: the ten-minute debounce and
        // the fifteen-minute stand-down both. A launch that throws still pays
        // for the show — an activity we could not start is not a reason to try
        // again on the next window change — and a dismissal with Back, which
        // this process never hears about, has already been paid for. See the
        // head of LeavePolicy.kt.
        LeavePolicy.recordInterposition(this, now)
        launchLeavingFlow()
        return true
    }

    /**
     * The bounded walk. Breadth-first, capped at REMOVAL_WALK_MAX_NODES
     * handles and REMOVAL_WALK_MAX_DEPTH levels, over the visible nodes only.
     *
     * WHICH shapes count is RemovalSurfaceMatcher's, and its head is where the
     * reasoning lives — including why an earlier version of this method
     * matched every row of Settings -> Accessibility, and what that did to a
     * user who had gone there for a screen reader. All this method does is
     * feed it nodes and stop early when it has an answer.
     */
    private fun isRemovalSurface(root: AccessibilityNodeInfo): Boolean {
        val matcher = RemovalSurfaceMatcher(
            appLabel = getString(R.string.app_name),
            serviceLabel = getString(R.string.accessibility_service_label),
            serviceDescription = getString(R.string.accessibility_service_description)
        )
        var obtained = 1
        val queue = ArrayDeque<Pair<AccessibilityNodeInfo, Int>>()
        queue.addLast(root to 0)

        while (queue.isNotEmpty()) {
            val (node, depth) = queue.removeFirst()
            if (node.isVisibleToUser &&
                matcher.observe(node.text?.toString(), node.viewIdResourceName)
            ) {
                return true
            }

            if (depth >= REMOVAL_WALK_MAX_DEPTH) continue
            val childCount = node.childCount
            for (i in 0 until childCount) {
                if (obtained >= REMOVAL_WALK_MAX_NODES) break
                val child = try { node.getChild(i) } catch (e: Exception) { null } ?: continue
                obtained++
                queue.addLast(child to depth + 1)
            }
        }
        return matcher.matched
    }

    /**
     * Every reason Intention stays quiet, read out of the same stored state
     * the browser build reads. The policy itself is LeavePolicy's; this is the
     * one-line call site kept so the ordering comment above has something to
     * point at.
     */
    private fun leaveInterposeAllowed(now: Long): Boolean = LeavePolicy.allows(this, now)

    // Our own activity, over the top, dismissible. MainActivity is singleTask,
    // so an instance already in the back stack is handed this through
    // onNewIntent rather than a second copy being built, and EXTRA_LEAVE takes
    // its WebView to options.html?leave=1 — the same address the browser
    // build's tab interposition opens, running the same conversation. One
    // flow, two entry points.
    private fun launchLeavingFlow() {
        Log.d(TAG, "Settings is showing Intention's own page — opening the leaving conversation")
        try {
            startActivity(
                Intent(this, MainActivity::class.java).apply {
                    flags = Intent.FLAG_ACTIVITY_NEW_TASK
                    putExtra(MainActivity.EXTRA_LEAVE, true)
                }
            )
        } catch (e: Exception) {
            Log.e(TAG, "Could not open the leaving conversation: ", e)
        }
    }

    /**
     * Which admission, if any, the gate has to carry.
     *
     * A part rule that could not be carried out blocks the WHOLE app, which
     * from the user's side is a rule they wrote being ignored. The miss
     * counter already records it, but that card is inside the app they are
     * pointedly not opening; this is how the same fact reaches them at the
     * only moment it is actually on their mind. Null for every ordinary
     * block, so the coach is unchanged for everyone whose rules are working
     * and for every target with no part rule at all.
     */
    private fun partNoticeFor(verdict: AppParts.PartVerdict): String? = when {
        !verdict.degraded -> null
        verdict.refused -> CoachingActivity.PART_NOTICE_REFUSED
        else -> CoachingActivity.PART_NOTICE_UNRESOLVED
    }

    private fun launchCoachingOverlay(
        key: String,
        isApp: Boolean,
        label: String,
        browserPackage: String? = null,
        mode: String = MODE_GATE,
        partNotice: String? = null
    ) {
        val intent = Intent(this, CoachingActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP
            putExtra("domain", key)
            putExtra("isApp", isApp)
            putExtra("appLabel", label)
            putExtra("browserPackage", browserPackage)
            putExtra("mode", mode)
            putExtra(CoachingActivity.EXTRA_PART_NOTICE, partNotice)
        }
        startActivity(intent)
    }

    private fun getAppLabel(packageName: String): String {
        return try {
            val info = packageManager.getApplicationInfo(packageName, 0)
            packageManager.getApplicationLabel(info).toString()
        } catch (e: Exception) {
            packageName
        }
    }
}
