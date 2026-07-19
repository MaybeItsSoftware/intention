package uk.co.maybeitssoftware.intention

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.util.Log
import org.json.JSONObject

object AlarmHelper {
    private const val TAG = "AlarmHelper"
    const val ACTION_ALARM = "uk.co.maybeitssoftware.intention.ALARM"
    const val EXTRA_ALARM_NAME = "alarmName"

    fun createAlarm(context: Context, name: String, infoJson: String) {
        try {
            val info = JSONObject(infoJson)
            // Mirrors chrome.alarms.create: either an absolute "when" epoch ms
            // or a relative "delayInMinutes".
            val whenMs = info.optLong("when", 0L)
            val delayMinutes = info.optDouble("delayInMinutes", 0.0)
            val triggerAt = when {
                whenMs > 0L -> whenMs
                delayMinutes > 0.0 -> System.currentTimeMillis() + (delayMinutes * 60_000).toLong()
                else -> return
            }

            val alarmManager = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
            val pi = pendingIntent(context, name)
            // SCHEDULE_EXACT_ALARM is denied by default on API 33+, so fall back
            // to an inexact alarm; the accessibility service's own expiry timer is
            // the primary cutoff and this alarm is the process-death/Doze backup.
            val canExact = Build.VERSION.SDK_INT < Build.VERSION_CODES.S ||
                alarmManager.canScheduleExactAlarms()
            if (canExact) {
                alarmManager.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, triggerAt, pi)
            } else {
                alarmManager.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, triggerAt, pi)
            }
            Log.d(TAG, "Scheduled alarm '$name' at $triggerAt (exact=$canExact)")
        } catch (e: Exception) {
            Log.e(TAG, "Error creating alarm '$name': ", e)
        }
    }

    fun clearAlarm(context: Context, name: String) {
        Log.d(TAG, "Clearing alarm: $name")
        val alarmManager = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
        alarmManager.cancel(pendingIntent(context, name))
    }

    // The Uri data makes each alarm name resolve to a distinct PendingIntent
    // (Intent.filterEquals includes data), so alarms with different names
    // coexist and re-creating the same name replaces it, matching
    // chrome.alarms semantics.
    private fun pendingIntent(context: Context, name: String): PendingIntent {
        val intent = Intent(context, AlarmReceiver::class.java).apply {
            action = ACTION_ALARM
            data = Uri.parse("intention://alarm/" + Uri.encode(name))
            putExtra(EXTRA_ALARM_NAME, name)
        }
        return PendingIntent.getBroadcast(
            context, 0, intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
    }
}
