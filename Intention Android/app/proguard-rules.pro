# Keep WebView JS-bridge methods; they're only called via reflection from JS.
-keepclassmembers class uk.co.maybeitssoftware.intention.WebAppInterface {
    @android.webkit.JavascriptInterface <methods>;
}
