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

    private fun checkWebsiteBlock(event: AccessibilityEvent, packageName: String, urlBarIds: List<String>) {
        val now = System.currentTimeMillis()
        val lastCheck = lastContentCheckAt[packageName] ?: 0L
        if (now - lastCheck < CONTENT_CHECK_THROTTLE_MS) return
        lastContentCheckAt[packageName] = now

        val root = rootInActiveWindow ?: getRootFromEvent(event) ?: return
        val host = findBrowserHost(root, packageName, urlBarIds) ?: return
        val hostChanged = lastSeenHost[packageName] != host
        lastSeenHost[packageName] = host

        val matchedDomain = findBlockedDomain(host) ?: return
        val expiresAt = sessionExpiresAt(matchedDomain)
        if (expiresAt != null) {
            // Keep an expiry re-check armed while the user stays on the site,
            // since no further host change will trigger a check.
            scheduleExpiryRecheck(expiresAt)
        } else if (hostChanged) {
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
                launchCoachingOverlay(packageName, isApp = true, label = getAppLabel(packageName))
            } else {
                scheduleExpiryRecheck(expiresAt)
            }
            return
        }

        val urlBarIds = BROWSER_URL_BAR_IDS[packageName] ?: return
        val host = findBrowserHost(root ?: return, packageName, urlBarIds) ?: return
        lastSeenHost[packageName] = host
        val matchedDomain = findBlockedDomain(host) ?: return
        val expiresAt = sessionExpiresAt(matchedDomain)
        if (expiresAt == null) {
            Log.d(TAG, "Session expired while $host in foreground. Launching Coach!")
            launchCoachingOverlay(matchedDomain, isApp = false, label = matchedDomain, browserPackage = packageName)
        } else {
            scheduleExpiryRecheck(expiresAt)
        }
    }

    private fun scheduleExpiryRecheck(expiresAt: Long) {
        val delay = (expiresAt - System.currentTimeMillis()).coerceAtLeast(0L) + EXPIRY_RECHECK_BUFFER_MS
        handler.removeCallbacks(expiryRecheck)
        handler.postDelayed(expiryRecheck, delay)
    }

    private fun findBrowserHost(root: AccessibilityNodeInfo, packageName: String, urlBarIds: List<String>): String? {
        for (idName in urlBarIds) {
            val nodes = root.findAccessibilityNodeInfosByViewId("$packageName:id/$idName")
            val text = nodes?.firstOrNull()?.text?.toString()
            if (!text.isNullOrBlank()) {
                return extractHost(text)
            }
        }
        return null
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
        val prefs = getSharedPreferences("intention_prefs", Context.MODE_PRIVATE)
        val activeSessionsStr = prefs.getString("activeSessions", "{}") ?: "{}"
        var latest: Long? = null
        try {
            // activeSessions is stored as a JSON object: {"tabId": {"domain": "com.instagram.android", "startTime": 12345, "intervalMinutes": 10}}
            val json = JSONObject(activeSessionsStr)
            val keys = json.keys()
            val now = System.currentTimeMillis()
            while (keys.hasNext()) {
                val sessionKey = keys.next()
                val session = json.getJSONObject(sessionKey)
                val domain = session.optString("domain")
                if (domain == key) {
                    val startTime = session.optLong("startTime", 0)
                    val intervalMinutes = session.optLong("intervalMinutes", 0)
                    val expirationTime = startTime + (intervalMinutes * 60 * 1000)
                    if (now < expirationTime && expirationTime > (latest ?: 0L)) {
                        latest = expirationTime
                    }
                }
            }
        } catch (e: Exception) {
            Log.e(TAG, "Error checking active sessions: ", e)
        }
        return latest
    }

    private fun launchCoachingOverlay(key: String, isApp: Boolean, label: String, browserPackage: String? = null) {
        val intent = Intent(this, CoachingActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP
            putExtra("domain", key)
            putExtra("isApp", isApp)
            putExtra("appLabel", label)
            putExtra("browserPackage", browserPackage)
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
