package uk.co.maybeitssoftware.intention

import org.junit.Assert.assertEquals
import org.junit.Test

/** When the "Blocking has stopped" notification goes up, and when it stays quiet. */
class ServiceWatchdogTest {
    private val stopped = ServiceHealth.Status.STOPPED
    private val hour = 60 * 60_000L

    @Test
    fun stoppedAndNotYetToldNotifies() {
        assertEquals(ServiceWatchdog.Action.NOTIFY, ServiceWatchdog.decide(stopped, 0L, 10 * hour))
    }

    @Test
    fun stoppedAndRecentlyToldStaysQuiet() {
        assertEquals(ServiceWatchdog.Action.NONE, ServiceWatchdog.decide(stopped, 10 * hour, 11 * hour))
    }

    @Test
    fun stoppedForHoursIsToldAgain() {
        val notifiedAt = 10 * hour
        assertEquals(
            ServiceWatchdog.Action.NOTIFY,
            ServiceWatchdog.decide(stopped, notifiedAt, notifiedAt + ServiceWatchdog.RENOTIFY_AFTER_MS)
        )
    }

    @Test
    fun runningClearsTheNotification() {
        assertEquals(ServiceWatchdog.Action.CLEAR, ServiceWatchdog.decide(ServiceHealth.Status.RUNNING, 5L, 10L))
    }

    @Test
    fun switchedOffByTheUserIsNotNaggedAndStopsChecking() {
        assertEquals(ServiceWatchdog.Action.CLEAR_AND_DISARM, ServiceWatchdog.decide(ServiceHealth.Status.OFF, 0L, 10L))
    }
}
