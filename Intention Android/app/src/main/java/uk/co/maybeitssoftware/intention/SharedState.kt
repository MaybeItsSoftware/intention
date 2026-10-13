package uk.co.maybeitssoftware.intention

import android.content.Context
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject

/**
 * The native side's view of the three keys the background WebView owns and
 * the blocking decisions are made from: blockedApps, blockedDomains and
 * activeSessions, all JSON text in `intention_prefs`.
 *
 * Two jobs, both of which used to be done ad hoc by every reader:
 *
 *  - Parsing once per value, not once per read. The accessibility service
 *    asks "is this blocked?" and "is there a pass?" on every content event a
 *    scrolling feed emits, and ForegroundPass and SessionOverlay each asked
 *    again — three parses of the same unchanged string per event. Each parse
 *    is cached against the raw text it came from, so a write by the
 *    background (which always replaces the string) is the only thing that
 *    costs a fresh one.
 *
 *  - One lock for activeSessions. ForegroundPass read-modify-writes it on the
 *    main thread while BackgroundJsHelper.setSharedStorage writes the same key
 *    from the JS bridge thread; without a shared lock a pause stamp could be
 *    written over a grant the background had saved a moment before. Every
 *    native mutation goes through [mutateActiveSessions], and setSharedStorage
 *    takes [lock] around its write.
 */
object SharedState {
    private const val TAG = "SharedState"
    const val PREFS = "intention_prefs"
    const val KEY_ACTIVE_SESSIONS = "activeSessions"
    private const val KEY_BLOCKED_APPS = "blockedApps"
    private const val KEY_BLOCKED_DOMAINS = "blockedDomains"

    /** Held by every writer of activeSessions, native or bridged. */
    val lock = Any()

    private class Parsed<T>(val raw: String, val value: T)

    @Volatile private var sessionsCache: Parsed<JSONObject>? = null
    @Volatile private var appsCache: Parsed<Set<String>>? = null
    @Volatile private var domainsCache: Parsed<List<String>>? = null

    private fun read(context: Context, key: String, default: String): String =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(key, default) ?: default

    /**
     * activeSessions, parsed. SHARED and therefore READ-ONLY: the same object
     * is handed to every caller until the stored text changes, so anything
     * that wants to change a session goes through [mutateActiveSessions],
     * which works on a copy of its own.
     */
    fun activeSessions(context: Context): JSONObject {
        val raw = read(context, KEY_ACTIVE_SESSIONS, "{}")
        sessionsCache?.let { if (it.raw == raw) return it.value }
        val parsed = try {
            JSONObject(raw)
        } catch (e: Exception) {
            // Cached as empty all the same, so an unreadable value logs once
            // rather than once per accessibility event.
            Log.e(TAG, "Could not read activeSessions: ", e)
            JSONObject()
        }
        sessionsCache = Parsed(raw, parsed)
        return parsed
    }

    fun blockedApps(context: Context): Set<String> {
        val raw = read(context, KEY_BLOCKED_APPS, "[]")
        appsCache?.let { if (it.raw == raw) return it.value }
        val parsed = stringsOf(raw, KEY_BLOCKED_APPS).toHashSet()
        appsCache = Parsed(raw, parsed)
        return parsed
    }

    fun blockedDomains(context: Context): List<String> {
        val raw = read(context, KEY_BLOCKED_DOMAINS, "[]")
        domainsCache?.let { if (it.raw == raw) return it.value }
        val parsed = stringsOf(raw, KEY_BLOCKED_DOMAINS)
        domainsCache = Parsed(raw, parsed)
        return parsed
    }

    // A JSON array of strings, e.g. ["instagram.com", ...]. Whatever parsed
    // before a malformed entry is kept, as the per-read loops this replaced did.
    private fun stringsOf(raw: String, key: String): List<String> {
        val out = mutableListOf<String>()
        try {
            val array = JSONArray(raw)
            for (i in 0 until array.length()) out.add(array.getString(i))
        } catch (e: Exception) {
            Log.e(TAG, "Could not read $key: ", e)
        }
        return out
    }

    /**
     * activeSessions as the background WebView wants to store it, with the
     * native-owned pause fields of each pass carried over from what is stored.
     *
     * The background's storage queue reads, awaits, then writes the whole
     * object, so a pause or resume ForegroundPass stamped in between would be
     * written over by the background's older copy. The background only sets
     * pausedAt / pausedDurationMs / wallExpiresAt when it grants a pass; after
     * that only the native side moves them. So for a pass that is the same
     * grant on both sides (same key, same startTime) the stored values win:
     * pause state as stored, the larger paused total, the earlier hard end. A
     * new grant (absent or a different startTime) is the background's alone.
     * Pure, so it is testable on the JVM; the caller holds [lock].
     */
    fun mergeNativeSessionFields(storedRaw: String?, incomingRaw: String): String {
        val stored = try { JSONObject(storedRaw ?: return incomingRaw) } catch (e: Exception) { return incomingRaw }
        val incoming = try { JSONObject(incomingRaw) } catch (e: Exception) { return incomingRaw }
        var changed = false
        val keys = incoming.keys()
        while (keys.hasNext()) {
            val key = keys.next()
            val next = incoming.optJSONObject(key) ?: continue
            val prev = stored.optJSONObject(key) ?: continue
            val start = next.optLong("startTime", -1L)
            if (start < 0L || start != prev.optLong("startTime", -2L)) continue

            val prevPausedTotal = prev.optLong("pausedDurationMs", 0L)
            if (prevPausedTotal > next.optLong("pausedDurationMs", 0L)) {
                next.put("pausedDurationMs", prevPausedTotal); changed = true
            }
            val prevPausedAt = prev.optLong("pausedAt", 0L)
            if (prevPausedAt > 0L) {
                if (next.optLong("pausedAt", 0L) != prevPausedAt) { next.put("pausedAt", prevPausedAt); changed = true }
            } else if (next.has("pausedAt")) {
                next.remove("pausedAt"); changed = true
            }
            val prevWall = prev.optLong("wallExpiresAt", 0L)
            val nextWall = next.optLong("wallExpiresAt", 0L)
            if (prevWall > 0L && (nextWall <= 0L || prevWall < nextWall)) {
                next.put("wallExpiresAt", prevWall); changed = true
            }
        }
        return if (changed) incoming.toString() else incomingRaw
    }

    /**
     * Read-modify-write of activeSessions under [lock]. [block] gets the
     * stored text and returns the text to store, or null to leave it alone.
     * Returns what was written, or null when nothing was.
     */
    fun mutateActiveSessions(context: Context, block: (raw: String) -> String?): String? =
        synchronized(lock) {
            val raw = read(context, KEY_ACTIVE_SESSIONS, "{}")
            val next = block(raw) ?: return@synchronized null
            if (next == raw) return@synchronized null
            // apply() updates the in-memory map before it returns, which is
            // what every reader sees; the disk write can trail behind.
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .edit().putString(KEY_ACTIVE_SESSIONS, next).apply()
            next
        }
}
