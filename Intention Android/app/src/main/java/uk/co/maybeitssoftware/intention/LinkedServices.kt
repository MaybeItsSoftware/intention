package uk.co.maybeitssoftware.intention

/**
 * Which blocked site and which blocked app are the same service, so a pass
 * granted for one covers the other.
 *
 * Following an Instagram link on a phone goes through both: the browser (or a
 * Custom Tab inside the app the link was tapped in) loads instagram.com, and a
 * moment later Android hands the link to the Instagram app. Keyed per target,
 * that was two gates for one decision — and the pass the user had just been
 * given for the site did nothing for the app it was handed to, nor the app's
 * pass for a link that opened in the browser. The intention is the service's,
 * not the surface's.
 *
 * Mirrors APP_ICON_SITE in shared/sites.js, which is the same pairing the
 * settings use to share setup answers; tests/linked-services.test.js fails if
 * the two drift. Only passes are shared here — minutes and grants are still
 * recorded against whichever target the pass was granted for.
 */
object LinkedServices {
    private val APP_SITE: Map<String, String> = mapOf(
        "com.instagram.android" to "instagram.com",
        "com.zhiliaoapp.musically" to "tiktok.com",
        "com.google.android.youtube" to "youtube.com",
        "com.twitter.android" to "x.com",
        "com.reddit.frontpage" to "reddit.com",
        "com.facebook.katana" to "facebook.com",
        "tv.twitch.android.app" to "twitch.tv",
        "com.netflix.mediaclient" to "netflix.com",
        "com.linkedin.android" to "linkedin.com",
        "com.instagram.barcelona" to "threads.com",
        "com.pinterest" to "pinterest.com",
        "com.discord" to "discord.com",
        "com.amazon.avod.thirdpartyclient" to "primevideo.com",
        "com.disney.disneyplus" to "disneyplus.com"
    )

    /** The site a package resolves to, or the target itself. Same rule as serviceKeyFor in sites.js. */
    fun serviceKey(target: String): String = APP_SITE[target] ?: target.removePrefix("www.")

    fun sameService(a: String?, b: String?): Boolean {
        if (a.isNullOrEmpty() || b.isNullOrEmpty()) return false
        return a == b || serviceKey(a) == serviceKey(b)
    }

    /** The app that is the same service as this blocked site, if there is one. */
    fun appForSite(site: String): String? {
        val key = serviceKey(site)
        return APP_SITE.entries.firstOrNull { it.value == key }?.key
    }
}
