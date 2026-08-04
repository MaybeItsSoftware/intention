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

function cleanSlug(slug) {
  if (!slug) return '';
  return slug
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\w/, c => c.toUpperCase());
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
  // 6. Generic
  else {
    threadTitle = ogTitle || rawTitle;
  }

  return {
    url,
    title: rawTitle,
    contentType,
    videoTitle: videoTitle || undefined,
    channel: channel || undefined,
    duration: duration || undefined,
    threadTitle: threadTitle || undefined,
    subreddit: subreddit || undefined,
    author: author || undefined,
    snippet: snippet || ogDesc || undefined
  };
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
  // Generic URL slug
  else {
    const segments = path.split('/').filter(Boolean);
    const lastSeg = segments[segments.length - 1];
    if (lastSeg && lastSeg.includes('-')) {
      threadTitle = cleanSlug(lastSeg);
    }
  }

  return {
    url: urlStr,
    title: threadTitle || videoTitle || urlStr,
    contentType,
    videoTitle: videoTitle || undefined,
    channel: channel || undefined,
    threadTitle: threadTitle || undefined,
    subreddit: subreddit || undefined,
    author: author || undefined
  };
}

async function enrichPageContext(pageCtx) {
  if (!pageCtx || typeof pageCtx !== 'object' || !pageCtx.url) return pageCtx;
  const enriched = { ...pageCtx };

  try {
    // 1. YouTube oEmbed
    if ((enriched.url.includes('youtube.com/watch') || enriched.url.includes('youtu.be/') || enriched.url.includes('youtube.com/shorts/'))
        && (!enriched.videoTitle || enriched.videoTitle.startsWith('YouTube Video ('))) {
      const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(enriched.url)}&format=json`;
      const res = await fetch(oembedUrl);
      if (res.ok) {
        const data = await res.json();
        if (data.title) enriched.videoTitle = data.title;
        if (data.author_name) enriched.channel = data.author_name;
      }
    }
    // 2. Reddit post JSON
    else if (enriched.url.includes('reddit.com/r/') && enriched.url.includes('/comments/')) {
      const cleanUrl = enriched.url.split('?')[0].replace(/\/+$/, '');
      const res = await fetch(`${cleanUrl}.json`);
      if (res.ok) {
        const data = await res.json();
        const post = data?.[0]?.data?.children?.[0]?.data;
        if (post) {
          if (post.title) enriched.threadTitle = post.title;
          if (post.subreddit_name_prefixed) enriched.subreddit = post.subreddit_name_prefixed;
          if (post.author) enriched.author = `u/${post.author}`;
        }
      }
    }
  } catch (e) {
    // Network or parse error: return best-effort pageCtx
  }

  return enriched;
}
