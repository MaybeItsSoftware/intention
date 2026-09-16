// Screenshots of every themed surface, light and dark, from the real unpacked
// extension. Not an assertion harness — a way to look at the retheme without
// installing anything. Writes into build/shots/.
//
// Run: node tests/smoke/shots.mjs

import { chromium } from 'playwright';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const EXTENSION_DIR = join(REPO_ROOT, 'Intention Chrome');
const OUT = join(REPO_ROOT, 'build', 'shots');

async function main() {
  await mkdir(OUT, { recursive: true });
  const profile = await mkdtemp(join(tmpdir(), 'intention-shots-'));
  const context = await chromium.launchPersistentContext(profile, {
    headless: true,
    channel: 'chromium',
    args: [`--disable-extensions-except=${EXTENSION_DIR}`, `--load-extension=${EXTENSION_DIR}`]
  });

  try {
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15000 });
    const id = new URL(worker.url()).host;

    for (const scheme of ['light', 'dark']) {
      const page = await context.newPage();
      await page.emulateMedia({ colorScheme: scheme });
      await page.setViewportSize({ width: 1180, height: 1000 });

      // ── Wizard: welcome, then a per-service screen.
      await page.goto(`chrome-extension://${id}/options.html`);
      await page.evaluate(() => chrome.storage.local.clear());
      await page.reload();
      await page.waitForSelector('#setup-view:not([hidden])');
      await page.screenshot({ path: join(OUT, `wizard-welcome-${scheme}.png`) });

      await page.click('#setup-next-btn');
      await page.evaluate(async () => {
        await addDomainToBlocklist('instagram.com', 10);
        await addDomainToBlocklist('reddit.com', 15);
      });
      await page.waitForTimeout(100);
      await page.screenshot({ path: join(OUT, `wizard-sites-${scheme}.png`) });

      await page.click('#setup-next-btn');
      await page.click('#setup-next-btn');
      await page.waitForTimeout(100);
      await page.screenshot({ path: join(OUT, `wizard-purpose-${scheme}.png`) });

      // ── Settings, populated.
      await page.evaluate(() => new Promise(done => chrome.runtime.sendMessage({
        action: 'saveSetup',
        config: {
          blockedDomains: ['instagram.com', 'reddit.com', 'example.com'],
          domainLimits: {
            // One row with a loose -> strict split set and one without, so the
            // timeline is shown in both of its states.
            'instagram.com': { maxGrants: 3, maxMinutes: 45, looseUntilMinutes: 15 },
            'reddit.com': { maxGrants: 3, maxMinutes: 15 }
          },
          contextProjects: 'Finish the quarterly report',
          contextReasons: 'I lose whole evenings to the feed',
          serviceReasons: {
            'instagram.com': { purpose: 'DMs from my sister.', legitimateUse: 'A specific reply.' }
          }
        }
      }, done)));
      // A week of history, so Today has a streak with a slip, a chart and
      // per-target meters in every state. Written straight to storage: it is
      // what tracking.js would have recorded.
      await page.evaluate(() => new Promise(done => {
        const key = (ago) => {
          const d = new Date();
          d.setDate(d.getDate() - ago);
          return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        };
        const day = (ig, rd, negotiated = 0) => ({
          'instagram.com': { minutes: ig, grants: 3 + negotiated, negotiated, sessions: [] },
          'reddit.com': { minutes: rd, grants: 2, sessions: [] }
        });
        const dailyStats = {
          [key(6)]: day(20, 30), [key(5)]: day(12, 8), [key(4)]: day(38, 25, 1),
          [key(3)]: day(18, 14), [key(2)]: day(9, 6), [key(1)]: day(22, 12),
          [key(0)]: { 'instagram.com': { minutes: 26, grants: 3, sessions: [] }, 'reddit.com': { minutes: 7, grants: 1, sessions: [] } }
        };
        chrome.storage.local.set({ dailyStats, setupCompletedAt: Date.now() - 20 * 86400000 }, done);
      }));

      // Wide (the Mac window and a desktop tab), then phone width.
      for (const [label, width] of [['wide', 1180], ['phone', 390]]) {
        await page.setViewportSize({ width, height: label === 'phone' ? 1600 : 1000 });
        await page.reload();
        await page.waitForSelector('#settings-view:not([hidden])');
        await page.waitForTimeout(300);
        // localStorage remembers the last section across passes, so each tab
        // is clicked rather than assumed.
        for (const tab of ['today', 'intentions', 'coach', 'settings']) {
          await page.click(`[data-section-tab="${tab}"]`);
          await page.waitForTimeout(200);
          await page.screenshot({ path: join(OUT, `settings-${tab}-${label}-${scheme}.png`), fullPage: true });
        }
      }
      await page.setViewportSize({ width: 1180, height: 1000 });

      // ── The coaching page (the native app's full-screen chat).
      await page.goto(`chrome-extension://${id}/coaching.html?domain=instagram.com&mode=gate`);
      await page.waitForTimeout(600);
      await page.screenshot({ path: join(OUT, `coaching-${scheme}.png`) });

      // ── The in-page gate, on a real third-party page.
      const site = await context.newPage();
      await site.emulateMedia({ colorScheme: scheme });
      await site.setViewportSize({ width: 1180, height: 900 });
      // The host page declares its own tokens with the same names ours use. If
      // the overlay ever put them on :root, or relied on inheriting them, this
      // is the page that would show it.
      await site.addInitScript(() => {
        document.addEventListener('DOMContentLoaded', () => {
          const s = document.createElement('style');
          s.textContent = ':root{--paper:#ff00ff;--ink:#00ff00;--border:#ff0000;--radius-card:40px}';
          document.head.appendChild(s);
        });
      });
      await site.goto('http://example.com/', { waitUntil: 'domcontentloaded' });
      await site.waitForTimeout(2500);
      await site.screenshot({ path: join(OUT, `gate-${scheme}.png`) });
      await site.close();
      await page.close();
    }
    console.log(`wrote screenshots to ${OUT}`);
  } finally {
    await context.close();
    await rm(profile, { recursive: true, force: true });
  }
}

main().catch(err => { console.error(err); process.exit(1); });
