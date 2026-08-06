package uk.co.maybeitssoftware.intention

import android.accessibilityservice.AccessibilityService
import android.content.Context
import android.content.Intent
import android.os.Handler
import android.os.Looper
import android.util.Log
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
    }

    private val lastContentCheckAt = mutableMapOf<String, Long>()
    private val lastSeenHost = mutableMapOf<String, String>()
    private val dismissedUntil = mutableMapOf<String, Long>()

    private val handler = Handler(Looper.getMainLooper())
    private val expiryRecheck = Runnable { recheckForeground() }
    private var lastForegroundPackage: String? = null

    override fun onServiceConnected() {
        super.onServiceConnected()
        instance = this
    }

    override fun onDestroy() {
        if (instance == this) instance = null
        handler.removeCallbacks(expiryRecheck)
        super.onDestroy()
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent) {
        val eventType = event.eventType
        if (eventType != AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED &&
            eventType != AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED
        ) return

        val packageName = event.packageName?.toString() ?: return

        // Skip our own app packages
        if (packageName == this.packageName) return

        // Initialize background helper if not already done
        BackgroundJsHelper.init(applicationContext)

        if (eventType == AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED) {
            Log.d(TAG, "Foreground app changed to: $packageName")
            lastForegroundPackage = packageName

            if (isAppBlocked(packageName)) {
                Log.d(TAG, "App is blocked: $packageName. Checking for active session...")
                val expiresAt = sessionExpiresAt(packageName)
                if (expiresAt == null) {
                    Log.d(TAG, "No active session for $packageName. Blocking and launching Coach!")
                    launchCoachingOverlay(packageName, isApp = true, label = getAppLabel(packageName))
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
        lastContentCheckAt[packageName] = now

        val root = rootInActiveWindow ?: getRootFromEvent(event) ?: return
        val urlText = findBrowserUrlText(root, packageName, urlBarIds) ?: return
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

    // Re-evaluates whatever is currently in the foreground, independent of
    // accessibility events. Called when a session expiry timer or the native
    // check-in alarm fires, so the user is cut off mid-use instead of only on
    // the next app switch or navigation.
    fun recheckForeground() {
        handler.removeCallbacks(expiryRecheck)
        // Hosts were deduped against lastSeenHost while the session was
        // active; clear so the next content event re-evaluates them.
        lastSeenHost.clear()

        val root = rootInActiveWindow
        val packageName = root?.packageName?.toString() ?: lastForegroundPackage ?: return
        if (packageName == this.packageName) return

        if (isAppBlocked(packageName)) {
            val expiresAt = sessionExpiresAt(packageName)
            if (expiresAt == null) {
                Log.d(TAG, "Session expired while $packageName in foreground. Launching Coach!")
                launchCoachingOverlay(
                    packageName,
                    isApp = true,
                    label = getAppLabel(packageName),
                    mode = if (justExpired(packageName)) MODE_CHECKIN else MODE_GATE
                )
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

    // Raw URL-bar text, or null when no URL bar could be read at all (the
    // toolbar is mid-animation, hidden while scrolling, a browser update
    // renamed the view ID…). An empty string is not the same thing: it means
    // the bar is there and showing nothing, i.e. a blank/new tab.
    private fun findBrowserUrlText(root: AccessibilityNodeInfo, packageName: String, urlBarIds: List<String>): String? {
        var sawEmptyBar = false
        for (idName in urlBarIds) {
            val node = root.findAccessibilityNodeInfosByViewId("$packageName:id/$idName")?.firstOrNull() ?: continue
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
                    val expirationTime = startTime + (intervalMinutes * 60 * 1000)
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

    private fun launchCoachingOverlay(
        key: String,
        isApp: Boolean,
        label: String,
        browserPackage: String? = null,
        mode: String = MODE_GATE
    ) {
        val intent = Intent(this, CoachingActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP
            putExtra("domain", key)
            putExtra("isApp", isApp)
            putExtra("appLabel", label)
            putExtra("browserPackage", browserPackage)
            putExtra("mode", mode)
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
