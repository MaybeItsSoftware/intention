package uk.co.maybeitssoftware.intention

import android.accessibilityservice.AccessibilityService
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.graphics.PixelFormat
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.text.TextUtils
import android.util.Log
import android.util.TypedValue
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.WindowManager
import android.widget.LinearLayout
import android.widget.TextView
import androidx.core.app.NotificationCompat
import org.json.JSONObject
import kotlin.math.roundToInt

// What the user sees while a granted pass is running. Android had nothing here:
// the pass was invisible, so the only way to learn how much of it was left was
// to wait for the coach to reappear.
//
// This is the desktop badge (renderStatusBadge in shared/content.js) as a
// floating window, and it deliberately reads the same way: elapsed time first,
// the granted length beside it, the purpose they gave the coach in quiet text,
// and a "Finished" affordance that ends the pass early. The clock counts UP,
// like the badge does — during a bounded pass the useful number is how much of
// what you asked for you have spent, not a countdown ticking towards a cliff.
//
// Unlike the badge, this is not scoped to the blocked app: it stays up while the
// pass is live wherever the user goes (bar Intention's own screens). The pass
// burns wall-clock time whether or not they are looking at the app, so hiding
// the timer the moment they switch away would hide the truth — and it puts
// "Finished" within reach at the moment they realise they are done, which is
// what banks the unused minutes as closed early.
//
// Everything here is strictly additive. Without SYSTEM_ALERT_WINDOW there is no
// window, and the ongoing notification below stands in for it; if that is
// refused too, the user sees exactly what they saw before. Blocking never
// depends on any of it.
object SessionOverlay {
    private const val TAG = "SessionOverlay"

    // House palette, dark mode: a grape hue pulled down, never neutral grey.
    // Hardcoded rather than themed because every view here is built in code,
    // and these four colours are all of it.
    private const val COLOR_SURFACE = "#25232f"
    private const val COLOR_SUBTLE = "#2d2b38"
    private const val COLOR_BORDER = "#34313f"
    private const val COLOR_TEXT = "#f5f4f7"
    private const val COLOR_MUTED = "#b6b3bf"

    private const val TICK_MS = 1_000L
    private const val FINISH_GRACE_MS = 15_000L
    private const val CHANNEL_ID = "intention_active_pass"
    private const val NOTIFICATION_ID = 1973

    const val ACTION_FINISH = "uk.co.maybeitssoftware.intention.FINISH_SESSION"
    const val EXTRA_DOMAIN = "domain"

    // The part of a shared/background.js session object this screen needs.
    // `reason` is the purpose the user gave the coach; `endedAt` (checked in
    // liveSession) marks one whose minutes are already banked.
    data class LiveSession(
        val domain: String,
        val reason: String,
        val startTime: Long,
        val intervalMinutes: Long
    ) {
        val expiresAt: Long get() = startTime + intervalMinutes * 60_000L
    }

    private val handler = Handler(Looper.getMainLooper())

    private var windowManager: WindowManager? = null
    private var view: View? = null
    private var layoutParams: WindowManager.LayoutParams? = null
    private var timeLabel: TextView? = null
    // The session currently on screen (window or notification), so a tick can
    // re-render without re-reading storage, and a re-sync can tell "same pass,
    // just move the clock on" from "different pass, rebuild".
    private var showing: LiveSession? = null
    private var notificationPosted = false
    // Kept so a tick that outlives its window still has somewhere to clean up
    // from. Application context only — this object outlives every other one.
    private var appContext: Context? = null
    // The domain of a pass the user has just finished, held only until the
    // background page has actually retired it (see finishSession).
    private var finishing: String? = null

    private val tick = Runnable { onTick() }
    // If that answer never comes — a background WebView that never became
    // ready — the suppression must not outlive the pass it was covering for.
    private val clearFinishing = Runnable { finishing = null }

    // Single entry point: work out whether a pass is live and put the right
    // thing on screen. `overOwnUi` hides it while Intention's own screens are in
    // front — the coach must never have a timer floating over it, and the
    // settings page has no use for one.
    fun sync(context: Context, overOwnUi: Boolean = false) {
        val ctx = context.applicationContext
        appContext = ctx
        val session = if (overOwnUi) null else liveSession(ctx)
        onMain {
            if (session == null) hideInternal(ctx) else showInternal(ctx, session)
        }
    }

    fun hide(context: Context) {
        val ctx = context.applicationContext
        appContext = ctx
        onMain { hideInternal(ctx) }
    }

    // "Finished": the same ending the desktop badge's button reaches, and it has
    // to stay the same one — endSession with reason "fulfilled" is what tells
    // background.js to bank the pass as closed early rather than run out, and
    // that distinction is what the coach's track record is built on.
    fun finishSession(context: Context, domain: String) {
        val ctx = context.applicationContext
        appContext = ctx
        // endSession is a round trip through the background page, so for a
        // moment the pass is still in storage after the user has said they are
        // done with it. Without this, the app switch to the home screen below
        // re-syncs, finds that session and puts the badge straight back up.
        finishing = domain
        handler.postDelayed(clearFinishing, FINISH_GRACE_MS)
        hide(ctx)

        // The desktop badge's endSession closes the tab the pass was granted
        // for (chrome.tabs.remove, on `fulfilled`). Android has no tab, and the
        // equivalent of taking the site off the screen is the home screen — so
        // send them there rather than leaving them standing in the app they
        // just said they were finished with, where the re-gate below would
        // otherwise put the coach straight back in their face.
        goHome(ctx)

        BackgroundJsHelper.init(ctx)
        val message = JSONObject()
            .put("action", "endSession")
            .put("domain", domain)
            .put("reason", "fulfilled")
            .toString()
        BackgroundJsHelper.sendMessage(message) { response ->
            Log.d(TAG, "endSession(fulfilled) for $domain -> $response")
            handler.removeCallbacks(clearFinishing)
            finishing = null
            // Only once storage has actually lost the session — re-evaluating
            // any earlier would still find a live pass. This also drops the
            // service's per-browser host dedupe, so going back to a blocked tab
            // that is still open meets the coach rather than an open page.
            IntentionAccessibilityService.instance?.recheckForeground()
        }
    }

    // The live pass, if there is one. Mirrors activeSession() in
    // shared/background.js: not banked (`endedAt`), and not yet expired. Reads
    // the same SharedPreferences JSON IntentionAccessibilityService reads for
    // its own expiry checks — a WebView round trip through background.js would
    // be asynchronous, and this runs on every foreground change.
    fun liveSession(context: Context): LiveSession? {
        val prefs = context.getSharedPreferences("intention_prefs", Context.MODE_PRIVATE)
        val activeSessionsStr = prefs.getString("activeSessions", "{}") ?: "{}"
        val now = System.currentTimeMillis()
        var newest: LiveSession? = null
        try {
            val json = JSONObject(activeSessionsStr)
            val keys = json.keys()
            while (keys.hasNext()) {
                val session = json.optJSONObject(keys.next()) ?: continue
                if (!session.isNull("endedAt")) continue
                val domain = session.optString("domain")
                if (domain.isEmpty() || domain == finishing) continue
                val live = LiveSession(
                    domain = domain,
                    reason = session.optString("reason"),
                    startTime = session.optLong("startTime", 0L),
                    intervalMinutes = session.optLong("intervalMinutes", 0L)
                )
                if (live.startTime <= 0L || now >= live.expiresAt) continue
                // Two live passes at once is possible (a site and an app), and
                // the most recently granted is the one they are looking at, so
                // that is the one that gets the timer.
                val best = newest
                if (best == null || live.startTime > best.startTime) newest = live
            }
        } catch (e: Exception) {
            Log.e(TAG, "Could not read activeSessions: ", e)
        }
        return newest
    }

    // ---- The floating window ----

    private fun showInternal(context: Context, session: LiveSession) {
        if (!Settings.canDrawOverlays(context)) {
            // No overlay permission. Nothing about blocking changes; the user
            // gets the pass in the shade instead of on top of the app.
            hideWindow(context)
            showNotification(context, session)
            showing = session
            scheduleTick()
            return
        }

        val current = showing
        if (view != null && current != null &&
            current.startTime == session.startTime && current.domain == session.domain
        ) {
            showing = session
            render(session)
            scheduleTick()
            return
        }

        // A different pass (or none at all) was on screen: start over.
        hideWindow(context)
        cancelNotification(context)

        val wm = context.getSystemService(Context.WINDOW_SERVICE) as WindowManager
        val badge = buildBadge(context, session)
        val params = WindowManager.LayoutParams(
            WindowManager.LayoutParams.WRAP_CONTENT,
            WindowManager.LayoutParams.WRAP_CONTENT,
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
            // NOT_FOCUSABLE keeps the keyboard and the back button with the app
            // underneath: this window must never take input away from what the
            // user is actually doing. It is deliberately not NOT_TOUCHABLE, so
            // the badge's own taps and drags still land while everything
            // outside it falls straight through.
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE,
            PixelFormat.TRANSLUCENT
        ).apply {
            gravity = Gravity.TOP or Gravity.END
            x = dp(context, 12f)
            // Overlay windows are placed against the raw display, so an
            // untouched y would tuck the badge under the status bar.
            y = statusBarHeight(context) + dp(context, 8f)
        }

        try {
            wm.addView(badge, params)
        } catch (e: Exception) {
            // Some OEM builds refuse the window even with the permission
            // granted, and revoking it mid-session throws here too. Fall back
            // rather than losing the timer altogether.
            Log.w(TAG, "Could not add the pass overlay; falling back to a notification", e)
            timeLabel = null
            showNotification(context, session)
            showing = session
            scheduleTick()
            return
        }

        windowManager = wm
        view = badge
        layoutParams = params
        showing = session
        render(session)
        scheduleTick()
    }

    private fun hideInternal(context: Context) {
        handler.removeCallbacks(tick)
        hideWindow(context)
        cancelNotification(context)
        showing = null
    }

    private fun hideWindow(context: Context) {
        val current = view ?: return
        try {
            val wm = windowManager
                ?: context.getSystemService(Context.WINDOW_SERVICE) as WindowManager
            wm.removeView(current)
        } catch (e: Exception) {
            // Already detached — the window goes when the permission is
            // revoked. Nothing to do but drop our references to it.
            Log.w(TAG, "Pass overlay was already detached", e)
        }
        view = null
        windowManager = null
        layoutParams = null
        timeLabel = null
    }

    private fun buildBadge(context: Context, session: LiveSession): View {
        val row = LinearLayout(context).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(context, 12f), dp(context, 4f), dp(context, 4f), dp(context, 4f))
            // Flat and bordered: a hairline does the separating, so the badge
            // keeps its edge over a white app and a black one alike. No
            // elevation — shadows are not part of the language.
            background = GradientDrawable().apply {
                shape = GradientDrawable.RECTANGLE
                setColor(Color.parseColor(COLOR_SURFACE))
                cornerRadius = dp(context, 6f).toFloat()
                setStroke(dp(context, 1f).coerceAtLeast(1), Color.parseColor(COLOR_BORDER))
            }
            elevation = 0f
        }

        // The loud part. Monospace so the digits don't jitter as they tick —
        // the job Geist Mono does for tickers on the web side, where we have a
        // font file to ship and here we do not.
        val time = TextView(context).apply {
            setTextColor(Color.parseColor(COLOR_TEXT))
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f)
            typeface = Typeface.create(Typeface.MONOSPACE, Typeface.BOLD)
            includeFontPadding = false
        }
        row.addView(time)

        // The quiet part: what they said they were here for, ellipsized rather
        // than allowed to stretch the badge across the screen.
        if (session.reason.isNotBlank()) {
            val purpose = TextView(context).apply {
                text = "· “${session.reason}”"
                setTextColor(Color.parseColor(COLOR_MUTED))
                setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f)
                maxLines = 1
                ellipsize = TextUtils.TruncateAt.END
                includeFontPadding = false
                maxWidth = dp(context, 140f)
                setPadding(dp(context, 6f), 0, 0, 0)
            }
            row.addView(purpose)
        }

        // Micro-label styling (10sp, bold, uppercase, wide tracking) sized to a
        // 44dp touch target. The target is grown on the control itself rather
        // than with a TouchDelegate: the drag handler below owns the parent's
        // touch stream, and a delegate there would never be consulted.
        val finish = TextView(context).apply {
            text = "FINISHED"
            setTextColor(Color.parseColor(COLOR_TEXT))
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 10f)
            typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
            letterSpacing = 0.15f
            gravity = Gravity.CENTER
            minHeight = dp(context, 44f)
            minWidth = dp(context, 44f)
            setPadding(dp(context, 12f), 0, dp(context, 12f), 0)
            background = GradientDrawable().apply {
                shape = GradientDrawable.RECTANGLE
                setColor(Color.parseColor(COLOR_SUBTLE))
                cornerRadius = dp(context, 6f).toFloat()
                setStroke(dp(context, 1f).coerceAtLeast(1), Color.parseColor(COLOR_BORDER))
            }
            isClickable = true
            setOnClickListener { finishSession(context, session.domain) }
        }
        row.addView(
            finish,
            LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT,
                LinearLayout.LayoutParams.WRAP_CONTENT
            ).apply { leftMargin = dp(context, 10f) }
        )

        attachDragHandler(context, row)
        timeLabel = time
        return row
    }

    // Let them move it out of the way — anything fixed will eventually sit on
    // top of the one control the app needs. Only touches that reach the parent
    // (i.e. the ones "Finished" did not already consume) count as a drag.
    private fun attachDragHandler(context: Context, row: View) {
        var startX = 0
        var startY = 0
        var touchX = 0f
        var touchY = 0f
        row.setOnTouchListener { _, event ->
            val params = layoutParams ?: return@setOnTouchListener false
            when (event.action) {
                MotionEvent.ACTION_DOWN -> {
                    startX = params.x
                    startY = params.y
                    touchX = event.rawX
                    touchY = event.rawY
                    true
                }
                MotionEvent.ACTION_MOVE -> {
                    val metrics = context.resources.displayMetrics
                    // Gravity is TOP|END, so x grows towards the left edge and
                    // a rightward drag has to decrease it.
                    params.x = (startX - (event.rawX - touchX).roundToInt())
                        .coerceIn(0, (metrics.widthPixels - row.width).coerceAtLeast(0))
                    params.y = (startY + (event.rawY - touchY).roundToInt())
                        .coerceIn(0, (metrics.heightPixels - row.height).coerceAtLeast(0))
                    try {
                        windowManager?.updateViewLayout(row, params)
                    } catch (e: Exception) {
                        Log.w(TAG, "Could not move the pass overlay", e)
                    }
                    true
                }
                else -> false
            }
        }
    }

    private fun onTick() {
        val session = showing ?: return
        if (System.currentTimeMillis() >= session.expiresAt) {
            // The pass is over. Tearing the timer down here — rather than
            // waiting to be told — is what keeps a stale clock off the screen
            // when the service's expiry re-check or the check-in alarm runs
            // late. Enforcement stays where it already lives: this removes a
            // window, it never decides anything.
            val context = view?.context ?: appContext
            if (context != null) hideInternal(context) else showing = null
            return
        }
        render(session)
        scheduleTick()
    }

    private fun scheduleTick() {
        handler.removeCallbacks(tick)
        handler.postDelayed(tick, TICK_MS)
    }

    private fun render(session: LiveSession) {
        timeLabel?.text = elapsedText(session, System.currentTimeMillis())
    }

    // Character for character the desktop badge's clock: elapsed, then the
    // granted length. Both stay minute:second even for a grant that runs past
    // an hour, which is what the extension does too.
    private fun elapsedText(session: LiveSession, now: Long): String {
        val totalSec = ((now - session.startTime) / 1000.0).roundToInt().coerceAtLeast(0)
        val elapsed = String.format("%02d:%02d", totalSec / 60, totalSec % 60)
        val boundary = if (session.intervalMinutes > 0) {
            String.format(" / %02d:00", session.intervalMinutes)
        } else {
            ""
        }
        return "⏱ $elapsed$boundary"
    }

    // ---- Notification fallback ----

    // Used when SYSTEM_ALERT_WINDOW was refused. The clock is the platform's own
    // chronometer counting up from the session's start, so it stays live
    // without this process re-posting a notification every second.
    private fun showNotification(context: Context, session: LiveSession) {
        val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        val channel = NotificationChannel(
            CHANNEL_ID,
            "Active pass",
            // LOW: a status line for something the user has just asked for, not
            // an interruption.
            NotificationManager.IMPORTANCE_LOW
        ).apply {
            description = "Shows the time on a pass the coach has granted."
            setShowBadge(false)
        }
        manager.createNotificationChannel(channel)

        val finishIntent = Intent(context, SessionFinishReceiver::class.java).apply {
            action = ACTION_FINISH
            // Same trick as AlarmHelper: the data Uri is what keeps each
            // domain's PendingIntent distinct instead of one overwriting the
            // next (Intent.filterEquals includes data, but not extras).
            data = Uri.parse("intention://session/" + Uri.encode(session.domain))
            putExtra(EXTRA_DOMAIN, session.domain)
        }
        val finishPending = PendingIntent.getBroadcast(
            context, 0, finishIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val granted = if (session.intervalMinutes > 0) " · ${session.intervalMinutes} min pass" else ""
        val notification = NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle("${session.domain}$granted")
            .setContentText(
                if (session.reason.isNotBlank()) "“${session.reason}”" else "Pass in progress"
            )
            .setWhen(session.startTime)
            .setShowWhen(true)
            .setUsesChronometer(true)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .addAction(0, "Finished", finishPending)
            .build()

        try {
            manager.notify(NOTIFICATION_ID, notification)
            notificationPosted = true
        } catch (e: Exception) {
            // Notifications can be refused too (POST_NOTIFICATIONS on API 33+).
            // That leaves the pass invisible, exactly as it was before any of
            // this existed — and blocking is untouched either way.
            Log.w(TAG, "Could not post the pass notification", e)
        }
    }

    private fun cancelNotification(context: Context) {
        if (!notificationPosted) return
        notificationPosted = false
        try {
            (context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager)
                .cancel(NOTIFICATION_ID)
        } catch (e: Exception) {
            Log.w(TAG, "Could not cancel the pass notification", e)
        }
    }

    // ---- Helpers ----

    private fun goHome(context: Context) {
        // Through the accessibility service where we have it: no activity
        // launch, and it works from the notification shade as readily as from
        // the badge. The Intent is the fallback for a process without the
        // service connected — it cannot happen today, but nothing here should
        // depend on that staying true.
        val service = IntentionAccessibilityService.instance
        if (service != null) {
            service.performGlobalAction(AccessibilityService.GLOBAL_ACTION_HOME)
            return
        }
        try {
            context.startActivity(
                Intent(Intent.ACTION_MAIN).apply {
                    addCategory(Intent.CATEGORY_HOME)
                    flags = Intent.FLAG_ACTIVITY_NEW_TASK
                }
            )
        } catch (e: Exception) {
            Log.w(TAG, "Could not return to the home screen", e)
        }
    }

    private fun onMain(block: () -> Unit) {
        if (Looper.myLooper() == Looper.getMainLooper()) block() else handler.post(block)
    }

    private fun dp(context: Context, value: Float): Int =
        (value * context.resources.displayMetrics.density).roundToInt()

    // No public API for this, and the badge has to clear the status bar on a
    // display it is drawn over rather than laid out inside. The framework
    // resource has been there since Android 1.x; the fallback covers a device
    // that has renamed it.
    private fun statusBarHeight(context: Context): Int {
        val id = context.resources.getIdentifier("status_bar_height", "dimen", "android")
        return if (id > 0) context.resources.getDimensionPixelSize(id) else dp(context, 24f)
    }
}
