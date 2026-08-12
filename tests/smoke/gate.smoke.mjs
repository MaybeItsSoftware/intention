// End-to-end smoke test: a real Chromium, the real unpacked extension, a real
// navigation to a real blocked site.
//
// Everything else in tests/ runs the sources inside a vm with a stubbed
// `chrome` — which cannot tell you whether the gate actually fires, whether
// webNavigation records the URL before the redirect rule replaces it, or
// whether the coach's prompt ends up carrying anything about the page. Those
// are the questions this answers, and it answers them by reading the system
// prompt the extension really sends.
//
// The LLM is the only thing faked: a local stub stands in for Intention's
// backend (the extension's own `backendUrl` setting points at it), so no
// provider is called and the exact prompt is captured for inspection.
//
// Run: node tests/smoke/gate.smoke.mjs [--headed]

import { chromium } from 'playwright';
import { createServer } from 'node:http';
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

// A stand-in for the coaching backend. Captures every request so the test can
// assert on the system prompt, and answers in the hosted route's shape.
function startBackendStub() {
  const received = [];
  return new Promise((resolveServer) => {
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        try { received.push(JSON.parse(body)); } catch (e) { received.push({ unparsed: body }); }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          text: 'What are you hoping to get from it?',
          toolCalls: [],
          balanceCredits: 100
        }));
      });
    });
    server.listen(0, '127.0.0.1', () => {
      resolveServer({ server, received, port: server.address().port });
    });
  });
}

async function main() {
  const { server, received, port } = await startBackendStub();
  const profile = await mkdtemp(join(tmpdir(), 'intention-smoke-'));

  const context = await chromium.launchPersistentContext(profile, {
    headless: !HEADED,
    channel: 'chromium',
    args: [
      `--disable-extensions-except=${EXTENSION_DIR}`,
      `--load-extension=${EXTENSION_DIR}`
    ]
  });

  try {
    // The service worker is where the extension id lives.
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15000 });
    const extensionId = new URL(worker.url()).host;
    record('extension loads with a background service worker', Boolean(extensionId), worker.url());

    // Configure it the way a set-up user's install looks, pointing the hosted
    // route at the local stub instead of the real backend.
    const settings = await context.newPage();
    await settings.goto(`chrome-extension://${extensionId}/options.html`);
    await settings.evaluate(async (backendUrl) => {
      await chrome.storage.local.clear();
      await chrome.storage.local.set({
        setupComplete: true,
        blockingMode: 'coach',
        contextProjects: 'Finish the quarterly report',
        contextReasons: 'I lose whole evenings to the feed',
        backendUrl,
        entitlement: {
          active: true,
          token: 'smoke-test-token',
          expiresAt: Date.now() + 60 * 60 * 1000
        }
      });
      // Through the real message, not a direct storage write: saving the
      // blocklist is what triggers the redirect rules to sync, and seeding
      // around it leaves the extension configured but not actually blocking.
      await new Promise((done) => {
        chrome.runtime.sendMessage(
          { action: 'saveSettings', config: { blockedDomains: ['example.com'] } },
          () => done()
        );
      });
    }, `http://127.0.0.1:${port}`);

    // Poll rather than sleep: rule registration is a couple of async hops.
    let rules = [];
    for (let attempt = 0; attempt < 20 && !rules.includes('||example.com^'); attempt++) {
      await settings.waitForTimeout(250);
      rules = await worker.evaluate(async () => {
        const dynamic = await chrome.declarativeNetRequest.getDynamicRules();
        return dynamic.map(r => r.condition?.urlFilter);
      });
    }
    record('registers a redirect rule for the blocked domain',
      rules.includes('||example.com^'), `rules: ${JSON.stringify(rules)}`);

    // The actual moment under test: navigating to a blocked site.
    const page = await context.newPage();
    await page.goto('http://example.com/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1000);

    const landedOnGate = page.url().startsWith(`chrome-extension://${extensionId}/coaching.html`);
    record('a blocked site opens the coach instead of the page',
      landedOnGate, `url: ${page.url()}`);

    // Which path gated it matters for what follows. On the redirect path the
    // blocked page is never loaded, so no content script runs and nothing can
    // read its DOM — any page detail in the prompt must have been fetched by
    // the background. That is the case the generic metadata fetch exists for.
    console.log(`    (gated via the ${landedOnGate ? 'redirect' : 'content-script overlay'} path)`);

    // The gate opens the conversation by itself; if it hasn't, say something.
    await page.waitForTimeout(2500);
    if (!received.length) {
      const input = page.locator('#int-input, textarea, input[type="text"]').first();
      if (await input.count()) {
        await input.fill('just having a quick look');
        await page.keyboard.press('Enter');
        await page.waitForTimeout(2500);
      }
    }

    record('the coach reaches the backend', received.length > 0,
      `${received.length} request(s)`);

    const system = received.map(r => r.system || '').join('\n---\n');

    record('the prompt carries the site being gated',
      /example\.com/i.test(system));

    // The whole point of the page-context work: the coach is told WHICH page,
    // not merely which domain. example.com is not in any enrichment list, so
    // this can only come from the generic metadata fetch added for the
    // redirect path — where no content script ever runs.
    record(landedOnGate
      ? 'the prompt names the specific page, which only the background could have fetched'
      : 'the prompt names the specific page',
    /Example Domain/i.test(system),
    `page context block: ${(system.match(/<untrusted_page_data>[\s\S]*?<\/untrusted_page_data>/) || ['(none)'])[0]}`);

    record('the page context is fenced as untrusted data',
      system.includes('<untrusted_page_data>'));

    record('the coach is told the day and time',
      /Right now it is \w+day, \d{1,2}:\d{2}/.test(system),
      system.split('\n').find(l => l.startsWith('Right now')) || '(absent)');

    record('the user\'s own words reach the prompt',
      system.includes('Finish the quarterly report'));

    record('grant_access is offered as a tool, not free text',
      (received[0]?.tools || []).some(t => t.name === 'grant_access'));

    const reply = await page.locator('.int-msg-assistant, .int-msg').last().textContent()
      .catch(() => '');
    record('the coach\'s reply is rendered in the gate',
      (reply || '').includes('What are you hoping'), `rendered: ${JSON.stringify(reply)}`);

    // Being able to read the real thing beats inferring it from assertions —
    // this is the only place the actual shipped prompt can be seen.
    if (process.argv.includes('--print-prompt')) {
      console.log('\n\x1b[1m─── system prompt as sent ───\x1b[0m\n');
      console.log(received[0]?.system || '(nothing captured)');
      console.log('\n\x1b[1m─────────────────────────────\x1b[0m');
    }

    if (HEADED) await page.waitForTimeout(5000);
  } finally {
    await context.close();
    server.close();
    await rm(profile, { recursive: true, force: true });
  }

  const failed = results.filter(r => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) process.exit(1);
}

main().catch((err) => {
  console.error('smoke test crashed:', err);
  process.exit(1);
});
