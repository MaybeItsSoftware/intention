package uk.co.maybeitssoftware.intention

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ClockChangeTest {
    private val minute = 60_000L
    private val hour = 60 * minute
    private val grantedAt = 1_700_000_000_000L

    private fun sessions(vararg pairs: Pair<String, JSONObject>) =
        JSONObject().apply { for ((k, v) in pairs) put(k, v) }

    private fun pass(start: Long, minutes: Long = 10, pausedAt: Long = 0L, wall: Long = 0L) =
        JSONObject().put("domain", "instagram.com").put("startTime", start)
            .put("intervalMinutes", minutes).apply {
                if (pausedAt > 0L) put("pausedAt", pausedAt)
                if (wall > 0L) put("wallExpiresAt", wall)
            }

    @Test fun windingTheClockBackDoesNotLengthenAPass() {
        // Two minutes into a ten-minute pass, the clock is set back an hour.
        val realNow = grantedAt + 2 * minute
        val now = realNow - hour
        val s = sessions("target:instagram.com" to pass(grantedAt))
        val alarms = ForegroundPass.rebase(s, -hour, now)
        val session = s.getJSONObject("target:instagram.com")
        assertEquals(grantedAt - hour, session.getLong("startTime"))
        // Still eight minutes left on the new clock — not an hour and eight.
        val expires = PassClock.expiresAt(session.getLong("startTime"), 10, 0)
        assertEquals(now + 8 * minute, expires)
        assertEquals(listOf("checkin-target:instagram.com" to expires), alarms)
    }

    @Test fun aForwardCorrectionDoesNotRobAPass() {
        val now = grantedAt + 2 * minute + 5 * minute
        val s = sessions("target:x" to pass(grantedAt, wall = grantedAt + 3 * hour))
        ForegroundPass.rebase(s, 5 * minute, now)
        val session = s.getJSONObject("target:x")
        assertEquals(now + 8 * minute, PassClock.expiresAt(session.getLong("startTime"), 10, 0))
        assertEquals(grantedAt + 3 * hour + 5 * minute, session.getLong("wallExpiresAt"))
    }

    @Test fun aPausedPassKeepsItsGrace() {
        val pausedAt = grantedAt + 2 * minute
        val now = pausedAt + 20_000L - hour
        val s = sessions("target:x" to pass(grantedAt, pausedAt = pausedAt))
        val alarms = ForegroundPass.rebase(s, -hour, now)
        val session = s.getJSONObject("target:x")
        assertEquals(pausedAt - hour, session.getLong("pausedAt"))
        assertEquals(listOf("checkin-target:x" to pausedAt - hour + PassClock.LEAVE_GRACE_MS), alarms)
    }

    @Test fun anUnmeasuredRollbackEndsAPassThatStartsInTheFuture() {
        // The service was not running when the clock went back.
        val now = grantedAt - hour
        val s = sessions("target:x" to pass(grantedAt))
        val alarms = ForegroundPass.rebase(s, 0L, now)
        val session = s.getJSONObject("target:x")
        assertEquals(now, session.getLong("wallExpiresAt"))
        // Not banked here — the background still has to record its minutes.
        assertTrue(session.isNull("endedAt"))
        assertEquals(listOf("checkin-target:x" to now), alarms)
    }

    @Test fun passesThatAreOverOrNotNativeAreLeftAlone() {
        val now = grantedAt + hour - hour
        val ended = pass(grantedAt - 2 * hour).put("endedAt", grantedAt - hour)
        val expired = pass(grantedAt - 2 * hour)
        val tab = pass(grantedAt)
        val s = sessions("target:a" to ended, "target:b" to expired, "tab:1:x" to tab)
        val before = s.toString()
        assertEquals(emptyList<Pair<String, Long>>(), ForegroundPass.rebase(s, -hour, now))
        assertEquals(before, s.toString())
    }

    @Test fun nothingChangesWhenTheClockDidNotMove() {
        val now = grantedAt + 2 * minute
        val s = sessions("target:x" to pass(grantedAt))
        val before = s.toString()
        assertEquals(emptyList<Pair<String, Long>>(), ForegroundPass.rebase(s, 0L, now))
        assertEquals(before, s.toString())
    }
}
