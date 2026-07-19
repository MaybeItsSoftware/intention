package uk.co.maybeitssoftware.intention

import android.accessibilityservice.AccessibilityService
import android.content.Context
import android.content.Intent
import android.util.Log
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import org.json.JSONObject

class IntentionAccessibilityService : AccessibilityService() {

    companion object {
        private const val TAG = "IntentionAccessService"
        private const val CONTENT_CHECK_THROTTLE_MS = 400L

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

            if (isAppBlocked(packageName)) {
                Log.d(TAG, "App is blocked: $packageName. Checking for active session...")
                if (!isSessionActive(packageName)) {
                    Log.d(TAG, "No active session for $packageName. Blocking and launching Coach!")
                    launchCoachingOverlay(packageName, isApp = true, label = getAppLabel(packageName))
                } else {
                    Log.d(TAG, "Active session exists for $packageName. Allowing access.")
                }
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

        val host = findBrowserHost(event, packageName, urlBarIds) ?: return
        if (lastSeenHost[packageName] == host) return
        lastSeenHost[packageName] = host

        val matchedDomain = findBlockedDomain(host) ?: return
        Log.d(TAG, "Website is blocked: $host (matched $matchedDomain). Checking for active session...")
        if (!isSessionActive(matchedDomain)) {
            Log.d(TAG, "No active session for $matchedDomain. Blocking and launching Coach!")
            launchCoachingOverlay(matchedDomain, isApp = false, label = matchedDomain)
        } else {
            Log.d(TAG, "Active session exists for $matchedDomain. Allowing access.")
        }
    }

    private fun findBrowserHost(event: AccessibilityEvent, packageName: String, urlBarIds: List<String>): String? {
        val root = rootInActiveWindow ?: getRootFromEvent(event) ?: return null
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

    private fun isSessionActive(key: String): Boolean {
        val prefs = getSharedPreferences("intention_prefs", Context.MODE_PRIVATE)
        val activeSessionsStr = prefs.getString("activeSessions", "{}") ?: "{}"
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
                    if (now < expirationTime) {
                        return true
                    }
                }
            }
        } catch (e: Exception) {
            Log.e(TAG, "Error checking active sessions: ", e)
        }
        return false
    }

    private fun launchCoachingOverlay(key: String, isApp: Boolean, label: String) {
        val intent = Intent(this, CoachingActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP
            putExtra("domain", key)
            putExtra("isApp", isApp)
            putExtra("appLabel", label)
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
