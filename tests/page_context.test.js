import { describe, it, expect } from 'vitest';
import { loadSource, makeMockFetch } from './load.js';

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
  });
});
