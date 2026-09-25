package uk.co.maybeitssoftware.intention

/** Foreground time used by an Android pass. Existing passes have zero paused time. */
object PassClock {
    /**
     * How long a pass survives with its target out of the foreground. Time
     * away is not charged, but past this the user has left and the pass is
     * over. Mirrors LEAVE_GRACE_MS in shared/background.js; keep them equal.
     */
    const val LEAVE_GRACE_MS = 60_000L

    /** True once a paused pass has been away long enough to count as left. */
    fun leftTooLong(pausedAt: Long, now: Long): Boolean =
        pausedAt > 0L && now - pausedAt >= LEAVE_GRACE_MS

    fun elapsedMs(startTime: Long, pausedDurationMs: Long, pausedAt: Long, now: Long): Long =
        ((if (pausedAt > 0L) minOf(now, pausedAt) else now) - startTime - pausedDurationMs)
            .coerceAtLeast(0L)

    fun expiresAt(startTime: Long, intervalMinutes: Long, pausedDurationMs: Long): Long =
        startTime + intervalMinutes * 60_000L + pausedDurationMs

    fun isLive(startTime: Long, intervalMinutes: Long, pausedDurationMs: Long, pausedAt: Long, now: Long): Boolean =
        startTime > 0L && intervalMinutes > 0L && !leftTooLong(pausedAt, now) &&
            elapsedMs(startTime, pausedDurationMs, pausedAt, now) < intervalMinutes * 60_000L
}
