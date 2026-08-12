import { describe, it, expect } from 'vitest';
import { loadSource, makeMockFetch, makeStorageArea } from './load.js';

describe('page_context.js', () => {
  const ctx = loadSource('page_context.js');

  describe('parseISODuration', () => {
    it('parses minutes and seconds', () => {
      expect(ctx.parseISODuration('PT3M33S')).toBe('3 minutes, 33 seconds');
    });

    it('parses hours and minutes', () => {
      expect(ctx.parseISODuration('PT1H45M')).toBe('1 hour, 45 minutes');
    });

    it('parses hours, minutes, and seconds', () => {
      expect(ctx.parseISODuration('PT2H10M5S')).toBe('2 hours, 10 minutes');
    });

    it('parses seconds only', () => {
      expect(ctx.parseISODuration('PT45S')).toBe('45 seconds');
    });

    it('handles non-ISO strings gracefully', () => {
      expect(ctx.parseISODuration('10:30')).toBe('10:30');
    });
  });

  describe('extractPageContextFromUrl', () => {
    it('extracts YouTube video context', () => {
      const res = ctx.extractPageContextFromUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
      expect(res.contentType).toBe('YouTube Video');
      expect(res.videoTitle).toContain('dQw4w9WgXcQ');
    });

    it('extracts YouTube Short context', () => {
      const res = ctx.extractPageContextFromUrl('https://www.youtube.com/shorts/abc123xyz');
      expect(res.contentType).toBe('YouTube Short');
      expect(res.videoTitle).toContain('abc123xyz');
    });

    it('extracts YouTube Channel context', () => {
      const res = ctx.extractPageContextFromUrl('https://www.youtube.com/@mkbhd');
      expect(res.contentType).toBe('YouTube Channel');
      expect(res.channel).toBe('@mkbhd');
    });

    it('extracts Reddit post context from URL slug', () => {
      const res = ctx.extractPageContextFromUrl('https://www.reddit.com/r/reactjs/comments/18x9abc/why_use_effect_is_misunderstood/');
      expect(res.contentType).toBe('Reddit Post');
      expect(res.subreddit).toBe('r/reactjs');
      expect(res.threadTitle).toBe('Why use effect is misunderstood');
    });

    it('extracts Twitter/X post context', () => {
      const res = ctx.extractPageContextFromUrl('https://x.com/elonmusk/status/123456789');
      expect(res.contentType).toBe('Tweet / X Post');
      expect(res.author).toBe('@elonmusk');
    });

    it('extracts GitHub issue context', () => {
      const res = ctx.extractPageContextFromUrl('https://github.com/facebook/react/issues/12345');
      expect(res.contentType).toBe('GitHub Issue');
      expect(res.threadTitle).toBe('facebook/react Issue #12345');
    });

    it('marks URL-derived context as such, so the prompt knows not to claim it saw the page', () => {
      const res = ctx.extractPageContextFromUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
      expect(res.source).toBe('url');
    });

    it('captures a search query — the plainest statement of intent a URL carries', () => {
      const res = ctx.extractPageContextFromUrl('https://www.youtube.com/results?search_query=react+useeffect+cleanup');
      expect(res.searchQuery).toBe('react useeffect cleanup');
      expect(res.contentType).toContain('search');
    });

    it('captures a Reddit search query', () => {
      const res = ctx.extractPageContextFromUrl('https://www.reddit.com/search?q=mechanical+keyboards');
      expect(res.searchQuery).toBe('mechanical keyboards');
    });

    it('reads a hashtag feed as its tag', () => {
      const res = ctx.extractPageContextFromUrl('https://www.instagram.com/explore/tags/woodworking/');
      expect(res.contentType).toBe('Instagram Hashtag Feed');
      expect(res.searchQuery).toBe('#woodworking');
    });

    it('distinguishes Instagram reels, posts and profiles', () => {
      expect(ctx.extractPageContextFromUrl('https://www.instagram.com/reel/Cabc123/').contentType).toBe('Instagram Reel');
      expect(ctx.extractPageContextFromUrl('https://www.instagram.com/p/Cabc123/').contentType).toBe('Instagram Post');
      const profile = ctx.extractPageContextFromUrl('https://www.instagram.com/nasa/');
      expect(profile.contentType).toBe('Instagram Profile');
      expect(profile.author).toBe('@nasa');
    });

    it('names the Instagram home feed rather than guessing at content', () => {
      expect(ctx.extractPageContextFromUrl('https://www.instagram.com/').contentType).toBe('Instagram Home Feed');
    });

    it('distinguishes TikTok videos, profiles and the For You feed', () => {
      const video = ctx.extractPageContextFromUrl('https://www.tiktok.com/@someone/video/7300000000000000000');
      expect(video.contentType).toBe('TikTok Video');
      expect(video.author).toBe('@someone');
      expect(ctx.extractPageContextFromUrl('https://www.tiktok.com/@someone').contentType).toBe('TikTok Profile');
      expect(ctx.extractPageContextFromUrl('https://www.tiktok.com/foryou').contentType).toBe('TikTok For You Feed');
    });
  });

  describe('enrichPageContext', () => {
    it('enriches YouTube video info via oEmbed fetch', async () => {
      const mockFetch = makeMockFetch((url) => {
        if (url.includes('youtube.com/oembed')) {
          return {
            json: {
              title: 'Never Gonna Give You Up',
              author_name: 'Rick Astley'
            }
          };
        }
        return {};
      });

      const baseCtx = loadSource('page_context.js', { fetch: mockFetch });
      const input = {
        url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
        videoTitle: 'YouTube Video (dQw4w9WgXcQ)'
      };

      const enriched = await baseCtx.enrichPageContext(input);
      expect(enriched.videoTitle).toBe('Never Gonna Give You Up');
      expect(enriched.channel).toBe('Rick Astley');
    });

    it('enriches Reddit post info via JSON API fetch', async () => {
      const mockFetch = makeMockFetch((url) => {
        if (url.includes('reddit.com') && url.includes('.json')) {
          return {
            json: [
              {
                data: {
                  children: [
                    {
                      data: {
                        title: 'How to build high performance AI features',
                        subreddit_name_prefixed: 'r/webdev',
                        author: 'coder123'
                      }
                    }
                  ]
                }
              }
            ]
          };
        }
        return {};
      });

      const baseCtx = loadSource('page_context.js', { fetch: mockFetch });
      const input = {
        url: 'https://www.reddit.com/r/webdev/comments/12345/',
        threadTitle: 'Short'
      };

      const enriched = await baseCtx.enrichPageContext(input);
      expect(enriched.threadTitle).toBe('How to build high performance AI features');
      expect(enriched.subreddit).toBe('r/webdev');
      expect(enriched.author).toBe('u/coder123');
    });

    it('enriches a TikTok video via oEmbed', async () => {
      const mockFetch = makeMockFetch((url) => (
        url.includes('tiktok.com/oembed')
          ? { json: { title: 'Sourdough in 60 seconds', author_name: 'bakerman' } }
          : {}
      ));
      const baseCtx = loadSource('page_context.js', { fetch: mockFetch });
      const enriched = await baseCtx.enrichPageContext({
        url: 'https://www.tiktok.com/@bakerman/video/7300000000000000000'
      });
      expect(enriched.videoTitle).toBe('Sourdough in 60 seconds');
      expect(enriched.channel).toBe('bakerman');
    });

    // handleChat re-derives page context on every turn of the conversation, so
    // without a memo a ten-message chat is ten identical fetches.
    it('fetches once per URL and serves the rest from cache', async () => {
      const mockFetch = makeMockFetch({ json: { title: 'A video', author_name: 'Someone' } });
      const baseCtx = loadSource('page_context.js', { fetch: mockFetch });
      const input = { url: 'https://www.youtube.com/watch?v=abc123' };

      const first = await baseCtx.enrichPageContext({ ...input });
      const second = await baseCtx.enrichPageContext({ ...input });

      expect(mockFetch.calls.length).toBe(1);
      expect(second.videoTitle).toBe(first.videoTitle);
    });

    // A failing host must cost one attempt per URL, not one per message.
    it('caches a failed lookup instead of retrying it every turn', async () => {
      const mockFetch = makeMockFetch(() => { throw new Error('offline'); });
      const baseCtx = loadSource('page_context.js', { fetch: mockFetch });
      const input = { url: 'https://www.youtube.com/watch?v=zzz999' };

      const enriched = await baseCtx.enrichPageContext({ ...input });
      await baseCtx.enrichPageContext({ ...input });

      expect(mockFetch.calls.length).toBe(1);
      expect(enriched.url).toBe(input.url); // best-effort: context survives
      expect(enriched.enriched).toBeUndefined();
    });

    it('marks successfully enriched context so the prompt may speak about the content', async () => {
      const mockFetch = makeMockFetch({ json: { title: 'Real Title', author_name: 'Real Channel' } });
      const baseCtx = loadSource('page_context.js', { fetch: mockFetch });
      const enriched = await baseCtx.enrichPageContext({ url: 'https://www.youtube.com/watch?v=q1w2e3' });
      expect(enriched.enriched).toBe(true);
    });

    // Outside the handful of sites with a metadata API, the redirect path
    // never loads the page, so the coach used to hold nothing but a URL.
    it('reads the page\'s own head for sites with no metadata API', async () => {
      const html = `<html><head>
        <meta property="og:title" content="The Rise &amp; Fall of the Roman Aqueduct">
        <meta property="og:description" content="A long read about plumbing.">
        <title>Ignored — og:title wins</title>
      </head><body>...</body></html>`;
      const mockFetch = makeMockFetch({ json: html });
      const ctx = loadSource('page_context.js', { fetch: mockFetch });

      const enriched = await ctx.enrichPageContext({
        url: 'https://example.com/history/aqueducts',
        contentType: 'Web Page'
      });
      expect(enriched.threadTitle).toBe('The Rise & Fall of the Roman Aqueduct');
      expect(enriched.snippet).toBe('A long read about plumbing.');
      expect(enriched.enriched).toBe(true);
    });

    it('falls back to <title> when there are no og: tags', async () => {
      const mockFetch = makeMockFetch({ json: '<html><head><title>Plain Old Page</title></head></html>' });
      const ctx = loadSource('page_context.js', { fetch: mockFetch });
      const enriched = await ctx.enrichPageContext({ url: 'https://example.com/x' });
      expect(enriched.threadTitle).toBe('Plain Old Page');
    });

    // The page is one the user is blocked from; fetching it as them would both
    // leak the visit and return a personalised page.
    it('fetches the page without cookies', async () => {
      const mockFetch = makeMockFetch({ json: '<title>T</title>' });
      const ctx = loadSource('page_context.js', { fetch: mockFetch });
      await ctx.enrichPageContext({ url: 'https://example.com/x' });
      expect(mockFetch.calls[0].init.credentials).toBe('omit');
    });

    it('does not fetch a page it can already describe', async () => {
      const mockFetch = makeMockFetch({ json: '<title>T</title>' });
      const ctx = loadSource('page_context.js', { fetch: mockFetch });
      await ctx.enrichPageContext({
        url: 'https://example.com/results?q=tax+return',
        searchQuery: 'tax return'
      });
      expect(mockFetch.calls.length).toBe(0);
    });

    it('leaves non-http destinations alone', async () => {
      const mockFetch = makeMockFetch({ json: '<title>T</title>' });
      const ctx = loadSource('page_context.js', { fetch: mockFetch });
      await ctx.enrichPageContext({ url: 'about:blank' });
      expect(mockFetch.calls.length).toBe(0);
    });

    // The MV3 worker is suspended after ~30s idle — less than the time a user
    // takes to type a reply — so a memory-only memo would miss on every turn.
    it('keeps the memo across a service worker restart', async () => {
      const store = {};
      const chromeStub = {
        storage: { session: makeStorageArea(store) },
        runtime: { lastError: null }
      };
      const url = 'https://www.youtube.com/watch?v=persisted';
      const canned = { json: { title: 'Cached Title', author_name: 'Cached Channel' } };

      const first = makeMockFetch(canned);
      await loadSource('page_context.js', { fetch: first, chrome: chromeStub })
        .enrichPageContext({ url });
      expect(first.calls.length).toBe(1);

      // A fresh evaluation of the file is a fresh worker: the Map is empty and
      // only chrome.storage.session carries anything over.
      const second = makeMockFetch(canned);
      const enriched = await loadSource('page_context.js', { fetch: second, chrome: chromeStub })
        .enrichPageContext({ url });

      expect(second.calls.length).toBe(0);
      expect(enriched.videoTitle).toBe('Cached Title');
    });

    it('never writes page titles to disk-backed storage', async () => {
      const local = {};
      const chromeStub = {
        storage: { local: makeStorageArea(local) }, // no .session, as on old Safari
        runtime: { lastError: null }
      };
      const ctx = loadSource('page_context.js', {
        fetch: makeMockFetch({ json: { title: 'Private Title' } }),
        chrome: chromeStub
      });
      await ctx.enrichPageContext({ url: 'https://www.youtube.com/watch?v=abc' });
      expect(Object.keys(local)).toEqual([]);
    });

    it('gives up on a hung host rather than holding the reply open', async () => {
      const hangingFetch = (url, init) => new Promise((resolve, reject) => {
        // Never resolves on its own — only the abort signal ends this.
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
      const baseCtx = loadSource('page_context.js', { fetch: hangingFetch });
      const enriched = await baseCtx.enrichPageContext({
        url: 'https://www.youtube.com/watch?v=hangs',
        contentType: 'YouTube Video'
      });
      expect(enriched.contentType).toBe('YouTube Video');
      expect(enriched.enriched).toBeUndefined();
    }, 10000);
  });
});
