package uk.co.maybeitssoftware.intention

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The verdict behind the "Blocking has stopped" screen, and the trimming that
 * keeps the on-device crash log bounded without cutting an entry in half.
 */
class ServiceHealthTest {
    private val sep = ServiceHealth.ENTRY_SEPARATOR

    @Test
    fun switchOnButNotRunningIsStopped() {
        // What a crash leaves: the setting still lists the service, the system
        // has stopped binding it.
        assertEquals(ServiceHealth.Status.STOPPED, ServiceHealth.classify(true, false, false))
    }

    @Test
    fun anySignOfLifeIsRunning() {
        assertEquals(ServiceHealth.Status.RUNNING, ServiceHealth.classify(true, true, false))
        assertEquals(ServiceHealth.Status.RUNNING, ServiceHealth.classify(true, false, true))
        // The setting spelled in a form we failed to parse, but bound: running,
        // not off — the old check's "either is enough".
        assertEquals(ServiceHealth.Status.RUNNING, ServiceHealth.classify(false, true, false))
    }

    @Test
    fun switchOffAndNotRunningIsOff() {
        assertEquals(ServiceHealth.Status.OFF, ServiceHealth.classify(false, false, false))
    }

    @Test
    fun shortLogIsUntouched() {
        val log = "${sep}a\ntrace"
        assertEquals(log, ServiceHealth.trimCrashLog(log, 1000))
    }

    @Test
    fun trimDropsWholeOldestEntries() {
        val old = "${sep}OLD " + "x".repeat(100)
        val mid = "${sep}MID " + "y".repeat(100)
        val new = "${sep}NEW " + "z".repeat(100)
        val trimmed = ServiceHealth.trimCrashLog(old + mid + new, 250)
        assertEquals(mid + new, trimmed)
    }

    @Test
    fun oversizedSingleEntryKeepsItsHead() {
        val entry = "${sep}HEAD exception\n" + "frame\n".repeat(200)
        val trimmed = ServiceHealth.trimCrashLog(entry, 100)
        assertEquals(100, trimmed.length)
        assertTrue(trimmed.startsWith("${sep}HEAD exception"))
    }

    @Test
    fun eventLogKeepsNewestLines() {
        val lines = (1..10).map { "e$it" }
        assertEquals(listOf("e8", "e9", "e10"), ServiceHealth.trimLines(lines, 3))
    }
}
