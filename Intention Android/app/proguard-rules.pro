# Keep WebView JS-bridge methods; they're only called via reflection from JS.
# Covers WebAppInterface and the anonymous JS-interface object in
# BackgroundJsHelper (the background WebView's "AndroidInterface").
-keepclassmembers class uk.co.maybeitssoftware.intention.** {
    @android.webkit.JavascriptInterface <methods>;
}
