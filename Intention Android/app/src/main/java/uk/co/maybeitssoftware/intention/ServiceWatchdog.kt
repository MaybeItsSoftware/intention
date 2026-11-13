package uk.co.maybeitssoftware.intention

import android.app.AlarmManager
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.SystemClock
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat

// Tells the user when blocking has stopped, without waiting for them to open
// the app. ServiceHealth can tell a crashed service from a switched-off one,
// but only when something asks; with the service dead, nothing in this app
// runs on its own. So an alarm asks:
//
//  - every ~15 minutes, inexact and non-waking (ELAPSED_REALTIME): it fires
//    only while the phone is awake, which is the only time blocking matters,
//    and costs nothing while it sleeps. Armed whenever the service connects,
//    and after a reboot or an update (BootReceiver), since AlarmManager
//    forgets alarms across both.
//  - once, a minute after a crash, armed from ServiceHealth's uncaught
//    handler, so the user hears within a minute rather than a quarter-hour.
//
// A stopped service gets one notification per episode, re-posted only if it
// is still stopped hours later. One the user switched off gets nothing, and
// the checks stop: turning Intention off is their call (and the leaving flow
// already has its say), not a fault to nag about.
object ServiceWatchdog {
    private const val TAG = "ServiceWatchdog"
    private const val CHANNEL_ID = "intention_blocking_status"
    private const val NOTIFICATION_ID = 0x1A11
    private const val PREFS = "service_watchdog"
    private const val KEY_NOTIFIED_AT = "notifiedAt"
    private const val CHECK_INTERVAL_MS = AlarmManager.INTERVAL_FIFTEEN_MINUTES
    private const val AFTER_CRASH_MS = 60_000L
    // A notification the user swiped away is posted again after this long if
    // blocking is still down — long enough not to nag, short enough that a
    // day does not go by unprotected without a word.
    internal const val RENOTIFY_AFTER_MS = 6 * 60 * 60_000L

    internal const val ACTION_CHECK = "uk.co.maybeitssoftware.intention.WATCHDOG_CHECK"

    enum class Action { NOTIFY, CLEAR, CLEAR_AND_DISARM, NONE }

    // Pure, for the tests. notifiedAt is 0 when this episode has not been
    // notified yet.
    internal fun decide(status: ServiceHealth.Status, notifiedAt: Long, now: Long): Action = when (status) {
        ServiceHealth.Status.RUNNING -> Action.CLEAR
        ServiceHealth.Status.OFF -> Action.CLEAR_AND_DISARM
        ServiceHealth.Status.STOPPED ->
            if (notifiedAt == 0L || now - notifiedAt >= RENOTIFY_AFTER_MS) Action.NOTIFY else Action.NONE
    }

    fun arm(context: Context) {
        val alarms = context.getSystemService(Context.ALARM_SERVICE) as? AlarmManager ?: return
        alarms.setInexactRepeating(
            AlarmManager.ELAPSED_REALTIME,
            SystemClock.elapsedRealtime() + CHECK_INTERVAL_MS,
            CHECK_INTERVAL_MS,
            pendingIntent(context, "periodic")
        )
    }

    // From the crash handler: the process is about to die, so this has to be
    // an alarm, not a Handler post.
    fun armAfterCrash(context: Context) {
        val alarms = context.getSystemService(Context.ALARM_SERVICE) as? AlarmManager ?: return
        alarms.set(
            AlarmManager.ELAPSED_REALTIME,
            SystemClock.elapsedRealtime() + AFTER_CRASH_MS,
            pendingIntent(context, "after-crash")
        )
    }

    private fun disarm(context: Context) {
        val alarms = context.getSystemService(Context.ALARM_SERVICE) as? AlarmManager ?: return
        alarms.cancel(pendingIntent(context, "periodic"))
    }

    // The data Uri keeps the two alarms' PendingIntents distinct, as in
    // AlarmHelper.
    private fun pendingIntent(context: Context, which: String): PendingIntent =
        PendingIntent.getBroadcast(
            context, 0,
            Intent(context, ServiceWatchdogReceiver::class.java)
                .setAction(ACTION_CHECK)
                .setData(Uri.parse("intention://watchdog/$which")),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

    fun check(context: Context) {
        val app = context.applicationContext
        val prefs = app.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val status = ServiceHealth.status(app)
        val now = System.currentTimeMillis()
        when (decide(status, prefs.getLong(KEY_NOTIFIED_AT, 0L), now)) {
            Action.NOTIFY -> {
                ServiceHealth.recordEvent(app, "watchdog: switch on but service not running — notifying")
                if (notify(app)) prefs.edit().putLong(KEY_NOTIFIED_AT, now).apply()
            }
            Action.CLEAR -> clear(app, prefs)
            Action.CLEAR_AND_DISARM -> {
                clear(app, prefs)
                disarm(app)
            }
            Action.NONE -> {}
        }
    }

    private fun clear(context: Context, prefs: android.content.SharedPreferences) {
        if (prefs.getLong(KEY_NOTIFIED_AT, 0L) == 0L) return
        NotificationManagerCompat.from(context).cancel(NOTIFICATION_ID)
        prefs.edit().remove(KEY_NOTIFIED_AT).apply()
    }

    // False when it could not be shown (notifications refused), so the next
    // check tries again rather than believing the user was told.
    private fun notify(context: Context): Boolean {
        val compat = NotificationManagerCompat.from(context)
        if (!compat.areNotificationsEnabled()) {
            Log.w(TAG, "Blocking has stopped, but notifications are off")
            return false
        }
        val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        manager.createNotificationChannel(
            NotificationChannel(
                CHANNEL_ID,
                "Blocking status",
                // DEFAULT: the user is unprotected and does not know it. Worth
                // a sound, not a heads-up over whatever they are doing.
                NotificationManager.IMPORTANCE_DEFAULT
            ).apply {
                description = "Tells you if Android stops Intention's blocking."
            }
        )
        val open = PendingIntent.getActivity(
            context, 0,
            Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val notification = NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle("Blocking has stopped")
            .setContentText("Android stopped Intention. Tap to turn it back on.")
            .setStyle(
                NotificationCompat.BigTextStyle().bigText(
                    "Android stopped Intention's Accessibility service, so nothing is being " +
                        "blocked. Tap to turn it off and on again."
                )
            )
            .setContentIntent(open)
            .setAutoCancel(true)
            .setPriority(NotificationCompat.PRIORITY_DEFAULT)
            .build()
        return try {
            compat.notify(NOTIFICATION_ID, notification)
            true
        } catch (e: SecurityException) {
            Log.w(TAG, "Could not post the stopped notification", e)
            false
        }
    }
}

class ServiceWatchdogReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != ServiceWatchdog.ACTION_CHECK) return
        ServiceWatchdog.check(context)
    }
}
