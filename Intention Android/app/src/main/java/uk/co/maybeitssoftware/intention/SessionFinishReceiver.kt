package uk.co.maybeitssoftware.intention

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log

// The "Finished" action on the ongoing-pass notification — the fallback the
// user gets when SYSTEM_ALERT_WINDOW was refused and there is no floating badge
// to tap. A manifest receiver rather than one registered from the accessibility
// service: a posted notification outlives the process that posted it, so its
// action has to be reachable from a cold start.
class SessionFinishReceiver : BroadcastReceiver() {

    companion object {
        private const val TAG = "SessionFinishReceiver"
    }

    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != SessionOverlay.ACTION_FINISH) return
        val domain = intent.getStringExtra(SessionOverlay.EXTRA_DOMAIN) ?: return
        Log.d(TAG, "Finished tapped for $domain")
        SessionOverlay.finishSession(context.applicationContext, domain)
    }
}
