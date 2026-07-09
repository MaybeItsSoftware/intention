package com.maybeitsadam.intention

import android.content.Context
import android.util.Log

object AlarmHelper {
    private const val TAG = "AlarmHelper"

    fun createAlarm(context: Context, name: String, infoJson: String) {
        Log.d(TAG, "Creating alarm: $name with info: $infoJson")
        // In a production Android app, we would register this with Android's AlarmManager
        // or WorkManager to trigger a background check-in notification when the session is over.
        // For local simulation, we write it to logs and store it.
    }

    fun clearAlarm(context: Context, name: String) {
        Log.d(TAG, "Clearing alarm: $name")
    }
}
