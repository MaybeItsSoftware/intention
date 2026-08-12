/**
 * Page Context Extractor & Enricher for Intention
 * Extracts site-specific metadata (video title, duration, channel, Reddit thread, etc.)
 * from DOM or URLs to provide deep context for the AI coach.
 */

function parseISODuration(isoStr) {
  if (!isoStr || typeof isoStr !== 'string') return '';
  const match = isoStr.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/i);
  if (!match) return isoStr;
  const hours = parseInt(match[1] || '0', 10);
  const minutes = parseInt(match[2] || '0', 10);
  const seconds = parseInt(match[3] || '0', 10);
  const parts = [];
  if (hours > 0) parts.push(`${hours} ${hours === 1 ? 'hour' : 'hours'}`);
  if (minutes > 0) parts.push(`${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`);
  if (seconds > 0 && hours === 0) parts.push(`${seconds} ${seconds === 1 ? 'second' : 'seconds'}`);
  return parts.join(', ') || isoStr;
}

// Everything in this file comes from the page being gated, or from a
// third-party API about it, and all of it ends up inside the coach's SYSTEM
// prompt. The page is by definition the thing the gate exists to resist, so
// treat every field as hostile: no newlines (they let content forge extra
// prompt lines), no control or bidi/zero-width characters (they hide text from
// a reader while the model still sees it), and a hard length cap so a page
// cannot bury the real instructions under 50KB of its own.
//
// prompts.js re-applies this at the render boundary — see renderPageContextBlock.
// Doing it here as well keeps the messages small on the wire.
const PAGE_CTX_LIMITS = {
  url: 500,
  contentType: 40,
  videoTitle: 200,
  threadTitle: 200,
  title: 200,
  channel: 80,
  author: 80,
  subreddit: 80,
  duration: 40,
  snippet: 400,
  searchQuery: 200
};

function clampField(value, max) {
  if (typeof value !== 'string') return '';
  const flattened = value
    // C0/C1 controls, line/paragraph separators, zero-width and bidi overrides.
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (flattened.length <= max) return flattened;
  return flattened.slice(0, max).trim() + '…';
}

// Applies the caps above to a whole context object, dropping anything empty.
function clampPageContext(pageCtx) {
  if (!pageCtx || typeof pageCtx !== 'object') return pageCtx;
  const out = {};
  for (const [key, value] of Object.entries(pageCtx)) {
    const max = PAGE_CTX_LIMITS[key];
    const clamped = max ? clampField(value, max) : value;
    if (clamped !== '' && clamped != null) out[key] = clamped;
  }
  // A url that isn't http(s) has no business being quoted back to the user.
  if (out.url && !/^https?:\/\//i.test(out.url)) delete out.url;
  return out;
}

function cleanSlug(slug) {
  if (!slug) return '';
  return slug
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\w/, c => c.toUpperCase());
}

// A search box is the least ambiguous statement of intent a URL can carry —
// "what am I actually here for" is literally spelled out in the query string.
// Worth more to the coach than any title we could scrape, and free to read.
const SEARCH_PARAM_KEYS = ['search_query', 'q', 'query', 'search_term', 'search', 'keyword'];

// A query turns "YouTube Page" into "YouTube Page (search)" — but not when the
// content type already says as much, which would read as "Search (search)".
function markSearch(contentType, searchQuery) {
  if (!searchQuery) return contentType;
  if (/search|hashtag/i.test(contentType)) return contentType;
  return `${contentType} (search)`;
}

function readSearchQuery(parsed) {
  if (!parsed || !parsed.searchParams) return '';
  for (const key of SEARCH_PARAM_KEYS) {
    const value = parsed.searchParams.get(key);
    if (value && value.trim()) return value.trim();
  }
  // Instagram and TikTok hashtag/explore pages put the term in the path.
  const tagMatch = parsed.pathname.match(/\/(?:explore\/tags|tag|hashtag)\/([^/]+)/i);
  if (tagMatch) {
    try { return `#${decodeURIComponent(tagMatch[1])}`; } catch (e) { return `#${tagMatch[1]}`; }
  }
  return '';
}

// Instagram and TikTok are the two sites most likely to be on a blocklist and
// the two the DOM extractor can say least about (both render their whole feed
// from script, and both are gated before that script ever runs). Everything
// worth knowing about the *intent* is in the path, so read it from there.
// One-segment paths that are Instagram's own routes, not someone's handle —
// without this, /reel/ or /accounts becomes the profile "@reel".
const INSTAGRAM_NON_PROFILE = new Set([
  'reel', 'reels', 'p', 'explore', 'direct', 'stories', 'accounts', 'about', 'legal'
]);

function classifyInstagram(path) {
  const out = {};
  let m;
  if ((m = path.match(/\/reels?\/([^/]+)/i))) {
    out.contentType = 'Instagram Reel';
  } else if ((m = path.match(/\/p\/([^/]+)/i))) {
    out.contentType = 'Instagram Post';
  } else if ((m = path.match(/\/stories\/([^/]+)/i))) {
    out.contentType = 'Instagram Story';
    out.author = `@${m[1]}`;
  } else if (/\/explore\/tags\//i.test(path)) {
    out.contentType = 'Instagram Hashtag Feed';
  } else if (/^\/explore\/?/i.test(path)) {
    out.contentType = 'Instagram Explore Feed';
  } else if (/^\/direct\//i.test(path)) {
    out.contentType = 'Instagram DMs';
  } else if ((m = path.match(/^\/([A-Za-z0-9._]+)\/?$/)) && !INSTAGRAM_NON_PROFILE.has(m[1].toLowerCase())) {
    out.contentType = 'Instagram Profile';
    out.author = `@${m[1]}`;
  } else {
    out.contentType = 'Instagram Home Feed';
  }
  return out;
}

function classifyTikTok(path) {
  const out = {};
  let m;
  if ((m = path.match(/\/@([A-Za-z0-9._]+)\/video\/(\d+)/i))) {
    out.contentType = 'TikTok Video';
    out.author = `@${m[1]}`;
  } else if ((m = path.match(/^\/@([A-Za-z0-9._]+)\/?$/i))) {
    out.contentType = 'TikTok Profile';
    out.author = `@${m[1]}`;
  } else if (/^\/t\//i.test(path)) {
    out.contentType = 'TikTok Video';
  } else if (/^\/tag\//i.test(path)) {
    out.contentType = 'TikTok Hashtag Feed';
  } else if (/^\/search/i.test(path)) {
    out.contentType = 'TikTok Search';
  } else {
    out.contentType = 'TikTok For You Feed';
  }
  return out;
}

function extractPageContextFromDOM(doc, win) {
  const documentObj = doc || (typeof document !== 'undefined' ? document : null);
  const windowObj = win || (typeof window !== 'undefined' ? window : null);
  if (!documentObj || !windowObj) return null;

  const url = windowObj.location?.href || '';
  const host = windowObj.location?.hostname || '';
  const rawTitle = documentObj.title || '';

  const ogTitle = documentObj.querySelector('meta[property="og:title"]')?.getAttribute('content')
    || documentObj.querySelector('meta[name="twitter:title"]')?.getAttribute('content') || '';
  const ogDesc = documentObj.querySelector('meta[property="og:description"]')?.getAttribute('content')
    || documentObj.querySelector('meta[name="description"]')?.getAttribute('content') || '';

  let contentType = 'Web Page';
  let videoTitle = '';
  let channel = '';
  let duration = '';
  let threadTitle = '';
  let subreddit = '';
  let author = '';
  let snippet = ogDesc;

  // 1. YouTube
  if (host.includes('youtube.com') || host.includes('youtu.be')) {
    if (url.includes('/shorts/')) contentType = 'YouTube Short';
    else if (url.includes('/watch')) contentType = 'YouTube Video';
    else if (url.includes('/@') || url.includes('/channel/') || url.includes('/user/') || url.includes('/c/')) contentType = 'YouTube Channel';
    else contentType = 'YouTube Page';

    videoTitle = documentObj.querySelector('meta[name="title"]')?.getAttribute('content')
      || documentObj.querySelector('h1.ytd-watch-metadata')?.textContent?.trim()
      || ogTitle
      || rawTitle.replace(/\s*-\s*YouTube$/i, '').trim();

    channel = documentObj.querySelector('ytd-channel-name a')?.textContent?.trim()
      || documentObj.querySelector('meta[name="attribution"]')?.getAttribute('content')
      || documentObj.querySelector('link[itemprop="name"]')?.getAttribute('content')
      || documentObj.querySelector('a[href^="/@"]')?.textContent?.trim()
      || '';

    const rawDuration = documentObj.querySelector('meta[itemprop="duration"]')?.getAttribute('content')
      || documentObj.querySelector('.ytp-time-duration')?.textContent?.trim()
      || '';
    duration = parseISODuration(rawDuration);
  }
  // 2. Reddit
  else if (host.includes('reddit.com')) {
    if (url.includes('/comments/')) contentType = 'Reddit Post';
    else if (url.includes('/r/')) contentType = 'Subreddit Feed';
    else contentType = 'Reddit Page';

    threadTitle = documentObj.querySelector('h1')?.textContent?.trim()
      || ogTitle
      || rawTitle.replace(/\s*:\s*\w+$/i, '').trim();

    const subMatch = url.match(/\/r\/([a-zA-Z0-9_]+)/i);
    if (subMatch) subreddit = `r/${subMatch[1]}`;
    else {
      const subEl = documentObj.querySelector('a[href*="/r/"]');
      if (subEl) subreddit = subEl.textContent?.trim() || '';
    }

    const userMatch = url.match(/\/user\/([a-zA-Z0-9_-]+)/i);
    if (userMatch) author = `u/${userMatch[1]}`;
  }
  // 3. Twitter / X
  else if (host.includes('twitter.com') || host.includes('x.com')) {
    if (url.includes('/status/')) contentType = 'Tweet / X Post';
    else contentType = 'Twitter / X Profile';

    const handleMatch = url.match(/\/(?:x|twitter)\.com\/([a-zA-Z0-9_]+)(?:\/status|\/?$)/i);
    if (handleMatch) author = `@${handleMatch[1]}`;
    else {
      const titleHandle = rawTitle.match(/@([a-zA-Z0-9_]+)/);
      if (titleHandle) author = `@${titleHandle[1]}`;
    }

    snippet = documentObj.querySelector('article div[data-testid="tweetText"]')?.textContent?.trim() || ogDesc;
  }
  // 4. GitHub
  else if (host.includes('github.com')) {
    if (url.includes('/issues/')) contentType = 'GitHub Issue';
    else if (url.includes('/pull/')) contentType = 'GitHub Pull Request';
    else contentType = 'GitHub Repository';

    threadTitle = documentObj.querySelector('.js-issue-title')?.textContent?.trim()
      || documentObj.querySelector('h1')?.textContent?.trim()
      || rawTitle;
  }
  // 5. Twitch
  else if (host.includes('twitch.tv')) {
    contentType = 'Twitch Stream';
    const chMatch = url.match(/twitch\.tv\/([a-zA-Z0-9_]+)/i);
    if (chMatch) channel = chMatch[1];
    threadTitle = documentObj.querySelector('[data-a-target="stream-title"]')?.textContent?.trim() || rawTitle;
  }
  // 6. Instagram
  else if (host.includes('instagram.com')) {
    const classified = classifyInstagram(windowObj.location?.pathname || '');
    contentType = classified.contentType;
    author = classified.author || '';
    threadTitle = ogTitle || '';
  }
  // 7. TikTok
  else if (host.includes('tiktok.com')) {
    const classified = classifyTikTok(windowObj.location?.pathname || '');
    contentType = classified.contentType;
    author = classified.author || '';
    videoTitle = ogTitle || '';
  }
  // 8. Generic
  else {
    threadTitle = ogTitle || rawTitle;
  }

  let searchQuery = '';
  try { searchQuery = readSearchQuery(new URL(url)); } catch (e) {}
  contentType = markSearch(contentType, searchQuery);

  return clampPageContext({
    url,
    title: rawTitle,
    contentType,
    searchQuery: searchQuery || undefined,
    source: 'dom',
    videoTitle: videoTitle || undefined,
    channel: channel || undefined,
    duration: duration || undefined,
    threadTitle: threadTitle || undefined,
    subreddit: subreddit || undefined,
    author: author || undefined,
    snippet: snippet || ogDesc || undefined
  });
}

function extractPageContextFromUrl(urlStr) {
  if (!urlStr || typeof urlStr !== 'string') return null;
  let parsed;
  try {
    parsed = new URL(urlStr);
  } catch (e) {
    return null;
  }

  const host = parsed.hostname.toLowerCase();
  const path = parsed.pathname;

  let contentType = 'Web Page';
  let videoTitle = '';
  let channel = '';
  let threadTitle = '';
  let subreddit = '';
  let author = '';

  // YouTube
  if (host.includes('youtube.com') || host.includes('youtu.be')) {
    const vParam = parsed.searchParams.get('v');
    const shortsMatch = path.match(/\/shorts\/([a-zA-Z0-9_-]+)/i);
    const channelMatch = path.match(/\/@([a-zA-Z0-9_.-]+)/i) || path.match(/\/(?:c|user|channel)\/([a-zA-Z0-9_.-]+)/i);

    if (vParam || shortsMatch) {
      contentType = shortsMatch ? 'YouTube Short' : 'YouTube Video';
      const videoId = vParam || shortsMatch[1];
      videoTitle = `YouTube Video (${videoId})`;
    } else if (channelMatch) {
      contentType = 'YouTube Channel';
      channel = `@${channelMatch[1]}`;
    } else {
      contentType = 'YouTube Page';
    }
  }
  // Reddit
  else if (host.includes('reddit.com')) {
    const subMatch = path.match(/\/r\/([a-zA-Z0-9_]+)/i);
    if (subMatch) subreddit = `r/${subMatch[1]}`;

    const userMatch = path.match(/\/user\/([a-zA-Z0-9_-]+)/i);
    if (userMatch) author = `u/${userMatch[1]}`;

    const postMatch = path.match(/\/comments\/([a-zA-Z0-9]+)(?:\/([^\/]+))?/i);
    if (postMatch) {
      contentType = 'Reddit Post';
      if (postMatch[2]) {
        threadTitle = cleanSlug(postMatch[2]);
      }
    } else if (subreddit) {
      contentType = 'Subreddit Feed';
    } else {
      contentType = 'Reddit Page';
    }
  }
  // Twitter / X
  else if (host.includes('twitter.com') || host.includes('x.com')) {
    const statusMatch = path.match(/\/([a-zA-Z0-9_]+)\/status\/(\d+)/i);
    const profileMatch = path.match(/\/([a-zA-Z0-9_]+)\/?$/i);

    if (statusMatch) {
      contentType = 'Tweet / X Post';
      author = `@${statusMatch[1]}`;
    } else if (profileMatch && !['home', 'explore', 'notifications', 'messages'].includes(profileMatch[1].toLowerCase())) {
      contentType = 'Twitter / X Profile';
      author = `@${profileMatch[1]}`;
    }
  }
  // GitHub
  else if (host.includes('github.com')) {
    const parts = path.split('/').filter(Boolean);
    if (parts.length >= 2) {
      const repo = `${parts[0]}/${parts[1]}`;
      if (parts[2] === 'issues' && parts[3]) {
        contentType = 'GitHub Issue';
        threadTitle = `${repo} Issue #${parts[3]}`;
      } else if (parts[2] === 'pull' && parts[3]) {
        contentType = 'GitHub Pull Request';
        threadTitle = `${repo} PR #${parts[3]}`;
      } else {
        contentType = 'GitHub Repository';
        threadTitle = repo;
      }
    }
  }
  // Instagram
  else if (host.includes('instagram.com')) {
    const classified = classifyInstagram(path);
    contentType = classified.contentType;
    if (classified.author) author = classified.author;
  }
  // TikTok
  else if (host.includes('tiktok.com')) {
    const classified = classifyTikTok(path);
    contentType = classified.contentType;
    if (classified.author) author = classified.author;
  }
  // Generic URL slug
  else {
    const segments = path.split('/').filter(Boolean);
    const lastSeg = segments[segments.length - 1];
    if (lastSeg && lastSeg.includes('-')) {
      threadTitle = cleanSlug(lastSeg);
    }
  }

  const searchQuery = readSearchQuery(parsed);
  contentType = markSearch(contentType, searchQuery);

  return clampPageContext({
    url: urlStr,
    title: threadTitle || videoTitle || urlStr,
    contentType,
    searchQuery: searchQuery || undefined,
    // A URL tells us where they are headed, not what is there. The prompt
    // leans on this to decide whether it may claim to know the content.
    source: 'url',
    videoTitle: videoTitle || undefined,
    channel: channel || undefined,
    threadTitle: threadTitle || undefined,
    subreddit: subreddit || undefined,
    author: author || undefined
  });
}

// Enrichment is one network round trip to a third party, on the critical path
// of a reply the user is watching a spinner for. Two bounds keep it there:
//
//   * a timeout, because a hung host must not hold the coach hostage until the
//     UI's own 35s cutoff fires and the user is told the worker is offline
//   * a memo, because handleChat re-derives page context on EVERY turn of the
//     conversation — without it a ten-message chat is ten identical fetches of
//     the same video's title. Failures are cached too (as an empty result), so
//     an unreachable host costs one timeout per URL, not one per message.
const ENRICH_TIMEOUT_MS = 2500;
const ENRICH_CACHE_TTL_MS = 10 * 60 * 1000;
const ENRICH_CACHE_MAX = 50;
const enrichCache = new Map();

// An in-memory Map alone doesn't survive the MV3 service worker, which is
// suspended after about 30 seconds idle — less than the time a user takes to
// read a coaching message and type an answer. So the memo would miss on nearly
// every turn, which is exactly the case it exists for.
//
// chrome.storage.session only (never .local): these are titles of pages the
// user was blocked from, and they have no business being written to disk.
// Where session storage doesn't exist — Safari before 16.4, content scripts —
// this stays memory-only, which is merely the old behaviour.
const enrichStore = (typeof chrome !== 'undefined' && chrome.storage?.session) || null;
let enrichHydrated = false;

function liveCacheEntries() {
  const cutoff = Date.now() - ENRICH_CACHE_TTL_MS;
  const out = {};
  for (const [key, entry] of enrichCache) {
    if (entry && entry.at > cutoff) out[key] = entry;
  }
  return out;
}

// Pulls the persisted memo back into the Map after a worker restart. Runs at
// most once per worker lifetime; a failure just leaves the cache cold.
async function hydrateEnrichCache() {
  if (enrichHydrated || !enrichStore) return;
  enrichHydrated = true;
  const stored = await new Promise((resolve) => {
    try {
      enrichStore.get(['enrichCache'], (result) => {
        void chrome.runtime?.lastError;
        resolve(result?.enrichCache || {});
      });
    } catch (e) {
      resolve({});
    }
  });
  const cutoff = Date.now() - ENRICH_CACHE_TTL_MS;
  for (const [key, entry] of Object.entries(stored)) {
    if (entry && entry.at > cutoff && !enrichCache.has(key)) enrichCache.set(key, entry);
  }
}

function persistEnrichCache() {
  if (!enrichStore) return;
  try {
    enrichStore.set({ enrichCache: liveCacheEntries() }, () => {
      void chrome.runtime?.lastError; // best-effort
    });
  } catch (e) {}
}

function readEnrichCache(key) {
  const hit = enrichCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > ENRICH_CACHE_TTL_MS) {
    enrichCache.delete(key);
    return null;
  }
  return hit.fields;
}

function writeEnrichCache(key, fields) {
  enrichCache.set(key, { at: Date.now(), fields });
  // Insertion-ordered, so the oldest key is the first one out.
  while (enrichCache.size > ENRICH_CACHE_MAX) {
    const oldest = enrichCache.keys().next().value;
    enrichCache.delete(oldest);
  }
  persistEnrichCache();
}

// Most of a blocked visit never loads the page: the redirect rule replaces the
// navigation, so no content script runs and no DOM is ever read. Outside the
// handful of sites with a metadata API below, that left the coach holding a
// bare URL — it could see you were opening an article, never which one.
//
// Reading the page's own <head> from here closes that gap for every site at
// once. Deliberately narrow: no cookies (so this is the logged-out page, never
// a personalised one), a byte cap so a huge document can't be pulled down to
// find a title in its first kilobyte, and the same timeout as everything else.
const HTML_BYTE_CAP = 64 * 1024;

function decodeEntities(text) {
  return text
    .replace(/&(#\d+|#x[0-9a-f]+|amp|quot|apos|lt|gt|nbsp);/gi, (match, code) => {
      const lower = code.toLowerCase();
      if (lower === 'amp') return '&';
      if (lower === 'quot') return '"';
      if (lower === 'apos') return "'";
      if (lower === 'lt') return '<';
      if (lower === 'gt') return '>';
      if (lower === 'nbsp') return ' ';
      const codePoint = lower[0] === '#'
        ? parseInt(lower[1] === 'x' ? lower.slice(2) : lower.slice(1), lower[1] === 'x' ? 16 : 10)
        : NaN;
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match;
    });
}

// Both attribute orders appear in the wild: content-then-property as well as
// property-then-content.
function readMetaContent(html, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const after = new RegExp(`<meta[^>]+(?:property|name)=["']${escaped}["'][^>]*content=["']([^"']*)["']`, 'i');
  const before = new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${escaped}["']`, 'i');
  const match = after.exec(html) || before.exec(html);
  return match ? decodeEntities(match[1]) : '';
}

function parseHtmlMetadata(html) {
  const fields = {};
  const title = readMetaContent(html, 'og:title') || readMetaContent(html, 'twitter:title');
  const description = readMetaContent(html, 'og:description') || readMetaContent(html, 'description');
  const docTitle = /<title[^>]*>([\s\S]{0,300}?)<\/title>/i.exec(html);
  const resolved = title || (docTitle ? decodeEntities(docTitle[1]) : '');
  if (resolved) fields.threadTitle = resolved;
  if (description) fields.snippet = description;
  return fields;
}

async function fetchHtmlHead(url) {
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), ENRICH_TIMEOUT_MS) : null;
  try {
    const res = await fetch(url, {
      signal: controller ? controller.signal : undefined,
      credentials: 'omit',
      redirect: 'follow'
    });
    if (!res.ok) return '';
    const contentType = (res.headers && typeof res.headers.get === 'function' && res.headers.get('content-type')) || '';
    if (contentType && !/text\/html|application\/xhtml/i.test(contentType)) return '';

    // Stop reading as soon as there is enough to find a <head> in. Falls back
    // to the whole body where streams aren't available (and in tests).
    if (res.body && typeof res.body.getReader === 'function' && typeof TextDecoder === 'function') {
      const reader = res.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let html = '';
      while (html.length < HTML_BYTE_CAP) {
        const { done, value } = await reader.read();
        if (done) break;
        html += decoder.decode(value, { stream: true });
      }
      try { await reader.cancel(); } catch (e) {}
      return html.slice(0, HTML_BYTE_CAP);
    }
    const text = await res.text();
    return typeof text === 'string' ? text.slice(0, HTML_BYTE_CAP) : '';
  } catch (e) {
    return '';
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function fetchJsonBounded(url) {
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), ENRICH_TIMEOUT_MS) : null;
  try {
    const res = await fetch(url, controller ? { signal: controller.signal } : undefined);
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    return null; // aborted, offline, or not JSON
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// "YouTube Video (dQw4w9WgXcQ)" is this file's way of saying it knows there is
// a video and nothing about it — prompts.js refuses to render it for the same
// reason. Kept in one place so both agree on what counts as knowing nothing.
const PLACEHOLDER_VIDEO_TITLE = /^(?:YouTube Video|YouTube Short) \(/;

// Whether we can already say what is ON the page, rather than merely where it
// is. Mirrors the judgement renderPageContextBlock makes before it lets the
// coach describe the content.
function hasContentDetail(pageCtx) {
  const realVideoTitle = pageCtx.videoTitle && !PLACEHOLDER_VIDEO_TITLE.test(pageCtx.videoTitle);
  const realTitle = pageCtx.title && !/^https?:\/\//i.test(pageCtx.title);
  return Boolean(realVideoTitle || pageCtx.threadTitle || pageCtx.snippet || pageCtx.searchQuery || realTitle);
}

async function enrichPageContext(pageCtx) {
  if (!pageCtx || typeof pageCtx !== 'object' || !pageCtx.url) return pageCtx;
  await hydrateEnrichCache();
  const enriched = { ...pageCtx };
  const url = enriched.url;

  // A placeholder title ("YouTube Video (dQw4w9WgXcQ)") is the URL extractor
  // saying it has nothing — treat it as absent so enrichment still runs.
  const hasRealVideoTitle = enriched.videoTitle && !PLACEHOLDER_VIDEO_TITLE.test(enriched.videoTitle);

  let target = null;
  if ((url.includes('youtube.com/watch') || url.includes('youtu.be/') || url.includes('youtube.com/shorts/')) && !hasRealVideoTitle) {
    target = {
      key: `yt:${url}`,
      fetchUrl: `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`,
      map: (data) => {
        const fields = {};
        if (data?.title) fields.videoTitle = data.title;
        if (data?.author_name) fields.channel = data.author_name;
        return fields;
      }
    };
  } else if (url.includes('tiktok.com/') && /\/video\/\d+|\/t\//.test(url)) {
    target = {
      key: `tt:${url}`,
      fetchUrl: `https://www.tiktok.com/oembed?url=${encodeURIComponent(url)}`,
      map: (data) => {
        const fields = {};
        if (data?.title) fields.videoTitle = data.title;
        if (data?.author_name) fields.channel = data.author_name;
        return fields;
      }
    };
  } else if (url.includes('reddit.com/r/') && url.includes('/comments/')) {
    const cleanUrl = url.split('?')[0].replace(/\/+$/, '');
    target = {
      key: `rd:${cleanUrl}`,
      fetchUrl: `${cleanUrl}.json`,
      map: (data) => {
        const post = data?.[0]?.data?.children?.[0]?.data;
        const fields = {};
        if (post?.title) fields.threadTitle = post.title;
        if (post?.subreddit_name_prefixed) fields.subreddit = post.subreddit_name_prefixed;
        if (post?.author) fields.author = `u/${post.author}`;
        return fields;
      }
    };
  }

  // No site-specific API for this one. If we still can't say what the page is,
  // ask the page itself — this is the only thing standing between the coach
  // and a bare URL on every site outside the list above.
  if (!target && /^https?:\/\//i.test(url) && !hasContentDetail(enriched)) {
    target = {
      key: `html:${url}`,
      fetchUrl: url,
      html: true,
      map: (html) => parseHtmlMetadata(html)
    };
  }

  if (!target) return clampPageContext(enriched);

  let fields = readEnrichCache(target.key);
  if (!fields) {
    const data = target.html
      ? await fetchHtmlHead(target.fetchUrl)
      : await fetchJsonBounded(target.fetchUrl);
    fields = data ? target.map(data) : {};
    writeEnrichCache(target.key, fields);
  }

  if (Object.keys(fields).length) {
    Object.assign(enriched, fields);
    // Tells the prompt it may speak about the content itself, not just the
    // address — see renderPageContextBlock.
    enriched.enriched = true;
  }

  // Titles and author names here came from YouTube, TikTok and Reddit, not
  // from the extractors above, so they have not been through clampField yet.
  return clampPageContext(enriched);
}
