package uk.co.maybeitssoftware.intention

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PassClockTest {
    private val start = 1_000_000L
    private val minute = 60_000L

    @Test fun backgroundTimeDoesNotSpendThePass() {
        val pausedAt = start + 2 * minute
        assertEquals(2 * minute, PassClock.elapsedMs(start, 0, pausedAt, pausedAt + 40 * minute))
        assertTrue(PassClock.isLive(start, 10, 0, pausedAt, pausedAt + 30_000L))
        val resumedAt = pausedAt + 30_000L
        val pausedDuration = resumedAt - pausedAt
        assertEquals(2 * minute, PassClock.elapsedMs(start, pausedDuration, 0, resumedAt))
        assertEquals(resumedAt + 8 * minute, PassClock.expiresAt(start, 10, pausedDuration))
        assertFalse(PassClock.isLive(start, 10, pausedDuration, 0, resumedAt + 8 * minute))
    }

    @Test fun leavingForLongerThanTheGraceEndsThePass() {
        val pausedAt = start + 2 * minute
        assertTrue(PassClock.isLive(start, 10, 0, pausedAt, pausedAt + PassClock.LEAVE_GRACE_MS - 1))
        assertFalse(PassClock.isLive(start, 10, 0, pausedAt, pausedAt + PassClock.LEAVE_GRACE_MS))
        assertFalse(PassClock.isLive(start, 10, 0, pausedAt, pausedAt + 40 * minute))
    }

    @Test fun oldSessionsStillUseWallClockTime() {
        assertFalse(PassClock.isLive(start, 10, 0, 0, start + 10 * minute))
    }
}
