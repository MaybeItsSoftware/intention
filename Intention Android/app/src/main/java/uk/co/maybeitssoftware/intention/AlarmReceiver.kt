package uk.co.maybeitssoftware.intention

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log

class AlarmReceiver : BroadcastReceiver() {
    companion object {
        private const val TAG = "AlarmReceiver"
    }

    override fun onReceive(context: Context, intent: Intent) {
        val name = intent.getStringExtra(AlarmHelper.EXTRA_ALARM_NAME) ?: return
        Log.d(TAG, "Alarm fired: $name")

        // Run the shared JS onAlarm handler so it cleans up the expired
        // session in storage, same as the extension's service worker would.
        BackgroundJsHelper.init(context)
        BackgroundJsHelper.dispatchAlarm(name)

        // Cut off the blocked app/site if it's still in the foreground.
        IntentionAccessibilityService.instance?.recheckForeground()
    }
}
