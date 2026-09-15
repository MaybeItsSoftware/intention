// End-to-end smoke test for "Leaving Intention" (WP9), against a real
// Chromium with the real unpacked extension.
//
// THIS TEST IS A GATE, not a regression net. The entire browser half of the
// feature rests on one unverified assumption — that `chrome.tabs.onUpdated`
// delivers a populated URL for a `chrome://` page under the "tabs" permission.
// Nothing else can tell us: `chrome.webNavigation` does not fire for chrome://
// URLs, `declarativeNetRequest` cannot match a page that is not a network
// request, and content scripts cannot be injected into WebUI. If the probe at
// the top of main() comes back empty, the honest response is to DROP the
// interposition and ship `setUninstallURL` plus the settings card alone —
// not to ship a listener that silently never fires.
//
// Everything after the probe is about the promises the feature makes:
//
//   * one tab opens BESIDE chrome://extensions, and that page is never
//     navigated or closed (the Chrome Web Store's "easily reversible" clause);
//   * "Remove it anyway" is present and enabled on the FIRST paint of the
//     conversation, never on a timer;
//   * a second visit inside the debounce opens nothing.
//
// Run: node tests/smoke/leaving.smoke.mjs [--headed]

import { chromium } from 'playwright';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const EXTENSION_DIR = join(REPO_ROOT, 'Intention Chrome');
const HEADED = process.argv.includes('--headed');

const results = [];
const record = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  const mark = pass ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m';
  console.log(`${mark} ${name}${detail && !pass ? `\n    ${detail}` : ''}`);
};

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Every tab currently open, by URL. `context.pages()` is the only view of
// this that survives a tab the extension opened rather than the test.
const openUrls = (context) => context.pages().map(p => p.url());

const leaveTabs = (context) => openUrls(context).filter(u => /options\.html\?leave=1/.test(u));

// Wait for a tab matching the leave URL, up to `ms`. Returns the page or null
// rather than throwing, so the failure is recorded as a failed check with the
// tab list attached instead of a stack trace.
async function waitForLeaveTab(context, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const page = context.pages().find(p => /options\.html\?leave=1/.test(p.url()));
    if (page) return page;
    await sleep(200);
  }
  return null;
}

async function main() {
  const profile = await mkdtemp(join(tmpdir(), 'intention-leaving-'));
  const context = await chromium.launchPersistentContext(profile, {
    headless: !HEADED,
    channel: 'chromium',
    args: [
      `--disable-extensions-except=${EXTENSION_DIR}`,
      `--load-extension=${EXTENSION_DIR}`
    ]
  });

  try {
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15000 });
    const extensionId = new URL(worker.url()).host;
    const optionsUrl = `chrome-extension://${extensionId}/options.html`;

    // ── A minimal finished setup. The interposition is gated on
    // `setupComplete && blockedDomains.length > 0`, and both halves matter:
    // somebody who has removed every site has effectively already left.
    const setupPage = await context.newPage();
    await setupPage.goto(optionsUrl);
    await setupPage.evaluate(() => new Promise(done => chrome.storage.local.set({
      setupComplete: true,
      blockedDomains: ['example.com'],
      domainLimits: { 'example.com': { maxGrants: 3, maxMinutes: 30 } },
      provider: 'anthropic',
      apiKey: 'smoke-test-key',
      model: 'claude-sonnet-5'
    }, done)));
    await setupPage.reload();
    await setupPage.waitForSelector('#settings-view:not([hidden])');
    // Settings opens on Today now; the leaving card lives under Intentions.
    await setupPage.click('[data-section-tab="intentions"]');

    const cardVisible = await setupPage.isVisible('#leaving-card');
    record('the leaving card is on the Intentions tab of a finished setup', cardVisible);

    const exportPresent = await setupPage.isVisible('#export-list-btn');
    record('and offers the blocklist export, so leaving is not punitive', exportPresent);

    // ── The cool-off ladder paints what is stored, and — the property that
    // matters most on this card — a pending request always carries a live way
    // out. A cool-off you cannot end is a lock, and this is not a lock.
    await setupPage.evaluate(() => new Promise(done => chrome.storage.local.set({
      leaveDelayMinutes: 1440,
      leaveRequest: { requestedAt: Date.now() - 3600_000, availableAt: Date.now() + 82_800_000, delayMinutes: 1440 }
    }, done)));
    await setupPage.reload();
    await setupPage.waitForSelector('#leave-pending:not([hidden])', { timeout: 10000 }).catch(() => {});

    const selected = await setupPage.locator('#leave-delay-choices .leave-choice.selected').getAttribute('data-minutes').catch(() => null);
    record('the ladder paints the stored cool-off as the selected rung', selected === '1440', String(selected));

    const pendingText = (await setupPage.textContent('#leave-pending')) || '';
    record('a pending request says when it was made and when it is up',
      /You asked to remove Intention .* ago\. It'll be ready in /.test(pendingText), pendingText.slice(0, 160));

    const anyway = setupPage.locator('#leave-now-anyway-btn');
    record('and carries a live way out DURING the cool-off',
      (await anyway.count()) === 1 && await anyway.isEnabled(),
      `count ${await anyway.count()}`);
    record('and a way to change your mind', await setupPage.locator('#leave-cancel-btn').isEnabled());

    // Back to the state the interposition half needs: no request outstanding,
    // because a live one deliberately suppresses it (they already asked).
    await setupPage.evaluate(() => new Promise(done => chrome.storage.local.set({
      leaveDelayMinutes: 0, leaveRequest: null, leaveStandDown: null, leaveInterposedAt: 0
    }, done)));

    // Leaving the settings tab open would make "a NEW tab appeared" ambiguous,
    // and it is also the honest shape of the scenario: somebody going to
    // chrome://extensions is not sitting in Intention's settings.
    await setupPage.goto('about:blank');

    // ══════════════════════════════════════════════════════════════════════
    // THE GATE. Everything below depends on this answering yes.
    // ══════════════════════════════════════════════════════════════════════
    //
    // A probe listener inside the real service worker, live across a real
    // navigation to chrome://extensions. It records what the API actually
    // hands over — not what the docs say it should.
    const probe = worker.evaluate(() => new Promise((resolve) => {
      const seen = [];
      const fn = (tabId, changeInfo, tab) => {
        seen.push({
          changeUrl: (changeInfo && changeInfo.url) || null,
          tabUrl: (tab && tab.url) || null,
          status: (changeInfo && changeInfo.status) || null
        });
      };
      chrome.tabs.onUpdated.addListener(fn);
      setTimeout(() => {
        try { chrome.tabs.onUpdated.removeListener(fn); } catch (e) {}
        resolve(seen);
      }, 8000);
    }));

    const extensionsPage = await context.newPage();
    await extensionsPage.goto('chrome://extensions/');
    await sleep(500);

    const seen = await probe;
    const sawExtensionsUrl = seen.some(e =>
      /^chrome:\/\/extensions/.test(e.changeUrl || '') || /^chrome:\/\/extensions/.test(e.tabUrl || ''));
    record('GATE: tabs.onUpdated delivers a populated URL for chrome://extensions',
      sawExtensionsUrl,
      `events seen: ${JSON.stringify(seen).slice(0, 500)}`);

    if (!sawExtensionsUrl) {
      console.log('\n\x1b[31mThe browser interposition cannot work on this engine.\x1b[0m');
      console.log('Drop the tabs.onUpdated listener from shared/background.js and degrade WP9');
      console.log('to setUninstallURL + the settings leaving card. Do not ship it unproven.\n');
    }

    // ── (a) A tab, within five seconds, at options.html?leave=1.
    const leavePage = await waitForLeaveTab(context, 5000);
    record('a tab opens at options.html?leave=1 within 5s',
      !!leavePage, `tabs open: ${JSON.stringify(openUrls(context))}`);

    // ── (b) The extensions page is untouched. This is the Chrome Web Store
    // "must be easily reversible" clause, and the reason we open a tab beside
    // it rather than navigating it: the user may have opened that page to
    // manage a completely different extension.
    record('the chrome://extensions tab is still on chrome://extensions',
      /^chrome:\/\/extensions/.test(extensionsPage.url()), extensionsPage.url());
    record('and was not closed', !extensionsPage.isClosed());

    if (leavePage) {
      // ── (c) The exit, on the FIRST paint. Not after the coach replies, not
      // after a countdown, not after a scroll. A self-control tool whose exit
      // arrives late has decided it knows better than its user.
      await leavePage.waitForSelector('#gate-modal:not([hidden])', { timeout: 15000 }).catch(() => {});
      const exit = leavePage.locator('#gate-leave-anyway-btn');
      const present = await exit.count();
      record('#gate-leave-anyway-btn is present in the leaving conversation', present === 1, `count ${present}`);
      if (present === 1) {
        record('and visible', await exit.isVisible());
        record('and NOT disabled on first paint', await exit.isEnabled());
        const label = (await exit.textContent()) || '';
        record('and says what it does', /remove it anyway/i.test(label), label);
      }

      // ── (d) "Cancel" is the wrong word for a conversation somebody landed
      // in because they went to manage another extension.
      const closeLabel = (await leavePage.textContent('#gate-close-btn')) || '';
      record('the close button reads "I was here for something else"',
        closeLabel.trim() === 'I was here for something else', closeLabel);

      // Close it the way a user would, which also writes the stand-down.
      await leavePage.click('#gate-close-btn');
      await sleep(400);
      await leavePage.close();
    }

    // ── (e) A second visit inside the debounce opens nothing. This is the
    // anti-loop property; without it the feature is a tab that reappears every
    // time you look at the page you are trying to use.
    const before = leaveTabs(context).length;
    const secondVisit = await context.newPage();
    await secondVisit.goto('chrome://extensions/');
    await sleep(4000);
    const after = leaveTabs(context).length;
    record('a second visit inside the debounce opens no further tab',
      after === before, `before ${before}, after ${after}: ${JSON.stringify(openUrls(context))}`);

    // ── And the farewell page is registered, pointing away from our backend:
    // an uninstall URL aimed at api.intention.* would make every removal a
    // logged request, which is an uninstall ping and PRIVACY.md forbids it.
    const uninstallUrl = await worker.evaluate(() => new Promise((resolve) => {
      // No getter exists for it, so re-register a known value and assert the
      // call is accepted at all — the source of truth for WHAT is registered
      // is tests/background.test.js.
      try {
        chrome.runtime.setUninstallURL('https://github.com/MaybeItsSoftware/intention/blob/main/docs/LEAVING.md', () => resolve('ok'));
      } catch (e) {
        resolve(String(e && e.message));
      }
    }));
    record('setUninstallURL is accepted by this engine', uninstallUrl === 'ok', String(uninstallUrl));

    if (HEADED) await sleep(5000);
  } finally {
    await context.close();
    await rm(profile, { recursive: true, force: true });
  }

  const failed = results.filter(r => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) process.exit(1);
}

main().catch((err) => {
  console.error('leaving smoke test crashed:', err);
  process.exit(1);
});
