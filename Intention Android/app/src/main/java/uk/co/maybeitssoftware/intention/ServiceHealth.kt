package uk.co.maybeitssoftware.intention

import android.accessibilityservice.AccessibilityServiceInfo
import android.content.ComponentName
import android.content.Context
import android.os.Build
import android.provider.Settings
import android.text.TextUtils
import android.util.Log
import android.view.accessibility.AccessibilityManager
import java.io.File
import java.io.PrintWriter
import java.io.StringWriter
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

// Is the blocker actually running, and if it stopped, why?
//
// The case this exists for: the accessibility service throws, Android marks it
// "crashed" and stops binding it, and the switch in Settings stays on. Nothing
// is blocked, nothing says so, and the app — which only read the switch —
// reported all was well. By the time anyone looked, the stack trace had rolled
// out of logcat. So three things live here:
//
//  - status(): off / running / stopped, from the switch *and* from what the
//    system has actually bound (crashed services drop out of that list).
//  - A crash log in the app's own files, written by an uncaught-exception
//    handler, so the trace survives until someone asks for it.
//  - A short lifecycle log (connected, unbound, destroyed, caught errors), so
//    a report can tell "the user switched it off" from "it died".
//
// report() puts all of it in one block of text: shared from the app's
// "Blocking has stopped" screen, and printed by
//   adb shell dumpsys activity service uk.co.maybeitssoftware.intention/.IntentionAccessibilityService
// while the service is up.
object ServiceHealth {
    private const val TAG = "IntentionHealth"
    private const val DIR = "diagnostics"
    private const val CRASH_FILE = "crashes.txt"
    private const val EVENT_FILE = "events.txt"
    // Enough to hold a handful of full Kotlin stack traces. Older entries are
    // dropped whole, from the front.
    private const val CRASH_LOG_MAX_CHARS = 48_000
    private const val EVENT_LOG_MAX_LINES = 60
    internal const val ENTRY_SEPARATOR = "\n----- "

    enum class Status {
        // The switch is off. The existing setup gate handles this.
        OFF,
        RUNNING,
        // The switch is on but the system is not running the service — what
        // a crash leaves behind. Turning it off and on again is the cure.
        STOPPED
    }

    // Pure, for the tests. Any sign of life wins: a false "stopped" would
    // put a scary screen in front of a working blocker.
    internal fun classify(switchOn: Boolean, boundBySystem: Boolean, connectedInProcess: Boolean): Status = when {
        boundBySystem || connectedInProcess -> Status.RUNNING
        switchOn -> Status.STOPPED
        else -> Status.OFF
    }

    fun status(context: Context): Status = classify(
        switchOn = switchOn(context),
        boundBySystem = boundBySystem(context),
        connectedInProcess = IntentionAccessibilityService.instance != null
    )

    private fun ours(context: Context) =
        ComponentName(context, IntentionAccessibilityService::class.java)

    // The setting holds the component in whichever form the writer chose —
    // "pkg/pkg.Service" from stock Settings, "pkg/.Service" from some OEM
    // builds and from adb — so it is compared as a ComponentName, not text.
    // ACCESSIBILITY_ENABLED is not consulted: some builds leave it at 0 with
    // services on.
    fun switchOn(context: Context): Boolean {
        val ours = ours(context)
        val value = Settings.Secure.getString(
            context.contentResolver,
            Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES
        ) ?: return false
        val splitter = TextUtils.SimpleStringSplitter(':')
        splitter.setString(value)
        while (splitter.hasNext()) {
            if (ComponentName.unflattenFromString(splitter.next()) == ours) return true
        }
        return false
    }

    // AccessibilityManager's "enabled" list is the services the system has
    // bound, not the setting: one that crashed is in the setting but not here.
    fun boundBySystem(context: Context): Boolean {
        val ours = ours(context)
        val manager = context.getSystemService(Context.ACCESSIBILITY_SERVICE)
            as? AccessibilityManager ?: return false
        return manager.getEnabledAccessibilityServiceList(AccessibilityServiceInfo.FEEDBACK_ALL_MASK)
            .any { it.resolveInfo.serviceInfo.let { s -> s.packageName == ours.packageName && s.name == ours.className } }
    }

    // ---- crash log ------------------------------------------------------

    @Volatile private var recorderInstalled = false

    // Once per process. Chains to whatever handler was there, so Android
    // still sees the crash, restarts what it restarts, and logcat still gets
    // its FATAL EXCEPTION.
    fun installCrashRecorder(context: Context) {
        if (recorderInstalled) return
        synchronized(this) {
            if (recorderInstalled) return
            recorderInstalled = true
        }
        val app = context.applicationContext
        val previous = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { thread, error ->
            try {
                recordCrash(app, "Uncaught on thread \"${thread.name}\"", error)
                recordEvent(app, "CRASH ${error.javaClass.name}: ${error.message}")
                // Someone has to notice the service is gone; see ServiceWatchdog.
                ServiceWatchdog.armAfterCrash(app)
            } catch (_: Throwable) {
                // Never let the recorder be the thing that hides the crash.
            }
            previous?.uncaughtException(thread, error)
        }
    }

    // Also used for errors the service catches and survives, so a report
    // shows what would have killed it.
    fun recordCrash(context: Context, heading: String, error: Throwable) {
        try {
            val file = file(context, CRASH_FILE)
            val existing = if (file.exists()) file.readText() else ""
            val entry = "${ENTRY_SEPARATOR}${timestamp()} · ${versionLabel(context)} · $heading\n${stackTrace(error)}"
            file.writeText(trimCrashLog(existing + entry, CRASH_LOG_MAX_CHARS))
        } catch (e: Exception) {
            Log.w(TAG, "Could not write the crash log", e)
        }
    }

    // Keeps the newest entries that fit, dropping whole entries from the
    // front. A single entry longer than the cap keeps its head — the
    // exception and the top frames are the part worth having.
    internal fun trimCrashLog(log: String, maxChars: Int): String {
        if (log.length <= maxChars) return log
        val next = log.indexOf(ENTRY_SEPARATOR, log.length - maxChars)
        if (next >= 0) return log.substring(next)
        val last = log.lastIndexOf(ENTRY_SEPARATOR).coerceAtLeast(0)
        return log.substring(last, last + maxChars)
    }

    fun crashLog(context: Context): String = try {
        file(context, CRASH_FILE).takeIf { it.exists() }?.readText().orEmpty()
    } catch (e: Exception) {
        ""
    }

    fun clearCrashLog(context: Context) {
        try {
            file(context, CRASH_FILE).delete()
        } catch (_: Exception) {
        }
    }

    // ---- lifecycle log --------------------------------------------------

    fun recordEvent(context: Context, what: String) {
        Log.i(TAG, what)
        try {
            val file = file(context, EVENT_FILE)
            val lines = if (file.exists()) file.readLines() else emptyList()
            val updated = trimLines(lines + "${timestamp()}  $what", EVENT_LOG_MAX_LINES)
            file.writeText(updated.joinToString("\n", postfix = "\n"))
        } catch (e: Exception) {
            Log.w(TAG, "Could not write the event log", e)
        }
    }

    internal fun trimLines(lines: List<String>, max: Int): List<String> =
        if (lines.size <= max) lines else lines.takeLast(max)

    fun eventLog(context: Context): String = try {
        file(context, EVENT_FILE).takeIf { it.exists() }?.readText().orEmpty()
    } catch (e: Exception) {
        ""
    }

    // ---- report ---------------------------------------------------------

    fun report(context: Context): String = buildString {
        appendLine("Intention diagnostics")
        appendLine("Generated: ${timestamp()}")
        appendLine("App: ${versionLabel(context)}")
        appendLine("Device: ${Build.MANUFACTURER} ${Build.MODEL}, Android ${Build.VERSION.RELEASE} (API ${Build.VERSION.SDK_INT})")
        appendLine()
        appendLine("Status: ${status(context)}")
        appendLine("  switch on:          ${switchOn(context)}")
        appendLine("  bound by system:    ${boundBySystem(context)}")
        appendLine("  connected in-proc:  ${IntentionAccessibilityService.instance != null}")
        appendLine()
        appendLine("Service events (oldest first):")
        append(eventLog(context).ifEmpty { "  (none recorded)\n" })
        appendLine()
        appendLine("Crashes and caught errors (oldest first):")
        append(crashLog(context).ifEmpty { "  (none recorded)" })
        appendLine()
    }

    // ---- helpers --------------------------------------------------------

    private fun file(context: Context, name: String): File =
        File(context.applicationContext.filesDir, DIR).apply { mkdirs() }.let { File(it, name) }

    private fun timestamp(): String =
        SimpleDateFormat("yyyy-MM-dd HH:mm:ss.SSS Z", Locale.US).format(Date())

    private fun versionLabel(context: Context): String = try {
        val info = context.packageManager.getPackageInfo(context.packageName, 0)
        val code = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) info.longVersionCode else {
            @Suppress("DEPRECATION") info.versionCode.toLong()
        }
        "${info.versionName} ($code)"
    } catch (e: Exception) {
        "unknown version"
    }

    private fun stackTrace(error: Throwable): String =
        StringWriter().also { error.printStackTrace(PrintWriter(it)) }.toString()
}
