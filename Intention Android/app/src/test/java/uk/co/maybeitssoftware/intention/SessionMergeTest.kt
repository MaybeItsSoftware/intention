package uk.co.maybeitssoftware.intention

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test

class SessionMergeTest {
    private val start = 1_700_000_000_000L
    private val key = "target:instagram.com"

    private fun pass(startTime: Long = start, pausedAt: Long = 0L, paused: Long = 0L, wall: Long = 0L) =
        JSONObject().put("domain", "instagram.com").put("startTime", startTime)
            .put("intervalMinutes", 10).apply {
                if (pausedAt > 0L) put("pausedAt", pausedAt)
                if (paused > 0L) put("pausedDurationMs", paused)
                if (wall > 0L) put("wallExpiresAt", wall)
            }

    private fun merged(stored: JSONObject, incoming: JSONObject): JSONObject =
        JSONObject(SharedState.mergeNativeSessionFields(
            JSONObject().put(key, stored).toString(),
            JSONObject().put(key, incoming).toString()
        )).getJSONObject(key)

    @Test fun aPauseStampedAfterTheBackgroundReadSurvivesItsWrite() {
        val out = merged(stored = pass(pausedAt = start + 60_000), incoming = pass())
        assertEquals(start + 60_000, out.getLong("pausedAt"))
    }

    @Test fun aResumeStampedAfterTheBackgroundReadSurvivesItsWrite() {
        val out = merged(
            stored = pass(paused = 30_000),
            incoming = pass(pausedAt = start + 60_000)
        )
        assertFalse(out.has("pausedAt"))
        assertEquals(30_000, out.getLong("pausedDurationMs"))
    }

    @Test fun theEarlierHardEndWins() {
        val out = merged(stored = pass(wall = start + 1_000), incoming = pass(wall = start + 99_000))
        assertEquals(start + 1_000, out.getLong("wallExpiresAt"))
    }

    @Test fun aNewGrantIsTheBackgroundsAlone() {
        val fresh = pass(startTime = start + 3_600_000, pausedAt = start + 3_600_000)
        val out = merged(stored = pass(pausedAt = start + 60_000, paused = 5_000), incoming = fresh)
        assertEquals(start + 3_600_000, out.getLong("pausedAt"))
        assertFalse(out.has("pausedDurationMs"))
    }

    @Test fun nothingStoredOrUnreadableLeavesTheWriteAsIs() {
        val incoming = JSONObject().put(key, pass()).toString()
        assertEquals(incoming, SharedState.mergeNativeSessionFields(null, incoming))
        assertEquals(incoming, SharedState.mergeNativeSessionFields("not json", incoming))
    }
}
