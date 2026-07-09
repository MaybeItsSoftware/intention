package com.maybeitsadam.intention

import android.accessibilityservice.AccessibilityService
import android.content.Context
import android.content.Intent
import android.util.Log
import android.view.accessibility.AccessibilityEvent
import org.json.JSONObject

class IntentionAccessibilityService : AccessibilityService() {

    companion object {
        private const val TAG = "IntentionAccessService"
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent) {
        if (event.eventType != AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED) return

        val packageName = event.packageName?.toString() ?: return
        
        // Skip our own app packages
        if (packageName == this.packageName) return

        Log.d(TAG, "Foreground app changed to: $packageName")
        
        // Initialize background helper if not already done
        BackgroundJsHelper.init(applicationContext)

        if (isAppBlocked(packageName)) {
            Log.d(TAG, "App is blocked: $packageName. Checking for active session...")
            if (!isSessionActive(packageName)) {
                Log.d(TAG, "No active session for $packageName. Blocking and launching Coach!")
                launchCoachingOverlay(packageName)
            } else {
                Log.d(TAG, "Active session exists for $packageName. Allowing access.")
            }
        }
    }

    override fun onInterrupt() {
        Log.d(TAG, "Accessibility Service Interrupted")
    }

    private fun isAppBlocked(packageName: String): Boolean {
        val prefs = getSharedPreferences("intention_prefs", Context.MODE_PRIVATE)
        val blockedDomainsStr = prefs.getString("blockedDomains", "[]")
        try {
            // blockedDomains is stored as a JSON string of array: ["com.instagram.android", ...]
            val array = org.json.JSONArray(blockedDomainsStr)
            for (i in 0 until array.length()) {
                val blocked = array.getString(i)
                if (packageName == blocked || packageName.endsWith(".$blocked")) {
                    return true
                }
            }
        } catch (e: Exception) {
            Log.e(TAG, "Error checking blocked apps: ", e)
        }
        return false
    }

    private fun isSessionActive(packageName: String): Boolean {
        val prefs = getSharedPreferences("intention_prefs", Context.MODE_PRIVATE)
        val activeSessionsStr = prefs.getString("activeSessions", "{}")
        try {
            // activeSessions is stored as a JSON object: {"tabId": {"domain": "com.instagram.android", "startTime": 12345, "intervalMinutes": 10}}
            val json = JSONObject(activeSessionsStr)
            val keys = json.keys()
            val now = System.currentTimeMillis()
            while (keys.hasNext()) {
                val key = keys.next()
                val session = json.getJSONObject(key)
                val domain = session.optString("domain")
                if (domain == packageName || packageName.endsWith(".$domain")) {
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

    private fun launchCoachingOverlay(packageName: String) {
        val intent = Intent(this, CoachingActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP
            putExtra("domain", packageName)
        }
        startActivity(intent)
    }
}
