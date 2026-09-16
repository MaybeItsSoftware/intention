package uk.co.maybeitssoftware.intention

import android.content.Context
import android.util.Log
import org.json.JSONObject

/** Keeps native target passes charged only while their target is on screen. */
object ForegroundPass {
    private const val TAG = "ForegroundPass"

    fun sync(context: Context, foregroundTarget: String?) {
        val prefs = context.getSharedPreferences("intention_prefs", Context.MODE_PRIVATE)
        val raw = prefs.getString("activeSessions", "{}") ?: "{}"
        val now = System.currentTimeMillis()
        try {
            val sessions = JSONObject(raw)
            var changed = false
            val alarmUpdates = mutableListOf<Pair<String, Long?>>()
            val keys = sessions.keys()
            while (keys.hasNext()) {
                val key = keys.next()
                if (!key.startsWith("target:")) continue
                val session = sessions.optJSONObject(key) ?: continue
                if (!session.isNull("endedAt")) continue
                val start = session.optLong("startTime", 0L)
                val minutes = session.optLong("intervalMinutes", 0L)
                val paused = session.optLong("pausedDurationMs", 0L)
                val pausedAt = session.optLong("pausedAt", 0L)
                val wallExpiresAt = session.optLong("wallExpiresAt", 0L)
                val domain = session.optString("domain")
                if (!PassClock.isLive(start, minutes, paused, pausedAt, now) ||
                    (wallExpiresAt > 0L && now >= wallExpiresAt)) continue
                val inFront = domain == foregroundTarget
                if (inFront && pausedAt > 0L) {
                    val totalPaused = paused + (now - pausedAt).coerceAtLeast(0L)
                    session.put("pausedDurationMs", totalPaused)
                    session.remove("pausedAt")
                    val deadline = PassClock.expiresAt(start, minutes, totalPaused)
                    alarmUpdates.add("checkin-$key" to
                        (if (wallExpiresAt > 0L) minOf(deadline, wallExpiresAt) else deadline))
                    changed = true
                } else if (!inFront && pausedAt == 0L) {
                    session.put("pausedAt", now)
                    alarmUpdates.add("checkin-$key" to wallExpiresAt.takeIf { it > 0L })
                    changed = true
                }
            }
            if (changed) {
                prefs.edit().putString("activeSessions", sessions.toString()).apply()
                for ((name, deadline) in alarmUpdates) {
                    if (deadline == null) AlarmHelper.clearAlarm(context, name)
                    else AlarmHelper.createAlarm(context, name, JSONObject().put("when", deadline).toString())
                }
            }
        } catch (e: Exception) {
            Log.e(TAG, "Could not update foreground pass", e)
        }
    }
}
