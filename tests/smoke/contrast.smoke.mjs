// Walks every visible text node in the settings page and the wizard, in both
// themes, and measures its contrast against whatever is actually painted
// behind it.
//
// This exists because the retheme was a mechanical swap of ~40 colour literals
// for role tokens, and that kind of change fails silently. The base `button`
// rule paints text in --primary-on for filled buttons; any button-shaped thing
// that relied on inheriting the old near-white now inherits an actual white
// onto a white card, and looks perfect to whoever is reading the diff.
//
// Thresholds are WCAG AA: 4.5:1 for body text, 3:1 for large text (>=24px, or
// >=18.66px bold). Azure is 3.6:1 on chalk, which is why it is a token for
// fills and borders and a separate darker token for anything read.
//
// Run: node tests/smoke/contrast.smoke.mjs

import { chromium } from 'playwright';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const EXTENSION_DIR = join(REPO_ROOT, 'Intention Chrome');

const results = [];
const record = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  const mark = pass ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m';
  console.log(`${mark} ${name}${detail ? `\n    ${detail}` : ''}`);
};

// Runs in the page. Returns every offending element, not just the first.
const AUDIT = () => {
  const lum = (rgb) => {
    const parts = (rgb.match(/[\d.]+/g) || []).map(Number);
    const [r, g, b] = parts.slice(0, 3).map(v => {
      const c = v / 255;
      return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const alphaOf = (rgb) => {
    const parts = (rgb.match(/[\d.]+/g) || []).map(Number);
    return parts.length > 3 ? parts[3] : 1;
  };
  // What is actually painted behind this element: walk up until something is
  // not transparent. A token that resolves to nothing lands here as
  // transparent and inherits the page, which is the failure mode worth seeing.
  const backdrop = (el) => {
    let node = el;
    while (node && node !== document.documentElement) {
      const bg = getComputedStyle(node).backgroundColor;
      if (alphaOf(bg) > 0.9) return bg;
      node = node.parentElement;
    }
    return getComputedStyle(document.body).backgroundColor;
  };

  const bad = [];
  for (const el of document.querySelectorAll('body *')) {
    if (el.closest('[hidden]') || el.hidden) continue;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') continue;
    const rect = el.getBoundingClientRect();
    if (!rect.width || !rect.height) continue;

    // Only elements that paint their own text, not containers of other tags.
    const own = [...el.childNodes]
      .filter(n => n.nodeType === 3 && n.textContent.trim())
      .map(n => n.textContent.trim())
      .join(' ');
    if (!own) continue;

    const size = parseFloat(cs.fontSize);
    const weight = Number(cs.fontWeight) || 400;
    const large = size >= 24 || (size >= 18.66 && weight >= 700);
    const need = large ? 3 : 4.5;

    const fg = lum(cs.color);
    const bg = lum(backdrop(el));
    const ratio = (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05);
    if (ratio + 0.05 < need) {
      bad.push({
        text: own.slice(0, 42),
        tag: el.tagName.toLowerCase(),
        cls: (el.className && String(el.className).slice(0, 40)) || '',
        color: cs.color,
        behind: backdrop(el),
        size: `${size}px/${weight}`,
        ratio: Math.round(ratio * 10) / 10,
        need
      });
    }
  }
  return bad;
};

const report = (bad) => bad
  .map(b => `${b.ratio}:1 (needs ${b.need}) — ${b.tag}.${b.cls} "${b.text}" ${b.color} on ${b.behind} @${b.size}`)
  .join('\n    ');

async function main() {
  const profile = await mkdtemp(join(tmpdir(), 'intention-contrast-'));
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
      await page.goto(`chrome-extension://${id}/options.html`);
      await page.evaluate(() => chrome.storage.local.clear());
      await page.reload();
      await page.waitForSelector('#setup-view:not([hidden])');

      // Walk the wizard so every step's chrome is measured, not just step 1.
      await page.click('#setup-next-btn');
      await page.evaluate(async () => {
        await addDomainToBlocklist('instagram.com', 10);
        await addDomainToBlocklist('some-blog.example', 15);
      });
      await page.waitForTimeout(120);

      const total = await page.evaluate(() => setupStepOrder.length);
      for (let step = 2; step <= total; step++) {
        await page.evaluate(n => showSetupStep(n), step);
        await page.waitForTimeout(80);
        const bad = await page.evaluate(AUDIT);
        const label = await page.textContent('#setup-progress-label');
        record(`[${scheme}] wizard ${label.toLowerCase()} is legible`, bad.length === 0, report(bad));
      }

      // Settings: every tab, with a populated blocklist and a row open.
      await page.evaluate(() => new Promise(done => chrome.runtime.sendMessage({
        action: 'saveSetup',
        config: {
          blockedDomains: ['instagram.com', 'some-blog.example'],
          domainLimits: { 'instagram.com': { maxGrants: 3, maxMinutes: 10 } },
          contextProjects: 'Finish the report',
          serviceReasons: { 'instagram.com': { purpose: 'DMs from my sister.' } }
        }
      }, done)));
      await page.reload();
      await page.waitForSelector('#settings-view:not([hidden])');
      await page.waitForTimeout(300);

      for (const tab of ['blocking', 'activity', 'coach', 'settings']) {
        await page.click(`[data-section-tab="${tab}"]`);
        await page.waitForTimeout(200);
        await page.evaluate(() => {
          document.querySelectorAll('details').forEach(d => d.setAttribute('open', ''));
        });
        await page.waitForTimeout(120);
        const bad = await page.evaluate(AUDIT);
        record(`[${scheme}] settings → ${tab} is legible`, bad.length === 0, report(bad));
      }

      // The full-screen coaching page: its own stylesheet, plus the shared
      // paywall. This is the surface a native-app user spends the most time
      // on, and until this pass it styled twelve of the nineteen classes
      // renderPaywall emits.
      await page.goto(`chrome-extension://${id}/coaching.html?domain=instagram.com&mode=gate`);
      await page.waitForTimeout(900);
      const coachBad = await page.evaluate(AUDIT);
      record(`[${scheme}] the coaching page is legible`, coachBad.length === 0, report(coachBad));

      await page.close();
    }
  } finally {
    await context.close();
    await rm(profile, { recursive: true, force: true });
  }

  const failed = results.filter(r => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} surfaces legible`);
  if (failed.length) process.exit(1);
}

main().catch(err => { console.error('contrast smoke test crashed:', err); process.exit(1); });
