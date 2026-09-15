// Suggestion catalogue: the sites and apps the setup wizard and the Blocking
// tab offer as one-tap suggestions, plus the brand marks they render with.
//
// Loaded by both the options page and the background worker — the worker needs
// COMMON_SITES to know which hosts count towards the suggestion tally (see
// recordCandidateVisit in tracking.js), and keeping one list means the two can
// never disagree about what a candidate is.

// Order is the fallback ranking: it decides which suggestions show above the
// "Show more" fold on a device with no visit tally yet (a fresh install, or
// Android, where blocking runs natively and nothing populates the tally).
// Where there is a tally, visited candidates are promoted above all of this.
//
// twitter.com is deliberately absent: it 301s to x.com before a page loads, so
// a second chip for it only made the grid look like two different services.
//
// medium.com, quora.com, imgur.com, 9gag.com, chess.com and dailymail.co.uk
// were dropped: they padded the grid without being what people arrive wanting
// to block, and anything still worth blocking can be typed in by hand. Leaving
// the catalogue also takes them out of the visit tally, which only exists to
// rank these suggestions.
const COMMON_SITES = [
  'x.com', 'youtube.com', 'reddit.com', 'instagram.com', 'tiktok.com',
  'facebook.com', 'threads.com', 'twitch.tv', 'netflix.com', 'linkedin.com',
  'news.ycombinator.com', 'substack.com', 'pinterest.com', 'discord.com',
  'tumblr.com'
];

// Display name + brand icon (Simple Icons, 24x24 path data) for the preset chips.
//
// `color: null` means "this mark is monochrome". X, TikTok and Threads are
// drawn in whatever the surface is not, and their published hex is a
// near-white picked for a dark background — invisible on chalk. The chip
// renderers paint a null-coloured mark in currentColor so it flips with the
// theme. It also means "Simple Icons has no mark for this", which renders a
// text-only chip; the two cases are distinguished by `icon`.
const SITE_META = {
  'x.com': { name: 'X', color: null, icon: 'M14.234 10.162 22.977 0h-2.072l-7.591 8.824L7.251 0H.258l9.168 13.343L.258 24H2.33l8.016-9.318L16.749 24h6.993zm-2.837 3.299-.929-1.329L3.076 1.56h3.182l5.965 8.532.929 1.329 7.754 11.09h-3.182z' },
  'youtube.com': { name: 'YouTube', color: '#ff0000', icon: 'M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z' },
  'reddit.com': { name: 'Reddit', color: '#ff4500', icon: 'M12 0C5.373 0 0 5.373 0 12c0 3.314 1.343 6.314 3.515 8.485l-2.286 2.286C.775 23.225 1.097 24 1.738 24H12c6.627 0 12-5.373 12-12S18.627 0 12 0Zm4.388 3.199c1.104 0 1.999.895 1.999 1.999 0 1.105-.895 2-1.999 2-.946 0-1.739-.657-1.947-1.539v.002c-1.147.162-2.032 1.15-2.032 2.341v.007c1.776.067 3.4.567 4.686 1.363.473-.363 1.064-.58 1.707-.58 1.547 0 2.802 1.254 2.802 2.802 0 1.117-.655 2.081-1.601 2.531-.088 3.256-3.637 5.876-7.997 5.876-4.361 0-7.905-2.617-7.998-5.87-.954-.447-1.614-1.415-1.614-2.538 0-1.548 1.255-2.802 2.803-2.802.645 0 1.239.218 1.712.585 1.275-.79 2.881-1.291 4.64-1.365v-.01c0-1.663 1.263-3.034 2.88-3.207.188-.911.993-1.595 1.959-1.595Zm-8.085 8.376c-.784 0-1.459.78-1.506 1.797-.047 1.016.64 1.429 1.426 1.429.786 0 1.371-.369 1.418-1.385.047-1.017-.553-1.841-1.338-1.841Zm7.406 0c-.786 0-1.385.824-1.338 1.841.047 1.017.634 1.385 1.418 1.385.785 0 1.473-.413 1.426-1.429-.046-1.017-.721-1.797-1.506-1.797Zm-3.703 4.013c-.974 0-1.907.048-2.77.135-.147.015-.241.168-.183.305.483 1.154 1.622 1.964 2.953 1.964 1.33 0 2.47-.81 2.953-1.964.057-.137-.037-.29-.184-.305-.863-.087-1.795-.135-2.769-.135Z' },
  'instagram.com': { name: 'Instagram', color: '#ff0069', icon: 'M7.0301.084c-1.2768.0602-2.1487.264-2.911.5634-.7888.3075-1.4575.72-2.1228 1.3877-.6652.6677-1.075 1.3368-1.3802 2.127-.2954.7638-.4956 1.6365-.552 2.914-.0564 1.2775-.0689 1.6882-.0626 4.947.0062 3.2586.0206 3.6671.0825 4.9473.061 1.2765.264 2.1482.5635 2.9107.308.7889.72 1.4573 1.388 2.1228.6679.6655 1.3365 1.0743 2.1285 1.38.7632.295 1.6361.4961 2.9134.552 1.2773.056 1.6884.069 4.9462.0627 3.2578-.0062 3.668-.0207 4.9478-.0814 1.28-.0607 2.147-.2652 2.9098-.5633.7889-.3086 1.4578-.72 2.1228-1.3881.665-.6682 1.0745-1.3378 1.3795-2.1284.2957-.7632.4966-1.636.552-2.9124.056-1.2809.0692-1.6898.063-4.948-.0063-3.2583-.021-3.6668-.0817-4.9465-.0607-1.2797-.264-2.1487-.5633-2.9117-.3084-.7889-.72-1.4568-1.3876-2.1228C21.2982 1.33 20.628.9208 19.8378.6165 19.074.321 18.2017.1197 16.9244.0645 15.6471.0093 15.236-.005 11.977.0014 8.718.0076 8.31.0215 7.0301.0839m.1402 21.6932c-1.17-.0509-1.8053-.2453-2.2287-.408-.5606-.216-.96-.4771-1.3819-.895-.422-.4178-.6811-.8186-.9-1.378-.1644-.4234-.3624-1.058-.4171-2.228-.0595-1.2645-.072-1.6442-.079-4.848-.007-3.2037.0053-3.583.0607-4.848.05-1.169.2456-1.805.408-2.2282.216-.5613.4762-.96.895-1.3816.4188-.4217.8184-.6814 1.3783-.9003.423-.1651 1.0575-.3614 2.227-.4171 1.2655-.06 1.6447-.072 4.848-.079 3.2033-.007 3.5835.005 4.8495.0608 1.169.0508 1.8053.2445 2.228.408.5608.216.96.4754 1.3816.895.4217.4194.6816.8176.9005 1.3787.1653.4217.3617 1.056.4169 2.2263.0602 1.2655.0739 1.645.0796 4.848.0058 3.203-.0055 3.5834-.061 4.848-.051 1.17-.245 1.8055-.408 2.2294-.216.5604-.4763.96-.8954 1.3814-.419.4215-.8181.6811-1.3783.9-.4224.1649-1.0577.3617-2.2262.4174-1.2656.0595-1.6448.072-4.8493.079-3.2045.007-3.5825-.006-4.848-.0608M16.953 5.5864A1.44 1.44 0 1 0 18.39 4.144a1.44 1.44 0 0 0-1.437 1.4424M5.8385 12.012c.0067 3.4032 2.7706 6.1557 6.173 6.1493 3.4026-.0065 6.157-2.7701 6.1506-6.1733-.0065-3.4032-2.771-6.1565-6.174-6.1498-3.403.0067-6.156 2.771-6.1496 6.1738M8 12.0077a4 4 0 1 1 4.008 3.9921A3.9996 3.9996 0 0 1 8 12.0077' },
  'tiktok.com': { name: 'TikTok', color: null, icon: 'M12.525.02c1.31-.02 2.61-.01 3.91-.02.08 1.53.63 3.09 1.75 4.17 1.12 1.11 2.7 1.62 4.24 1.79v4.03c-1.44-.05-2.89-.35-4.2-.97-.57-.26-1.1-.59-1.62-.93-.01 2.92.01 5.84-.02 8.75-.08 1.4-.54 2.79-1.35 3.94-1.31 1.92-3.58 3.17-5.91 3.21-1.43.08-2.86-.31-4.08-1.03-2.02-1.19-3.44-3.37-3.65-5.71-.02-.5-.03-1-.01-1.49.18-1.9 1.12-3.72 2.58-4.96 1.66-1.44 3.98-2.13 6.15-1.72.02 1.48-.04 2.96-.04 4.44-.99-.32-2.15-.23-3.02.37-.63.41-1.11 1.04-1.36 1.75-.21.51-.15 1.07-.14 1.61.24 1.64 1.82 3.02 3.5 2.87 1.12-.01 2.19-.66 2.77-1.61.19-.33.4-.67.41-1.06.1-1.79.06-3.57.07-5.36.01-4.03-.01-8.05.02-12.07z' },
  'facebook.com': { name: 'Facebook', color: '#0866ff', icon: 'M9.101 23.691v-7.98H6.627v-3.667h2.474v-1.58c0-4.085 1.848-5.978 5.858-5.978.401 0 .955.042 1.468.103a8.68 8.68 0 0 1 1.141.195v3.325a8.623 8.623 0 0 0-.653-.036 26.805 26.805 0 0 0-.733-.009c-.707 0-1.259.096-1.675.309a1.686 1.686 0 0 0-.679.622c-.258.42-.374.995-.374 1.752v1.297h3.919l-.386 2.103-.287 1.564h-3.246v8.245C19.396 23.238 24 18.179 24 12.044c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.628 3.874 10.35 9.101 11.647Z' },
  'twitch.tv': { name: 'Twitch', color: '#9146ff', icon: 'M11.571 4.714h1.715v5.143H11.57zm4.715 0H18v5.143h-1.714zM6 0L1.714 4.286v15.428h5.143V24l4.286-4.286h3.428L22.286 12V0zm14.571 11.143l-3.428 3.428h-3.429l-3 3v-3H6.857V1.714h13.714Z' },
  'netflix.com': { name: 'Netflix', color: '#e50914', icon: 'm5.398 0 8.348 23.602c2.346.059 4.856.398 4.856.398L10.113 0H5.398zm8.489 0v9.172l4.715 13.33V0h-4.715zM5.398 1.5V24c1.873-.225 2.81-.312 4.715-.398V14.83L5.398 1.5z' },
  'linkedin.com': { name: 'LinkedIn', color: '#0a66c2', icon: 'M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433c-1.144 0-2.063-.926-2.063-2.065 0-1.138.92-2.063 2.063-2.063 1.14 0 2.064.925 2.064 2.063 0 1.139-.925 2.065-2.064 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z' },
  'substack.com': { name: 'Substack', color: '#ff6719', icon: 'M22.539 8.242H1.46V5.406h21.08v2.836zM1.46 10.812V24L12 18.11 22.54 24V10.812H1.46zM22.54 0H1.46v2.836h21.08V0z' },
  'threads.com': { name: 'Threads', color: null, icon: 'M18.263 11.097c-.03-3.486-1.92-5.586-5.111-5.586-2.13 0-3.922.963-4.863 2.499l2.062 1.438c.535-.843 1.272-1.543 2.628-1.543 1.528 0 2.318.85 2.544 2.431a15 15 0 0 0-2.236-.173c-4.125 0-6.068 1.867-6.068 4.336s1.943 3.99 4.804 3.99c3.139 0 5.013-2.115 5.781-4.735.798.361 1.348 1.204 1.348 2.47 0 3.387-3.907 5.232-7.22 5.232-4.885 0-8.077-3.207-8.077-8.424 0-6.392 4.223-10.487 9.9-10.487 3.808 0 5.69 1.671 6.97 3.914l2.108-1.475C21.44 2.078 18.331 0 13.663 0 6.227 0 1.168 5.277 1.168 12.934c0 7 4.953 11.066 10.856 11.066 4.878 0 9.809-2.846 9.809-7.716 0-2.545-1.46-4.231-3.569-5.187m-6.33 4.855c-1.077 0-2.026-.512-2.026-1.453 0-1.483 1.822-1.934 3.606-1.934.678 0 1.34.045 1.927.173-.422 1.927-1.671 3.215-3.508 3.214Z' },
  'news.ycombinator.com': { name: 'Hacker News', color: '#f0652f', icon: 'M0 24V0h24v24H0zM6.951 5.896l4.112 7.708v5.064h1.583v-4.972l4.148-7.799h-1.749l-2.457 4.875c-.372.745-.688 1.434-.688 1.434s-.297-.708-.651-1.434L8.831 5.896h-1.88z' },
  'pinterest.com': { name: 'Pinterest', color: '#e60023', icon: 'M12.017 0C5.396 0 .029 5.367.029 11.987c0 5.079 3.158 9.417 7.618 11.162-.105-.949-.199-2.403.041-3.439.219-.937 1.406-5.957 1.406-5.957s-.359-.72-.359-1.781c0-1.663.967-2.911 2.168-2.911 1.024 0 1.518.769 1.518 1.688 0 1.029-.653 2.567-.992 3.992-.285 1.193.6 2.165 1.775 2.165 2.128 0 3.768-2.245 3.768-5.487 0-2.861-2.063-4.869-5.008-4.869-3.41 0-5.409 2.562-5.409 5.199 0 1.033.394 2.143.889 2.741.099.12.112.225.085.345-.09.375-.293 1.199-.334 1.363-.053.225-.172.271-.401.165-1.495-.69-2.433-2.878-2.433-4.646 0-3.776 2.748-7.252 7.92-7.252 4.158 0 7.392 2.967 7.392 6.923 0 4.135-2.607 7.462-6.233 7.462-1.214 0-2.354-.629-2.758-1.379l-.749 2.848c-.269 1.045-1.004 2.352-1.498 3.146 1.123.345 2.306.535 3.55.535 6.607 0 11.985-5.365 11.985-11.987C23.97 5.39 18.592.026 11.985.026L12.017 0z' },
  'discord.com': { name: 'Discord', color: '#5865f2', icon: 'M20.317 4.3698a19.7913 19.7913 0 00-4.8851-1.5152.0741.0741 0 00-.0785.0371c-.211.3753-.4447.8648-.6083 1.2495-1.8447-.2762-3.68-.2762-5.4868 0-.1636-.3933-.4058-.8742-.6177-1.2495a.077.077 0 00-.0785-.037 19.7363 19.7363 0 00-4.8852 1.515.0699.0699 0 00-.0321.0277C.5334 9.0458-.319 13.5799.0992 18.0578a.0824.0824 0 00.0312.0561c2.0528 1.5076 4.0413 2.4228 5.9929 3.0294a.0777.0777 0 00.0842-.0276c.4616-.6304.8731-1.2952 1.226-1.9942a.076.076 0 00-.0416-.1057c-.6528-.2476-1.2743-.5495-1.8722-.8923a.077.077 0 01-.0076-.1277c.1258-.0943.2517-.1923.3718-.2914a.0743.0743 0 01.0776-.0105c3.9278 1.7933 8.18 1.7933 12.0614 0a.0739.0739 0 01.0785.0095c.1202.099.246.1981.3728.2924a.077.077 0 01-.0066.1276 12.2986 12.2986 0 01-1.873.8914.0766.0766 0 00-.0407.1067c.3604.698.7719 1.3628 1.225 1.9932a.076.076 0 00.0842.0286c1.961-.6067 3.9495-1.5219 6.0023-3.0294a.077.077 0 00.0313-.0552c.5004-5.177-.8382-9.6739-3.5485-13.6604a.061.061 0 00-.0312-.0286zM8.02 15.3312c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9555-2.4189 2.157-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.9555 2.4189-2.1569 2.4189zm7.9748 0c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9554-2.4189 2.1569-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.946 2.4189-2.1568 2.4189Z' },
  'tumblr.com': { name: 'Tumblr', color: '#8ba3c7', icon: 'M14.563 24c-5.093 0-7.031-3.756-7.031-6.411V9.747H5.116V6.648c3.63-1.313 4.512-4.596 4.71-6.469C9.84.051 9.941 0 9.999 0h3.517v6.114h4.801v3.633h-4.82v7.47c.016 1.001.375 2.371 2.207 2.371h.09c.631-.02 1.486-.205 1.936-.419l1.156 3.425c-.436.636-2.4 1.374-4.156 1.404h-.178l.011.002z' },
  // Simple Icons carries no mark for these, and an app chip needs a display
  // name whether or not one exists — buildRecommendCard falls back to a
  // text-only chip when `icon` is null.
  'primevideo.com': { name: 'Prime Video', color: null, icon: null },
  'disneyplus.com': { name: 'Disney+', color: null, icon: null },
};

// App blocking is only available where the native bridge injects
// window.intentionApps (the Android app). Preset chips mirror COMMON_SITES.
const COMMON_APPS = [
  { packageName: 'com.instagram.android', label: 'Instagram' },
  { packageName: 'com.zhiliaoapp.musically', label: 'TikTok' },
  { packageName: 'com.google.android.youtube', label: 'YouTube' },
  { packageName: 'com.twitter.android', label: 'X' },
  { packageName: 'com.reddit.frontpage', label: 'Reddit' },
  { packageName: 'com.facebook.katana', label: 'Facebook' },
  { packageName: 'com.snapchat.android', label: 'Snapchat' },
  { packageName: 'tv.twitch.android.app', label: 'Twitch' },
  { packageName: 'com.netflix.mediaclient', label: 'Netflix' },
  { packageName: 'com.linkedin.android', label: 'LinkedIn' },
  { packageName: 'com.instagram.barcelona', label: 'Threads' },
  { packageName: 'com.pinterest', label: 'Pinterest' },
  { packageName: 'com.discord', label: 'Discord' },
  { packageName: 'com.amazon.avod.thirdpartyclient', label: 'Prime Video' },
  { packageName: 'com.disney.disneyplus', label: 'Disney+' },
];

// Utility/messaging apps to never suggest as recommendations, even if added
// to COMMON_APPS later.
const RECOMMEND_IGNORE_APPS = ['com.whatsapp', 'com.whatsapp.w4b'];
const RECOMMEND_IGNORE_SITES = [];

// The pairing between an Android package and the website that is the same
// service. It started life as icon reuse and is now also the answer to "are
// these the same thing?" — serviceKeyFor() below resolves through it, so a
// package added here immediately shares its site's setup answers.
//
// Only the answers are shared. Minutes, grants, quick-check lanes and chat
// transcripts stay per-target, because getLimitsForDomain() relies on
// domainLimits and appLimits being a disjoint namespace.
const APP_ICON_SITE = {
  'com.instagram.android': 'instagram.com',
  'com.zhiliaoapp.musically': 'tiktok.com',
  'com.google.android.youtube': 'youtube.com',
  'com.twitter.android': 'x.com',
  'com.reddit.frontpage': 'reddit.com',
  'com.facebook.katana': 'facebook.com',
  'tv.twitch.android.app': 'twitch.tv',
  'com.netflix.mediaclient': 'netflix.com',
  'com.linkedin.android': 'linkedin.com',
  'com.instagram.barcelona': 'threads.com',
  'com.pinterest': 'pinterest.com',
  'com.discord': 'discord.com',
  // Name-only SITE_META entries: these two have no site suggestion, and exist
  // purely so the app chip has a label of its own.
  'com.amazon.avod.thirdpartyclient': 'primevideo.com',
  'com.disney.disneyplus': 'disneyplus.com',
};

// The identity a site or app is grouped under. A hostname is its own service;
// a package resolves to its website where we know of one, and otherwise stands
// alone under its own id. Both gate paths can call this with whatever they
// have — background.js's `domain` is a hostname on the web and a package name
// in an app, and one lookup covers both.
function serviceKeyFor(target) {
  const key = String(target == null ? '' : target);
  return APP_ICON_SITE[key] || key;
}

// A human name for a service key. SITE_META covers the catalogue; a hand-typed
// domain is its own best label; an app outside the catalogue falls back to the
// label the native bridge reported for it.
function serviceLabelFor(key, members, appLabels) {
  const meta = SITE_META[key];
  if (meta && meta.name) return meta.name;
  for (const pkg of (members || [])) {
    const label = (appLabels || {})[pkg];
    if (label) return label;
  }
  return key;
}

// Collapse a blocklist into one entry per service, preserving the order things
// were picked in. `appsFirst` follows the wizard: where a native bridge exists
// the apps step comes before the sites step, so the groups should read in that
// order too.
//
// Returns [{ key, label, domains: [...], apps: [...] }].
function buildServiceGroups({ domains = [], apps = [], appLabels = {}, appsFirst = false } = {}) {
  const groups = new Map();
  const push = (target, bucket) => {
    const key = serviceKeyFor(target);
    if (!groups.has(key)) groups.set(key, { key, domains: [], apps: [] });
    const group = groups.get(key);
    if (!group[bucket].includes(target)) group[bucket].push(target);
  };
  const addApps = () => { for (const p of apps) push(p, 'apps'); };
  const addDomains = () => { for (const d of domains) push(d, 'domains'); };
  if (appsFirst) { addApps(); addDomains(); } else { addDomains(); addApps(); }

  return [...groups.values()].map(group => ({
    ...group,
    label: serviceLabelFor(group.key, group.apps, appLabels)
  }));
}

// "instagram.com and the Instagram app" — the line that explains to the user
// why two things they picked separately are asking them one set of questions.
function serviceMembersLabel(group, appLabels) {
  const parts = [...(group.domains || [])];
  for (const pkg of (group.apps || [])) {
    const label = (appLabels || {})[pkg] || (SITE_META[serviceKeyFor(pkg)] || {}).name;
    parts.push(label ? `the ${label} app` : pkg);
  }
  if (parts.length <= 1) return parts[0] || '';
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

// ---------------------------------------------------------------------------
// The answer catalogue — what the wizard asks about each service, as taps.
// ---------------------------------------------------------------------------
//
// Setup used to ask two open textareas per blocked service. They are the most
// valuable thing the coach is ever given — a rule the user wrote while calm,
// which renderSiteReasonBlock hands it at every gate — and they were also the
// most skipped, because typing two paragraphs about six services on a phone is
// an interrogation. Taps are the fix: a chip is a structured answer, it costs
// one thumb, and it can be turned into better prose than most people type.
//
// Three strings per chip, and the third is what makes the consequence preview
// possible at all:
//
//   label  the button text. Kept to 34 characters or fewer — past that a chip
//          wraps to two lines at 320px, which is what a phone actually is.
//   coach  a FIRST-PERSON fragment, no leading capital (except the pronoun
//          "I") and no trailing punctuation, because composeServiceReason
//          joins several of them with "; " and capitalises only the first.
//   you    a SECOND-PERSON noun phrase, used only by the wizard's preview line
//          ("Your coach will hear you out for a DM reply"). It exists because
//          the same idea has to be said back to the user in their own person,
//          and deriving one from the other reads like a machine talking.
//
// Nothing here reaches storage as an id. collectServiceReasons() composes the
// chips into the same { purpose, legitimateUse } prose the two textareas
// produced, so sanitizeServiceReasons, renderSiteReasonBlock, the settings row
// and every native reader are untouched by this. The ids live only in the
// wizard's own draft.

// Needs chips shared by several services. A service may override any of them
// with its own wording — Instagram says "Replying to DMs", not "Replying to a
// message" — by spelling the chip out in its own list under the same id.
const SERVICE_NEED = {
  dm: { id: 'dm', label: 'Replying to a message', coach: 'replying to a specific message', you: 'a message reply' },
  sent: { id: 'sent', label: 'Something someone sent me', coach: 'opening a link someone actually sent me', you: 'a link someone sent you' },
  post: { id: 'post', label: 'Posting something of my own', coach: 'posting something of my own', you: 'posting your own' },
  lookup: { id: 'lookup', label: 'Looking one person or thing up', coach: 'looking up one specific person or account', you: 'one lookup' },
  work: { id: 'work', label: "It's part of my job", coach: "work I'm actually paid to do there", you: 'work you are paid for' }
};

// The last chip on every needs list, appended by serviceAnswerCatalogue rather
// than written into any of them — one "nothing" option, always, in the same
// place. It is exclusive in both directions (see toggleServiceChip): it is the
// strongest thing the wizard can be told, and it means nothing if it can sit
// alongside four reasons the site is fine.
const NEED_NONE_ID = 'none';
const SERVICE_NEED_NONE = { id: NEED_NONE_ID, label: 'Nothing, I just want it gone', coach: '', you: '' };
// Composed instead of joined, because there are no fragments to join.
const NEED_NONE_PROSE = "Nothing. I don't actually need it.";

// Cost chips — "and why is it on the list?". One default set and two
// overrides, because "it eats hours" is the wrong complaint about Netflix and
// the wrong complaint about LinkedIn for opposite reasons.
const SERVICE_COST = {
  hours: { id: 'hours', label: 'It eats hours', coach: 'it eats hours I meant to spend elsewhere' },
  auto: { id: 'auto', label: 'I open it without deciding to', coach: 'I open it without ever deciding to' },
  worse: { id: 'worse', label: 'It leaves me feeling worse', coach: 'it leaves me feeling worse than before I opened it' },
  derail: { id: 'derail', label: 'It derails my work', coach: 'it pulls me off work I care about' },
  night: { id: 'night', label: 'It keeps me up', coach: "I'm still on it last thing at night" },
  onemore: { id: 'onemore', label: 'One becomes four', coach: 'one becomes four before I notice' },
  anxious: { id: 'anxious', label: 'It makes me anxious', coach: 'it makes me anxious about where I am in my career' }
};

const SERVICE_COSTS_DEFAULT = [SERVICE_COST.hours, SERVICE_COST.auto, SERVICE_COST.worse, SERVICE_COST.derail, SERVICE_COST.night];
// Episodes and autoplay, not an infinite feed: "one becomes four" is the
// complaint people actually have about a video service.
const SERVICE_COSTS_VIDEO = [SERVICE_COST.onemore, SERVICE_COST.auto, SERVICE_COST.derail, SERVICE_COST.night];

// Netflix, Prime Video and Disney+ are the same product with different
// libraries, so they ask the same thing rather than three near-copies.
const SERVICE_ANSWERS_WATCHLIST = {
  feed: 'browsing for something to watch',
  costs: SERVICE_COSTS_VIDEO,
  needs: [
    { id: 'planned', label: 'One thing I already chose', coach: 'one thing I had already chosen to watch', you: 'something you already chose' },
    { id: 'together', label: 'Watching with someone else', coach: 'watching with someone else', you: 'watching with someone' }
  ]
};

// Keyed by the same service key SITE_META uses, so serviceKeyFor() already
// resolves an Android package onto the right entry and one card asks for a
// site and its app at once.
//
// `feed` is the noun phrase the preview line pushes back on — the thing the
// user is NOT here for. It is per-service because "the feed" is meaningless
// for YouTube and wrong for Netflix.
//
// `costs` omitted means SERVICE_COSTS_DEFAULT. Every COMMON_SITES entry and
// every APP_ICON_SITE value must appear here; tests/service-answers.test.js
// fails if one is added to either list and forgotten here.
const SERVICE_ANSWERS = {
  'instagram.com': {
    feed: 'the feed, Reels and Explore',
    needs: [
      { id: 'dm', label: 'Replying to DMs', coach: 'replying to a specific DM', you: 'a DM reply' },
      SERVICE_NEED.sent,
      SERVICE_NEED.post,
      SERVICE_NEED.lookup
    ]
  },
  'x.com': {
    feed: 'the timeline',
    needs: [
      SERVICE_NEED.dm,
      { id: 'sent', label: 'A post someone sent me', coach: 'a post someone actually sent me', you: 'a post someone sent you' },
      SERVICE_NEED.post,
      { id: 'live', label: 'Following one live event', coach: 'following one live event as it happens', you: 'one live event' }
    ]
  },
  'youtube.com': {
    feed: 'the homepage and Shorts',
    costs: SERVICE_COSTS_VIDEO,
    needs: [
      { id: 'chosen', label: 'One video I already picked', coach: "one video I'd already decided to watch", you: 'a video you already picked' },
      { id: 'howto', label: 'Learning or fixing something', coach: 'a tutorial for something specific I am learning or fixing', you: 'a tutorial' },
      { id: 'music', label: 'Music while I work', coach: 'music in the background while I work', you: 'background music' },
      { id: 'own', label: 'My own channel', coach: 'my own channel and uploads', you: 'your own channel' }
    ]
  },
  'tiktok.com': {
    feed: 'the For You feed',
    needs: [
      { id: 'sent', label: 'A video someone sent me', coach: 'a video someone actually sent me', you: 'a video someone sent you' },
      { id: 'creator', label: 'One creator I follow', coach: 'one creator I actually follow', you: 'one creator' },
      SERVICE_NEED.post
    ]
  },
  'reddit.com': {
    feed: 'the front page',
    needs: [
      { id: 'thread', label: 'One thread someone sent me', coach: 'one thread someone actually sent me', you: 'one thread' },
      { id: 'research', label: "A question I'm researching", coach: 'a specific question I am researching', you: 'one question' },
      { id: 'community', label: 'A community I post in', coach: 'a community I actually take part in', you: 'a community you post in' }
    ]
  },
  'facebook.com': {
    feed: 'the feed',
    needs: [
      SERVICE_NEED.dm,
      { id: 'event', label: "An event or group I'm in", coach: 'an event or a group I actually take part in', you: 'an event or group' },
      { id: 'market', label: 'Marketplace: something specific', coach: 'looking on Marketplace for something specific I am buying or selling', you: 'one Marketplace listing' },
      SERVICE_NEED.lookup
    ]
  },
  'threads.com': {
    feed: 'the feed',
    needs: [
      { id: 'reply', label: 'Replying to someone', coach: 'replying to someone directly', you: 'a reply' },
      SERVICE_NEED.sent,
      SERVICE_NEED.post
    ]
  },
  'twitch.tv': {
    feed: 'browsing the directory',
    costs: SERVICE_COSTS_VIDEO,
    needs: [
      { id: 'planned', label: 'One stream I planned to watch', coach: 'one stream I had planned to watch', you: 'a stream you planned' },
      { id: 'live', label: 'Someone I follow going live', coach: 'someone I follow going live', you: 'someone you follow going live' }
    ]
  },
  'netflix.com': SERVICE_ANSWERS_WATCHLIST,
  'primevideo.com': SERVICE_ANSWERS_WATCHLIST,
  'disneyplus.com': SERVICE_ANSWERS_WATCHLIST,
  'linkedin.com': {
    feed: 'the feed',
    // Not hours — the complaint about LinkedIn is what it does to you while
    // you are on it, and naming that is what makes the answer worth reading.
    costs: [SERVICE_COST.anxious, SERVICE_COST.hours, SERVICE_COST.auto, SERVICE_COST.derail],
    needs: [
      SERVICE_NEED.dm,
      { id: 'apply', label: "A job I'm actually applying for", coach: 'a job I am actually applying for', you: 'one job application' },
      SERVICE_NEED.post,
      SERVICE_NEED.lookup
    ]
  },
  'news.ycombinator.com': {
    feed: 'the front page',
    needs: [
      { id: 'thread', label: 'One thread someone sent me', coach: 'one thread someone actually sent me', you: 'one thread' },
      { id: 'research', label: "A question I'm researching", coach: 'a specific question I am researching', you: 'one question' }
    ]
  },
  'substack.com': {
    feed: 'browsing recommendations',
    needs: [
      { id: 'issue', label: 'One post I subscribed to', coach: 'one post from something I actually subscribe to', you: 'a post you subscribe to' },
      { id: 'own', label: 'Writing my own', coach: 'writing or checking my own newsletter', you: 'your own writing' }
    ]
  },
  'pinterest.com': {
    feed: 'the home feed',
    needs: [
      { id: 'making', label: "Something I'm actually making", coach: 'a board for something I am actually making', you: 'something you are making' },
      { id: 'idea', label: 'One specific idea', coach: 'looking up one specific idea', you: 'one idea' }
    ]
  },
  'discord.com': {
    feed: 'scrolling channels',
    needs: [
      SERVICE_NEED.dm,
      { id: 'server', label: 'One server I work in', coach: 'one server I actually work in', you: 'one server' },
      { id: 'call', label: "A call I'm meant to be on", coach: 'a call I am meant to be on', you: 'a call' }
    ]
  },
  'tumblr.com': {
    feed: 'the dashboard',
    needs: [
      SERVICE_NEED.dm,
      { id: 'own', label: 'My own blog', coach: 'posting or checking my own blog', you: 'your own blog' }
    ]
  }
};

// A hand-typed domain, or an Android package outside APP_ICON_SITE. The four
// chips are deliberately generic: "a message reply", "something someone sent
// me", "one specific thing I need" and "it's part of my job" apply to very
// nearly anything a person blocks, which is the only honest thing to offer
// when we know nothing else about it.
const SERVICE_ANSWERS_FALLBACK = {
  feed: "browsing once you're in",
  needs: [
    SERVICE_NEED.dm,
    SERVICE_NEED.sent,
    { id: 'specific', label: 'One specific thing I need', coach: 'one specific thing I already know I need', you: 'one specific thing' },
    SERVICE_NEED.work
  ]
};

// What the wizard renders for one service: the feed it pushes back on, the
// needs list with the "nothing" chip appended, and the cost list.
//
// The "nothing" chip is appended here rather than written into any list so it
// can never be missing, never be duplicated, and never be anywhere but last.
function serviceAnswerCatalogue(key) {
  const entry = SERVICE_ANSWERS[serviceKeyFor(key)] || SERVICE_ANSWERS_FALLBACK;
  return {
    feed: entry.feed,
    needs: [...entry.needs, SERVICE_NEED_NONE],
    costs: entry.costs || SERVICE_COSTS_DEFAULT
  };
}

// One chip by id, or null. `bucket` is 'needs' or 'costs'. Returning null
// rather than throwing matters: a draft written before a chip was renamed
// resolves to nothing and is simply dropped from the composed prose.
function serviceAnswerChip(key, bucket, chipId) {
  const catalogue = serviceAnswerCatalogue(key);
  const list = bucket === 'costs' ? catalogue.costs : catalogue.needs;
  return list.find(chip => chip.id === chipId) || null;
}

// Fragments -> one sentence. Several taps read as a list, so they are joined
// with semicolons inside one sentence rather than as four sentences of four
// words each, which is what the coach would otherwise be handed.
function composeAnswerSentence(fragments) {
  const joined = (fragments || [])
    .map(f => String(f == null ? '' : f).trim())
    .filter(Boolean)
    .join('; ');
  if (!joined) return '';
  const capped = joined.charAt(0).toUpperCase() + joined.slice(1);
  return /[.!?]$/.test(capped) ? capped : `${capped}.`;
}

// Chip ids -> the { purpose, legitimateUse } pair that has always been stored.
//
// This lives here rather than in options-wizard.js because it is pure and the
// catalogue it reads is here; the wizard only ever holds ids. `answers` is
// { needs, costs, needsNote, costsNote } straight off setupDraft.serviceAnswers.
function composeServiceReason(key, answers) {
  const a = answers || {};
  const needs = Array.isArray(a.needs) ? a.needs : [];
  const costs = Array.isArray(a.costs) ? a.costs : [];
  const fragments = (bucket, ids) => ids
    .map(id => serviceAnswerChip(key, bucket, id))
    .filter(chip => chip && chip.coach)
    .map(chip => chip.coach);

  // "Nothing — I just want it gone" is not the absence of an answer, it is the
  // strongest answer available, so it composes to a sentence of its own rather
  // than to an empty string that collectServiceReasons would then drop.
  const legitimateUse = needs.includes(NEED_NONE_ID)
    ? NEED_NONE_PROSE
    : [composeAnswerSentence(fragments('needs', needs)), composeAnswerSentence([a.needsNote])]
      .filter(Boolean).join(' ');

  const purpose = [composeAnswerSentence(fragments('costs', costs)), composeAnswerSentence([a.costsNote])]
    .filter(Boolean).join(' ');

  return { purpose, legitimateUse };
}
