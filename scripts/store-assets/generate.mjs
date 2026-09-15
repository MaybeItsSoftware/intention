// Capture the shipped extension UI, then frame those captures for store images.
// Run after scripts/sync.sh: node scripts/store-assets/generate.mjs
/* global chrome */ // Playwright evaluates the storage callbacks in the extension page.
import { chromium } from 'playwright';
import { mkdtemp, rm } from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CHROME = path.join(ROOT, 'Intention Chrome');
const OUT = path.join(ROOT, 'store-assets');
const apple = path.join(ROOT, 'Intention Apple/appstore/screenshots');
const android = path.join(ROOT, 'Intention Android/fastlane/metadata/android/en-US/images/phoneScreenshots');
const stories = [
  { id: 'reason', title: 'Give a reason for every visit', detail: 'Carry it with you while you browse.' },
  { id: 'daily-time', title: 'Choose how much time to spend', detail: 'A daily budget, divided by you.' },
  { id: 'totals', title: 'See where your time went', detail: 'Time by target, day by day.' },
  { id: 'reddit', title: 'Keep the Reddit you want', detail: 'Allow a subreddit or a single post.' }
];

function key(daysAgo = 0) {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function stats() {
  return Object.fromEntries(Array.from({ length: 7 }, (_, i) => [
    key(i), {
      'instagram.com': { minutes: [18, 25, 12, 31, 10, 22, 15][i], grants: 2, sessions: [] },
      'reddit.com': { minutes: [7, 5, 9, 4, 8, 6, 11][i], grants: 1, sessions: [] }
    }
  ]));
}

async function extensionContext(profile) {
  const context = await chromium.launchPersistentContext(profile, {
    headless: true, channel: 'chromium',
    args: [`--disable-extensions-except=${CHROME}`, `--load-extension=${CHROME}`]
  });
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15000 });
  return { context, id: new URL(worker.url()).host };
}

async function seed(page, id) {
  await page.goto(`chrome-extension://${id}/options.html`);
  await page.evaluate(() => new Promise(done => chrome.storage.local.clear(done)));
  await page.evaluate(() => new Promise(done => chrome.runtime.sendMessage({
    action: 'saveSetup',
    config: {
      blockedDomains: ['example.com', 'instagram.com', 'reddit.com'],
      domainLimits: {
        'example.com': { maxGrants: 2, passMinutes: 10 },
        'instagram.com': { intentionMode: 'dailyTime', dailyTimeMinutes: 45 },
        'reddit.com': { maxGrants: 2, passMinutes: 10 }
      },
      contextProjects: 'Finish the quarterly report',
      contextReasons: 'I lose whole evenings to the feed'
    }
  }, done)));
  await page.evaluate(dailyStats => new Promise(done => chrome.storage.local.set({
    dailyStats, setupCompletedAt: Date.now() - 14 * 86400000
  }, done)), stats());
  await page.reload();
  await page.waitForSelector('#settings-view:not([hidden])');
}

async function capture(context, id, width, height) {
  const page = await context.newPage();
  await page.emulateMedia({ colorScheme: 'light' });
  await page.setViewportSize({ width, height });
  await seed(page, id);
  const pictures = {};
  const isPhone = width < 600;

  await page.click('[data-section-tab="intentions"]');
  const ig = page.locator('#domain-list > li').filter({ hasText: 'instagram.com' }).first();
  await ig.scrollIntoViewIfNeeded();
  pictures['daily-time'] = await ig.screenshot();

  const reddit = page.locator('#domain-list > li').filter({ hasText: 'reddit.com' }).first();
  await reddit.locator('details.row-more').evaluate(el => { el.open = true; });
  await reddit.scrollIntoViewIfNeeded();
  pictures.reddit = await reddit.screenshot();

  await page.click('[data-section-tab="today"]');
  const totals = page.locator('#usage-log-card');
  await totals.scrollIntoViewIfNeeded();
  pictures.totals = await totals.screenshot();

  const site = await context.newPage();
  await site.emulateMedia({ colorScheme: 'light' });
  await site.setViewportSize({ width, height });
  await site.goto('http://example.com/', { waitUntil: 'domcontentloaded' });
  await site.waitForSelector('.int-visit-reason', { timeout: 10000 });
  await site.fill('.int-visit-reason', 'Reply to my study group');
  pictures.reason = await site.screenshot();
  if (!isPhone) {
    for (const story of stories) {
      if (story.id === 'reason') continue;
      await page.click(`[data-section-tab="${story.id === 'totals' ? 'today' : 'intentions'}"]`);
      const node = story.id === 'daily-time' ? ig : story.id === 'reddit' ? reddit : totals;
      await node.scrollIntoViewIfNeeded();
      pictures[`${story.id}-browser`] = await page.screenshot();
    }
  }
  await site.close();
  await page.close();
  return pictures;
}

function stageHtml(story, source, shape) {
  const portrait = shape === 'portrait';
  const data = `data:image/png;base64,${source.toString('base64')}`;
  const ratio = source.readUInt32BE(20) / source.readUInt32BE(16);
  const frameWidth = portrait ? 88 : 89;
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    *{box-sizing:border-box}html,body{margin:0;width:100%;height:100%;overflow:hidden}
    body{background:#faf8f4;color:#444054;font-family:Georgia,'Times New Roman',serif}
    .stage{height:100%;display:flex;flex-direction:column;align-items:center;padding:${portrait ? '5% 7%' : '3% 5%'}}
    .brand{font-size:${portrait ? '3.2vw' : '1.5vw'};font-weight:bold;letter-spacing:.18em;color:#787486;margin-bottom:2%}
    h1{font-size:${portrait ? '7.2vw' : '4vw'};line-height:1.08;text-align:center;max-width:95%;margin:0;color:#444054}
    p{font-size:${portrait ? '3.2vw' : '1.8vw'};text-align:center;margin:2% 0 4%;color:#6d687c}
    .frame{width:${frameWidth}%;height:min(72vh,calc(${frameWidth}vw * ${ratio} + 4vw));margin:auto 0;border:1px solid #dad6e1;border-radius:${portrait ? '6vw' : '2vw'};padding:${portrait ? '2vw' : '1vw'};background:white;overflow:hidden}
    .frame img{width:100%;height:100%;object-fit:contain;object-position:top center}
  </style></head><body><div class="stage"><div class="brand">INTENTION</div><h1>${story.title}</h1><p>${story.detail}</p><div class="frame"><img src="${data}"></div></div></body></html>`;
}

function promoHtml(iconBuffer, wide) {
  const icon = `data:image/png;base64,${iconBuffer.toString('base64')}`;
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    *{box-sizing:border-box}html,body{margin:0;width:100%;height:100%;overflow:hidden}
    body{display:flex;align-items:center;justify-content:center;gap:${wide ? '50px' : '18px'};padding:${wide ? '80px' : '28px'};background:#faf8f4;color:#444054;font-family:Georgia,'Times New Roman',serif}
    img{width:${wide ? '160px' : '72px'};height:${wide ? '160px' : '72px'};flex:none}
    .copy{min-width:0}h1{font-size:${wide ? '76px' : '35px'};line-height:1;margin:0 0:${wide ? '18px' : '8px'}}
    p{font-size:${wide ? '30px' : '16px'};line-height:1.25;color:#6d687c;margin:0}
  </style></head><body><img src="${icon}"><div class="copy"><h1>Intention</h1><p>A reason for every visit.<br>Time for what matters.</p></div></body></html>`;
}

function featureHtml(source) {
  const image = `data:image/png;base64,${source.toString('base64')}`;
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    *{box-sizing:border-box}html,body{margin:0;width:100%;height:100%;overflow:hidden}
    body{background:#faf8f4;color:#444054;font-family:Georgia,'Times New Roman',serif;display:flex;align-items:center;padding:48px 72px;gap:62px}
    .copy{flex:1;min-width:0}h1{font-size:52px;line-height:1.08;margin:0}p{font-size:24px;line-height:1.25;margin:20px 0 0;color:#6d687c}
    .screen{width:300px;height:430px;border:1px solid #dad6e1;border-radius:22px;overflow:hidden;background:white;padding:8px;flex:none}
    .screen img{width:100%;height:100%;object-fit:cover;object-position:top center}
  </style></head><body><div class="copy"><h1>A reason for<br>every visit.</h1><p>Choose the time you need.</p></div><div class="screen"><img src="${image}"></div></body></html>`;
}

async function render(page, story, source, outPath, width, height) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  await page.setViewportSize({ width, height });
  await page.setContent(stageHtml(story, source, height > width ? 'portrait' : 'landscape'));
  await page.screenshot({ path: outPath });
  console.log(path.relative(ROOT, outPath));
}

async function main() {
  const profile = await mkdtemp(path.join(tmpdir(), 'intention-store-'));
  const { context, id } = await extensionContext(profile);
  try {
    const phone = await capture(context, id, 390, 844);
    const wide = await capture(context, id, 1280, 800);
    const renderPage = await context.newPage();
    for (const [index, story] of stories.entries()) {
      const number = index + 1;
      await render(renderPage, story, phone[story.id], path.join(apple, 'iphone-6.9', `${number}.png`), 1320, 2868);
      await render(renderPage, story, wide[story.id], path.join(apple, 'ipad-13', `${number}.png`), 2064, 2752);
      await render(renderPage, story, wide[story.id], path.join(apple, 'macos', `${number}.png`), 2560, 1600);
      await render(renderPage, story, phone[story.id], path.join(android, `${number}.png`), 1080, 1920);
      for (const browser of ['chrome', 'firefox']) {
        const browserPath = path.join(OUT, 'browser', browser, 'screenshots', `${number}.png`);
        fs.mkdirSync(path.dirname(browserPath), { recursive: true });
        fs.writeFileSync(browserPath, story.id === 'reason' ? wide.reason : wide[`${story.id}-browser`]);
      }
    }
    fs.mkdirSync(path.join(OUT, 'browser', 'chrome'), { recursive: true });
    fs.copyFileSync(path.join(ROOT, 'shared/icon128.png'), path.join(OUT, 'browser/chrome/icon128.png'));
    fs.copyFileSync(path.join(ROOT, 'shared/icon128.png'), path.join(OUT, 'browser/firefox/icon128.png'));
    const icon = fs.readFileSync(path.join(ROOT, 'shared/icon128.png'));
    for (const [name, width, height, wide] of [
      ['promo-small.png', 440, 280, false],
      ['promo-marquee.png', 1400, 560, true]
    ]) {
      await renderPage.setViewportSize({ width, height });
      await renderPage.setContent(promoHtml(icon, wide));
      await renderPage.screenshot({ path: path.join(OUT, 'browser/chrome', name) });
    }
    await renderPage.setViewportSize({ width: 1024, height: 500 });
    await renderPage.setContent(featureHtml(phone.reason));
    await renderPage.screenshot({ path: path.join(ROOT,
      'Intention Android/fastlane/metadata/android/en-US/images/featureGraphic.png') });
    // These old fifth images advertised bringing an external AI key into
    // store-reviewed builds, and no longer represent the app or its paywall.
    for (const old of [
      path.join(apple, 'iphone-6.9/5.png'),
      path.join(apple, 'ipad-13/5.png'),
      path.join(android, '5.png')
    ]) {
      if (fs.existsSync(old)) fs.unlinkSync(old);
    }
    await renderPage.close();
  } finally {
    await context.close();
    await rm(profile, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exit(1); });
