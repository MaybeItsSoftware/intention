package uk.co.maybeitssoftware.intention

import org.junit.Assert.assertArrayEquals
import org.junit.Test
import uk.co.maybeitssoftware.intention.ForegroundTime.ACTIVITY_PAUSED
import uk.co.maybeitssoftware.intention.ForegroundTime.ACTIVITY_RESUMED
import uk.co.maybeitssoftware.intention.ForegroundTime.ACTIVITY_STOPPED
import uk.co.maybeitssoftware.intention.ForegroundTime.Event
import uk.co.maybeitssoftware.intention.ForegroundTime.SCREEN_NON_INTERACTIVE

/**
 * The gate's seven-day strip on Android is only as honest as this arithmetic,
 * and nothing short of a real device exercises UsageStatsManager itself, so
 * the event-to-minutes step is pinned here against synthetic events.
 */
class ForegroundTimeTest {
    private val min = 60_000L
    private val day = 24 * 60 * min
    // Three days, starting at an arbitrary "midnight".
    private val d0 = 1_000_000_000L
    private val days = longArrayOf(d0, d0 + day, d0 + 2 * day)
    private val end = d0 + 3 * day
    private val queryStart = d0 - 3 * 60 * min

    private fun run(vararg events: Event) =
        ForegroundTime.perDay(events.toList(), queryStart, days, end)

    @Test
    fun aSingleSessionLandsOnItsDay() {
        val got = run(
            Event(d0 + day + 10 * min, ACTIVITY_RESUMED, "A"),
            Event(d0 + day + 25 * min, ACTIVITY_PAUSED, "A"),
            Event(d0 + day + 26 * min, ACTIVITY_STOPPED, "A")
        )
        assertArrayEquals(longArrayOf(0, 15 * min, 0), got)
    }

    @Test
    fun aSessionAcrossMidnightIsSplitAtMidnight() {
        val got = run(
            Event(d0 + day - 5 * min, ACTIVITY_RESUMED, "A"),
            Event(d0 + day + 7 * min, ACTIVITY_PAUSED, "A")
        )
        assertArrayEquals(longArrayOf(5 * min, 7 * min, 0), got)
    }

    // B resumes before A reports its pause: one continuous stretch, not two
    // overlapping ones counted twice.
    @Test
    fun handingOffBetweenActivitiesIsNotDoubleCounted() {
        val got = run(
            Event(d0, ACTIVITY_RESUMED, "A"),
            Event(d0 + 10 * min, ACTIVITY_RESUMED, "B"),
            Event(d0 + 10 * min + 200, ACTIVITY_PAUSED, "A"),
            Event(d0 + 30 * min, ACTIVITY_PAUSED, "B")
        )
        assertArrayEquals(longArrayOf(30 * min, 0, 0), got)
    }

    @Test
    fun anActivityOpenBeforeTheEventsBeganCountsFromTheirStart() {
        // Opened during the lookback before day 0; only the part inside day 0 counts.
        val got = run(Event(d0 + 20 * min, ACTIVITY_PAUSED, "A"))
        assertArrayEquals(longArrayOf(20 * min, 0, 0), got)
    }

    @Test
    fun theScreenGoingOffEndsALostSession() {
        val got = run(
            Event(d0 + 60 * min, ACTIVITY_RESUMED, "A"),
            Event(d0 + 90 * min, SCREEN_NON_INTERACTIVE),
            // The pause that finally arrives much later changes nothing.
            Event(d0 + day + 60 * min, ACTIVITY_PAUSED, "A")
        )
        assertArrayEquals(longArrayOf(30 * min, 0, 0), got)
    }

    @Test
    fun stillOpenAtTheEndCountsUpToNow() {
        val got = run(Event(end - 4 * min, ACTIVITY_RESUMED, "A"))
        assertArrayEquals(longArrayOf(0, 0, 4 * min), got)
    }

    @Test
    fun aStopAfterAPauseIsNotAPhantomSession() {
        val got = run(
            Event(d0 + 5 * min, ACTIVITY_RESUMED, "A"),
            Event(d0 + 6 * min, ACTIVITY_PAUSED, "A"),
            Event(d0 + 40 * min, ACTIVITY_STOPPED, "A")
        )
        assertArrayEquals(longArrayOf(1 * min, 0, 0), got)
    }
}
