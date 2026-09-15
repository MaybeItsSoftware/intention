package uk.co.maybeitssoftware.intention

/** Foreground time used by an Android pass. Existing passes have zero paused time. */
object PassClock {
    fun elapsedMs(startTime: Long, pausedDurationMs: Long, pausedAt: Long, now: Long): Long =
        ((if (pausedAt > 0L) minOf(now, pausedAt) else now) - startTime - pausedDurationMs)
            .coerceAtLeast(0L)

    fun expiresAt(startTime: Long, intervalMinutes: Long, pausedDurationMs: Long): Long =
        startTime + intervalMinutes * 60_000L + pausedDurationMs

    fun isLive(startTime: Long, intervalMinutes: Long, pausedDurationMs: Long, pausedAt: Long, now: Long): Boolean =
        startTime > 0L && intervalMinutes > 0L &&
            elapsedMs(startTime, pausedDurationMs, pausedAt, now) < intervalMinutes * 60_000L
}
