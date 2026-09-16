// A real browser regression for the dynamic picker: an unstyled .add-modal
// used to be appended below Settings, leaving both scope choices looking inert.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const extension = process.env.INTENTION_PARTS_EXTENSION_DIR || join(root, 'Intention Chrome');
const profile = await mkdtemp(join(tmpdir(), 'intention-parts-'));
const context = await chromium.launchPersistentContext(profile, {
  headless: !process.argv.includes('--headed'),
  channel: 'chromium',
  args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`]
});
try {
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker');
  const id = new URL(worker.url()).host;
  const page = await context.newPage();
  await page.goto(`chrome-extension://${id}/options.html`);
  for (const width of [360, 900]) {
    await page.setViewportSize({ width, height: 740 });
    for (const [text, scope] of [['Block selected parts', 'only'], ['Allow selected parts', 'except']]) {
      await page.evaluate(async () => {
        await chrome.storage.local.clear();
        await chrome.storage.local.set({ setupComplete: true, enabled: true,
          blockedDomains: ['instagram.com'], domainLimits: { 'instagram.com': { maxGrants: 3, passMinutes: 10 } } });
      });
      await page.reload();
      await page.waitForSelector('#settings-view:not([hidden])');
      await page.locator('[data-section-tab="intentions"]').click();
      const row = page.locator('#domain-list > li').first();
      await row.locator('summary').click();
      await row.getByRole('button', { name: text, exact: true }).click();
      const modal = page.locator('.part-picker-modal');
      await modal.waitFor({ state: 'visible' });
      const layout = await modal.evaluate(el => {
        const box = el.querySelector('[role="dialog"]').getBoundingClientRect();
        return { position: getComputedStyle(el).position, left: box.left, right: box.right,
          top: box.top, bottom: box.bottom, screenWidth: innerWidth, screenHeight: innerHeight };
      });
      assert.equal(layout.position, 'fixed', 'parts picker must overlay Settings');
      assert(layout.left >= 0 && layout.right <= layout.screenWidth, JSON.stringify(layout));
      assert(layout.top >= 0 && layout.bottom <= layout.screenHeight, JSON.stringify(layout));
      await modal.getByRole('button', { name: 'Reels', exact: true }).click();
      await page.waitForSelector('#loosen-modal:not([hidden])');
      await page.locator('#loosen-later-btn').click();
      await page.waitForFunction(() => document.getElementById('loosen-title').textContent === 'Saved for tomorrow');
      assert.equal(await page.locator('#loosen-title').textContent(), 'Saved for tomorrow');
      assert.match(await page.locator('#loosen-when').textContent(), /Your current rules stay in place/);
      const waiting = await page.evaluate(async () => (await chrome.storage.local.get('pendingChanges')).pendingChanges);
      assert.deepEqual(waiting[0].newValue, { scope, parts: ['instagram:reels'] });
      const active = await page.evaluate(async () => (await chrome.storage.local.get('domainLimits')).domainLimits['instagram.com']);
      assert.equal(active.scope, undefined, 'saving for tomorrow must leave today fully blocked');
      await page.locator('#loosen-later-btn').click();
      await page.locator('#intentions-pending-card').waitFor({ state: 'visible' });
      await page.reload();
      await page.locator('[data-section-tab="intentions"]').click();
      await page.locator('#intentions-pending-card').waitFor({ state: 'visible' });
      await page.locator('[data-section-tab="today"]').click();
      await page.locator('#pending-card').waitFor({ state: 'visible' });
      await page.locator('[data-section-tab="intentions"]').click();
      await page.locator('#intentions-pending-list .pending-undo').click();
      await page.locator('#intentions-pending-card').waitFor({ state: 'hidden' });
      await page.locator('[data-section-tab="today"]').click();
      await page.locator('#pending-card').waitFor({ state: 'hidden' });
      const cancelled = await page.evaluate(async () => (await chrome.storage.local.get('pendingChanges')).pendingChanges);
      assert.equal(cancelled.length, 0);
      console.log(`✓ ${width}px: ${text} opens a visible picker and schedules its selected part`);
    }
  }
} finally {
  await context.close();
  await rm(profile, { recursive: true, force: true });
}
