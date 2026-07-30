package uk.co.maybeitssoftware.intention

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Handler
import android.os.Looper
import android.util.Log
import java.util.concurrent.atomic.AtomicBoolean

// AlarmManager drops every pending alarm when the device restarts, and nothing
// re-creates them, so a granted pass that spans a reboot never fires its
// check-in: its minutes are never recorded into dailyStats/allTimeStats and the
// session sits in activeSessions unbanked forever. Blocking itself is
// unaffected — IntentionAccessibilityService recomputes expiry from the stored
// timestamps on every event — so this only puts the bookkeeping back.
//
// Deliberately ACTION_BOOT_COMPLETED, which the system sends after the user
// unlocks, rather than ACTION_LOCKED_BOOT_COMPLETED: the session data lives in
// the default credential-encrypted SharedPreferences, which cannot be read
// before first unlock.
class BootReceiver : BroadcastReceiver() {

    companion object {
        private const val TAG = "BootReceiver"
        // Some OEM skins send these instead of BOOT_COMPLETED for a "fast boot".
        private const val ACTION_QUICKBOOT_POWERON = "android.intent.action.QUICKBOOT_POWERON"
        private const val ACTION_HTC_QUICKBOOT_POWERON = "com.htc.intent.action.QUICKBOOT_POWERON"
        // Upper bound on how long the broadcast is held open. A receiver gets
        // roughly ten seconds before the system treats it as stuck, and the work
        // here is a local page load plus a couple of SharedPreferences writes.
        private const val WATCHDOG_MS = 8_000L
    }

    override fun onReceive(context: Context, intent: Intent) {
        when (intent.action) {
            Intent.ACTION_BOOT_COMPLETED,
            // Alarms are also cancelled when the package is replaced.
            Intent.ACTION_MY_PACKAGE_REPLACED,
            ACTION_QUICKBOOT_POWERON,
            ACTION_HTC_QUICKBOOT_POWERON -> {}
            else -> return
        }
        Log.d(TAG, "Reconciling sessions after ${intent.action}")

        // BackgroundJsHelper reconciles on its own as soon as background.html
        // loads; this request is queued behind that one and only serves as a
        // barrier, so the process isn't reclaimed part-way through the work.
        val pending = goAsync()
        val finished = AtomicBoolean(false)
        val finishOnce = {
            if (finished.compareAndSet(false, true)) pending.finish()
        }
        Handler(Looper.getMainLooper()).postDelayed({
            if (!finished.get()) Log.w(TAG, "Reconcile did not finish within ${WATCHDOG_MS}ms")
            finishOnce()
        }, WATCHDOG_MS)

        BackgroundJsHelper.init(context)
        BackgroundJsHelper.reconcileSessions { finishOnce() }
    }
}
