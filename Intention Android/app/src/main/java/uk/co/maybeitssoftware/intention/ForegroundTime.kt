package uk.co.maybeitssoftware.intention

/**
 * Per-day foreground time for one app, rebuilt from raw usage events.
 *
 * Why events and not `queryUsageStats(INTERVAL_DAILY, ...)`: the daily
 * buckets are not calendar days. Each bucket starts whenever the system last
 * rolled its daily file over, the query returns every bucket that merely
 * *overlaps* the range asked for, and `totalTimeInForeground` is the whole
 * bucket's figure, so "yesterday" routinely comes back carrying part of today
 * or the day before, and summing the buckets for a day double-counts. Events
 * are timestamped to the millisecond, so they can be cut at local midnight
 * exactly, which is what a seven-day strip labelled by weekday needs.
 *
 * The cost is retention: the system keeps event-level history for roughly a
 * week (less on some OEM builds), so this is the right tool for the gate's
 * seven days and the wrong one for a year. A day older than the retained
 * events simply reads as zero.
 *
 * Kept free of Android types so the JVM tests can drive it with synthetic
 * events; WebAppInterface does the `UsageEvents` iteration and hands over
 * only what matters.
 */
object ForegroundTime {
    // UsageEvents.Event constants, by value. The names changed in API 29
    // (MOVE_TO_FOREGROUND became ACTIVITY_RESUMED) but the numbers did not.
    const val ACTIVITY_RESUMED = 1
    const val ACTIVITY_PAUSED = 2
    const val SCREEN_NON_INTERACTIVE = 16
    const val ACTIVITY_STOPPED = 23
    const val DEVICE_SHUTDOWN = 26

    /** One event. `className` is the activity; device-wide events carry none. */
    data class Event(val timeMillis: Long, val type: Int, val className: String? = null)

    /** True for the event types [perDay] reads; everything else can be dropped early. */
    fun isRelevant(type: Int): Boolean = when (type) {
        ACTIVITY_RESUMED, ACTIVITY_PAUSED, ACTIVITY_STOPPED,
        SCREEN_NON_INTERACTIVE, DEVICE_SHUTDOWN -> true
        else -> false
    }

    /** True for the device-wide events that belong to no app. */
    fun isDeviceWide(type: Int): Boolean = type == SCREEN_NON_INTERACTIVE || type == DEVICE_SHUTDOWN

    /**
     * Milliseconds in the foreground for each day.
     *
     * @param events      the target package's activity events plus the
     *                    device-wide ones, in time order, from `queryStart`
     * @param queryStart  where the events begin; an activity whose first event
     *                    is a pause was already open here
     * @param dayStarts   local midnight of each day, oldest first
     * @param windowEnd   end of the last day's range (now, for today)
     */
    fun perDay(events: List<Event>, queryStart: Long, dayStarts: LongArray, windowEnd: Long): LongArray {
        val totals = LongArray(dayStarts.size)
        if (dayStarts.isEmpty()) return totals

        fun credit(from: Long, to: Long) {
            if (to <= from) return
            for (i in dayStarts.indices) {
                val start = dayStarts[i]
                val end = if (i + 1 < dayStarts.size) dayStarts[i + 1] else windowEnd
                val overlap = minOf(to, end) - maxOf(from, start)
                if (overlap > 0) totals[i] += overlap
            }
        }

        // An app with several activities hands the foreground between them,
        // and B can resume before A reports its pause, so the app is in the
        // foreground while ANY of its activities is resumed, not from one
        // resume to the next pause.
        val resumed = mutableSetOf<String>()
        val seen = mutableSetOf<String>()
        var since = 0L

        for (event in events) {
            val t = event.timeMillis
            when (event.type) {
                ACTIVITY_RESUMED -> {
                    val cls = event.className ?: ""
                    if (resumed.isEmpty()) since = t
                    resumed.add(cls)
                    seen.add(cls)
                }
                ACTIVITY_PAUSED, ACTIVITY_STOPPED -> {
                    val cls = event.className ?: ""
                    if (resumed.remove(cls)) {
                        if (resumed.isEmpty()) credit(since, t)
                    } else if (resumed.isEmpty() && cls !in seen && event.type == ACTIVITY_PAUSED) {
                        // First word from this activity is a pause: it was in
                        // the foreground before the events we were given.
                        credit(queryStart, t)
                    }
                    seen.add(cls)
                }
                // A lost pause (a crash, a killed process) must not turn into
                // a day of phantom foreground time: the screen going off or
                // the device going down ends everything.
                SCREEN_NON_INTERACTIVE, DEVICE_SHUTDOWN -> {
                    if (resumed.isNotEmpty()) {
                        credit(since, t)
                        resumed.clear()
                    }
                }
            }
        }
        // Still open at the end of the window: count up to now.
        if (resumed.isNotEmpty()) credit(since, windowEnd)
        return totals
    }
}
