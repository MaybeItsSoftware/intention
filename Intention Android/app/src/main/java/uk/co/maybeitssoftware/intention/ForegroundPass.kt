package uk.co.maybeitssoftware.intention

import android.content.Context
import android.util.Log
import org.json.JSONObject

/**
 * Keeps native target passes charged only while their target is on screen,
 * and ends them once it has been away for PassClock.LEAVE_GRACE_MS.
 */
object ForegroundPass {
    private const val TAG = "ForegroundPass"

    // The (activeSessions text, foreground target) the last sync found nothing
    // to do for — or left nothing to do for, having written its changes. The
    // accessibility service calls sync on every event, and with the same text
    // and the same target the answer is the same: a pass pauses or resumes
    // only when the target changes, and one that has died since is skipped
    // either way. Dropped by [invalidate] when the clock moves, the one thing
    // that can bring a dead-looking pass back to life.
    private var settledRaw: String? = null
    private var settledTarget: String? = null

    fun invalidate() = synchronized(SharedState.lock) {
        settledRaw = null
        settledTarget = null
    }

    fun sync(context: Context, foregroundTarget: String?) {
        val now = System.currentTimeMillis()
        val alarmUpdates = mutableListOf<Pair<String, Long?>>()
        try {
            SharedState.mutateActiveSessions(context) { raw ->
                if (raw == settledRaw && foregroundTarget == settledTarget) return@mutateActiveSessions null
                val sessions = JSONObject(raw)
                val changed = applyForeground(sessions, foregroundTarget, now, alarmUpdates)
                val next = if (changed) sessions.toString() else raw
                settledRaw = next
                settledTarget = foregroundTarget
                if (changed) next else null
            }
            for ((name, deadline) in alarmUpdates) {
                if (deadline == null) AlarmHelper.clearAlarm(context, name)
                else AlarmHelper.createAlarm(context, name, JSONObject().put("when", deadline).toString())
            }
        } catch (e: Exception) {
            Log.e(TAG, "Could not update foreground pass", e)
        }
    }

    // The pure half of sync: pauses passes whose target has left the screen,
    // resumes the one that is back, and says which check-in alarms move.
    private fun applyForeground(
        sessions: JSONObject,
        foregroundTarget: String?,
        now: Long,
        alarmUpdates: MutableList<Pair<String, Long?>>
    ): Boolean {
        var changed = false
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
            // A site's pass is in front in its app too — see LinkedServices.
            val inFront = LinkedServices.sameService(domain, foregroundTarget)
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
                // The check-in alarm now marks the end of the grace: if
                // they are not back by then, the shared worker banks the
                // pass as left. Coming back re-arms the real deadline.
                val graceEnds = now + PassClock.LEAVE_GRACE_MS
                alarmUpdates.add("checkin-$key" to
                    (if (wallExpiresAt > 0L) minOf(graceEnds, wallExpiresAt) else graceEnds))
                changed = true
            }
        }
        return changed
    }

    /**
     * The wall clock was set — by the user, or by the network. Every pass is
     * stored as wall-clock timestamps, so winding the clock back an hour used
     * to hand every live pass an extra hour (and stall its check-in alarm,
     * which is set in wall time, by the same). [jumpMs] is how far the clock
     * moved, measured by the accessibility service against elapsedRealtime;
     * 0 when it is not known.
     */
    fun afterClockChange(context: Context, jumpMs: Long) {
        val now = System.currentTimeMillis()
        val alarmUpdates = mutableListOf<Pair<String, Long>>()
        try {
            SharedState.mutateActiveSessions(context) { raw ->
                val sessions = JSONObject(raw)
                alarmUpdates.addAll(rebase(sessions, jumpMs, now))
                if (alarmUpdates.isEmpty()) null else sessions.toString()
            }
            for ((name, deadline) in alarmUpdates) {
                AlarmHelper.createAlarm(context, name, JSONObject().put("when", deadline).toString())
            }
        } catch (e: Exception) {
            Log.e(TAG, "Could not re-validate passes after a clock change", e)
        }
        invalidate()
    }

    /**
     * The pure half of [afterClockChange]; changes [sessions] in place and
     * returns the check-in alarms to re-arm, which is also the list of
     * sessions it touched.
     *
     * A pass that was live before the jump is moved along with the clock —
     * start, pause stamp and wall deadline all shifted by [jumpMs] — so it
     * keeps exactly the real time it had left, in either direction: a network
     * correction neither robs nor rewards anyone.
     *
     * Then, whatever the jump: a pass whose own timestamps are still ahead of
     * the clock was granted or paused in a "future" the clock has been wound
     * back out of, by more than this service saw (it was not running, or the
     * jump could not be measured). How much of it is left cannot be worked
     * out, so it ends — `wallExpiresAt` set to now, which is how every reader
     * here and in background.js already tells an over pass, and its check-in
     * alarm brought forward to now so the background banks it. Not `endedAt`:
     * that means "banked", and would lose its minutes.
     */
    fun rebase(sessions: JSONObject, jumpMs: Long, now: Long): List<Pair<String, Long>> {
        val alarms = mutableListOf<Pair<String, Long>>()
        val before = now - jumpMs
        val keys = sessions.keys()
        while (keys.hasNext()) {
            val key = keys.next()
            if (!key.startsWith("target:")) continue
            val session = sessions.optJSONObject(key) ?: continue
            if (!session.isNull("endedAt")) continue
            var start = session.optLong("startTime", 0L)
            val minutes = session.optLong("intervalMinutes", 0L)
            val paused = session.optLong("pausedDurationMs", 0L)
            var pausedAt = session.optLong("pausedAt", 0L)
            var wallExpiresAt = session.optLong("wallExpiresAt", 0L)
            var touched = false
            if (jumpMs != 0L && PassClock.isLive(start, minutes, paused, pausedAt, before) &&
                (wallExpiresAt == 0L || before < wallExpiresAt)) {
                start += jumpMs
                session.put("startTime", start)
                if (pausedAt > 0L) {
                    pausedAt += jumpMs
                    session.put("pausedAt", pausedAt)
                }
                if (wallExpiresAt > 0L) {
                    wallExpiresAt += jumpMs
                    session.put("wallExpiresAt", wallExpiresAt)
                }
                touched = true
            }
            val alreadyOver = wallExpiresAt in 1L..now
            if (!alreadyOver && (start > now || pausedAt > now)) {
                session.put("wallExpiresAt", now)
                alarms.add("checkin-$key" to now)
                continue
            }
            if (!touched) continue
            val foreground = if (pausedAt > 0L) pausedAt + PassClock.LEAVE_GRACE_MS
                else PassClock.expiresAt(start, minutes, paused)
            alarms.add("checkin-$key" to
                (if (wallExpiresAt > 0L) minOf(foreground, wallExpiresAt) else foreground))
        }
        return alarms
    }
}
