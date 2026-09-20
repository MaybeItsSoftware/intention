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
// Dark first: the listing leads with the dark set, then repeats the same four
// stories in light, so a viewer sees both themes without the order alternating.
const schemes = ['dark', 'light'];

// Each canvas gets a capture of its own shape. Reusing the 1280x800 desktop
// capture for the portrait iPad canvas was what made the UI render tiny inside
// a letterboxed frame while the phone shot filled its own.
const surfaces = {
  phone:   { width: 390,  height: 844,  browser: false },
  tablet:  { width: 1024, height: 1366, browser: false },
  desktop: { width: 1280, height: 800,  browser: true }
};

const theme = {
  dark:  { paper: '#1c1a23', ink: '#f5f4f7', muted: '#b6b3bf', dim: '#b6b3bf', line: '#34313f', raised: '#25232f' },
  light: { paper: '#faf8f4', ink: '#444054', muted: '#787486', dim: '#6d687c', line: '#dad6e1', raised: '#ffffff' }
};

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

async function capture(context, id, { width, height, browser }, scheme) {
  const page = await context.newPage();
  await page.emulateMedia({ colorScheme: scheme });
  await page.setViewportSize({ width, height });
  await seed(page, id);
  const pictures = {};

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
  await site.emulateMedia({ colorScheme: scheme });
  await site.setViewportSize({ width, height });
  await site.goto('http://example.com/', { waitUntil: 'domcontentloaded' });
  await site.waitForSelector('.int-visit-reason', { timeout: 10000 });
  await site.fill('.int-visit-reason', 'Reply to my study group');
  pictures.reason = await site.screenshot();
  if (browser) {
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

function stageHtml(story, source, width, height, scheme) {
  const c = theme[scheme];
  const data = `data:image/png;base64,${source.toString('base64')}`;
  // One unit is 1% of the canvas's SHORT edge. Sizing off vw instead is what
  // made type and spacing jump between a tall phone canvas and a wide desktop
  // one; the short edge keeps their optical weight the same on both.
  const u = Math.min(width, height) / 100;
  const px = n => `${(n * u).toFixed(1)}px`;
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    *{box-sizing:border-box}html,body{margin:0;width:100%;height:100%;overflow:hidden}
    body{background:${c.paper};color:${c.ink};font-family:Georgia,'Times New Roman',serif}
    .stage{height:100%;display:flex;flex-direction:column;align-items:center;padding:${px(4.5)} ${px(5)} ${px(5)}}
    .brand{font-size:${px(1.6)};font-weight:bold;letter-spacing:.18em;color:${c.muted};margin-bottom:${px(2)}}
    h1{font-size:${px(6.2)};line-height:1.08;text-align:center;max-width:95%;margin:0;color:${c.ink}}
    p{font-size:${px(2.6)};text-align:center;margin:${px(1.8)} 0 0;color:${c.dim}}
    /* The frame carries the capture's own aspect ratio and grows to the largest
       size that still fits the space left under the copy. The screenshot then
       fills it exactly — no letterbox band, and the UI lands at the same
       optical scale on every canvas. */
    .shot{flex:1;min-height:0;width:100%;display:flex;align-items:center;justify-content:center;margin-top:${px(3)}}
    /* Left unsized on purpose — fitFrame() measures the space left under the
       copy and sets the exact box. CSS cannot express "largest box with this
       aspect that fits BOTH axes": sizing off height throws a landscape capture
       past the canvas width, sizing off width leaves a portrait one tiny. */
    .frame{border:1px solid ${c.line};border-radius:${px(3)};padding:${px(0.9)};
      background:${c.raised};overflow:hidden}
    .frame img{display:block;width:100%;height:100%;object-fit:cover;object-position:top center;border-radius:${px(2.2)}}
  </style></head><body><div class="stage"><div class="brand">INTENTION</div>
    <h1>${story.title}</h1><p>${story.detail}</p>
    <div class="shot"><div class="frame"><img src="${data}"></div></div>
  </div></body></html>`;
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

async function render(page, story, source, outPath, width, height, scheme) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  await page.setViewportSize({ width, height });
  await page.setContent(stageHtml(story, source, width, height, scheme));
  await page.evaluate(([sourceWidth, sourceHeight]) => {
    const shot = document.querySelector('.shot');
    const frame = document.querySelector('.frame');
    const style = getComputedStyle(frame);
    const chrome = side =>
      parseFloat(style[`padding${side}`]) + parseFloat(style[`border${side}Width`]);
    const extraX = chrome('Left') + chrome('Right');
    const extraY = chrome('Top') + chrome('Bottom');
    const scale = Math.min(
      (shot.clientWidth - extraX) / sourceWidth,
      (shot.clientHeight - extraY) / sourceHeight
    );
    frame.style.width = `${Math.floor(sourceWidth * scale + extraX)}px`;
    frame.style.height = `${Math.floor(sourceHeight * scale + extraY)}px`;
  }, [source.readUInt32BE(16), source.readUInt32BE(20)]);
  await page.screenshot({ path: outPath });
  console.log(path.relative(ROOT, outPath));
}

async function main() {
  const profile = await mkdtemp(path.join(tmpdir(), 'intention-store-'));
  const { context, id } = await extensionContext(profile);
  try {
    const shots = {};
    for (const scheme of schemes) {
      shots[scheme] = {};
      for (const [name, surface] of Object.entries(surfaces)) {
        shots[scheme][name] = await capture(context, id, surface, scheme);
      }
    }

    const renderPage = await context.newPage();
    for (const [pass, scheme] of schemes.entries()) {
      const shot = shots[scheme];
      for (const [index, story] of stories.entries()) {
        const number = pass * stories.length + index + 1;
        await render(renderPage, story, shot.phone[story.id], path.join(apple, 'iphone-6.9', `${number}.png`), 1320, 2868, scheme);
        await render(renderPage, story, shot.tablet[story.id], path.join(apple, 'ipad-13', `${number}.png`), 2064, 2752, scheme);
        await render(renderPage, story, shot.desktop[story.id], path.join(apple, 'macos', `${number}.png`), 2560, 1600, scheme);
        await render(renderPage, story, shot.phone[story.id], path.join(android, `${number}.png`), 1080, 1920, scheme);
      }
    }

    // The browser listings take the raw desktop capture rather than a framed
    // stage, and stay light — their store pages are not themed with the app.
    const wide = shots.light.desktop;
    for (const [index, story] of stories.entries()) {
      for (const browser of ['chrome', 'firefox']) {
        const browserPath = path.join(OUT, 'browser', browser, 'screenshots', `${index + 1}.png`);
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
    await renderPage.setContent(featureHtml(shots.light.phone.reason));
    await renderPage.screenshot({ path: path.join(ROOT,
      'Intention Android/fastlane/metadata/android/en-US/images/featureGraphic.png') });
    // Each run writes 1..N; anything past N is a leftover from a shorter set.
    // The old fifth images also advertised bringing an external AI key into
    // store-reviewed builds, which no longer represents the app or its paywall.
    const total = schemes.length * stories.length;
    for (const dir of ['iphone-6.9', 'ipad-13', 'macos'].map(d => path.join(apple, d)).concat(android)) {
      if (!fs.existsSync(dir)) continue;
      for (const file of fs.readdirSync(dir)) {
        const n = Number(path.basename(file, '.png'));
        if (Number.isInteger(n) && n > total) fs.unlinkSync(path.join(dir, file));
      }
    }
    await renderPage.close();
  } finally {
    await context.close();
    await rm(profile, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exit(1); });
