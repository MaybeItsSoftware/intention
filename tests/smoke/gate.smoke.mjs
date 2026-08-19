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
// provider is called and the exact prompt is captured for inspection. The
// stub's replies are scriptable per request, which is what lets one browser
// session walk the whole arc: the gate opening the conversation itself, a
// walk-away (moment, closed tab, recorded stat), a same-day reopen that picks
// the history back up, a note_observation landing in the coach's memory, and
// a grant_access redirecting back to the site.
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

// Byte-identical to prompts.js's CHAT_OPEN_MARKER / CACHE_BREAK_MARKER core —
// deliberately hardcoded, so a drift in the shipped constants fails here.
const CHAT_OPEN_MARKER = '(user just opened the conversation)';
const CACHE_BREAK_RAW = '[[[intention:cache-break]]]';

// Scripted stub lines. Each is unique so "fully rendered" can be watched for
// without matching an earlier bubble.
const OPENER_REPLY = 'What are you hoping to get from it?';
const OBS_REPLY = 'Noted. Sounds like evenings are the pattern here — what is pulling you right now?';
const OBSERVATION = 'They tend to drift to example.com in the evenings.';
const PROBE_REPLY = 'A quick check of what, exactly?';
const GRANT_REPLY = 'Take five minutes for that and come straight back.';

const results = [];
const record = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  const mark = pass ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m';
  console.log(`${mark} ${name}${detail && !pass ? `\n    ${detail}` : ''}`);
};

// A stand-in for the coaching backend. Captures every request (plus when it
// answered, for the latency guards) so the test can assert on the system
// prompt, and answers in the hosted route's shape. `stub.replyFor(index,
// body)` scripts the reply for a given request index; null falls back to the
// default line.
function startBackendStub() {
  const received = [];
  const stub = { replyFor: null };
  return new Promise((resolveServer) => {
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        let parsed;
        try { parsed = JSON.parse(body); } catch (e) { parsed = { unparsed: body }; }
        const reply = (stub.replyFor && stub.replyFor(received.length, parsed)) || {
          text: OPENER_REPLY,
          toolCalls: [],
          balanceCredits: 100
        };
        received.push({ body: parsed, respondedAt: Date.now() });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(reply));
      });
    });
    server.listen(0, '127.0.0.1', () => {
      resolveServer({ server, stub, received, port: server.address().port });
    });
  });
}

// The client sends `system` as an ordered block array ([{text, cache:true},
// {text}]) so the backend can map blocks to provider caching; assertions on
// prompt CONTENT should not care, so join it back to one string.
const joinSystem = (system) => Array.isArray(system)
  ? system.map(b => (b && b.text) || '').join('\n')
  : String(system == null ? '' : system);

const lastMessage = (body) => {
  const msgs = (body && body.messages) || [];
  return msgs.length ? msgs[msgs.length - 1] : null;
};

async function waitFor(fn, timeoutMs, intervalMs = 50) {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) return null;
    await new Promise(r => setTimeout(r, intervalMs));
  }
}

// Resolves with a timestamp once an assistant bubble shows EXACTLY `expected`
// — i.e. the typewriter reveal has finished — or null on timeout.
async function watchRendered(page, expected, timeoutMs = 5000) {
  try {
    await page.waitForFunction(
      (t) => Array.from(document.querySelectorAll('.int-msg-assistant'))
        .some(el => el.textContent === t),
      expected,
      { polling: 30, timeout: timeoutMs }
    );
    return Date.now();
  } catch (e) {
    return null;
  }
}

async function main() {
  const { server, stub, received, port } = await startBackendStub();
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
    const gateUrlPrefix = `chrome-extension://${extensionId}/coaching.html`;

    // Configure it the way a set-up user's install looks, pointing the hosted
    // route at the local stub instead of the real backend. This page stays
    // open for the whole run: it is also the extension-page vantage point the
    // storage assertions (walk-away stat, coach observations) read from.
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

    // ── Visit 1: the actual moment under test — navigating to a blocked site.
    const page = await context.newPage();
    await page.goto('http://example.com/', { waitUntil: 'domcontentloaded' });
    await waitFor(() => page.url().startsWith(gateUrlPrefix), 4000);

    const landedOnGate = page.url().startsWith(gateUrlPrefix);
    record('a blocked site opens the coach instead of the page',
      landedOnGate, `url: ${page.url()}`);

    // Which path gated it matters for what follows. On the redirect path the
    // blocked page is never loaded, so no content script runs and nothing can
    // read its DOM — any page detail in the prompt must have been fetched by
    // the background. That is the case the generic metadata fetch exists for.
    console.log(`    (gated via the ${landedOnGate ? 'redirect' : 'content-script overlay'} path)`);

    // The coach speaks first now: the gate itself fires the opener chat (no
    // userMessage — the background records its own marker turn). Nothing is
    // typed here; if no request shows up, that IS the failure.
    const opened = await waitFor(() => received.length >= 1, 15000, 25);
    record('the gate opens the conversation by itself', Boolean(opened),
      `${received.length} request(s) after 15s`);

    // Start the render watch straight away — the latency guard below measures
    // from the stub's answer to the reveal finishing.
    const openerRenderedAt = opened ? await watchRendered(page, OPENER_REPLY, 5000) : null;

    const opener = received[0] || { body: {}, respondedAt: 0 };
    const openerLast = lastMessage(opener.body);
    record("the opener's final message is the open marker, not user text",
      openerLast?.role === 'user' && openerLast?.content === CHAT_OPEN_MARKER,
      `last message: ${JSON.stringify(openerLast)}`);

    const sysBlocks = opener.body.system;
    record('the system prompt travels as a cache-split block array',
      Array.isArray(sysBlocks) && sysBlocks.length === 2 &&
        sysBlocks[0]?.cache === true && typeof sysBlocks[1]?.text === 'string',
      `system: ${Array.isArray(sysBlocks)
        ? sysBlocks.map(b => JSON.stringify(Object.keys(b || {}))).join(' + ')
        : typeof sysBlocks}`);

    record('the raw cache-break marker never reaches the backend',
      !JSON.stringify(opener.body).includes(CACHE_BREAK_RAW));

    const system = joinSystem(sysBlocks);

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
      (opener.body.tools || []).some(t => t.name === 'grant_access'));

    // The quick check is retired. These two used to assert the lane was
    // offered and that the tool carried its flag; inverted, they are the
    // end-to-end proof that the removal reached the real prompt and the real
    // tool schema, not just the unit tests.
    record('the prompt no longer offers a quick-check lane',
      !system.includes('Quick check') && !system.includes('quick_check'),
      system.split('\n').find(l => l.toLowerCase().includes('quick check')) || '(absent)');

    record('the grant tool no longer carries a quick_check flag',
      (opener.body.tools || []).every(t => t.name !== 'grant_access' || !JSON.stringify(t).includes('quick_check')));

    record('the opener reply is fully rendered within 1s of the stub answering',
      openerRenderedAt != null && (openerRenderedAt - opener.respondedAt) < 1000,
      openerRenderedAt == null ? 'never finished rendering' : `${openerRenderedAt - opener.respondedAt}ms`);

    // Stats row: five cells now, walk-aways included.
    await waitFor(async () => (await page.locator('#int-stats-row .int-stat').count()) >= 1, 3000);
    const statCells = await page.locator('#int-stats-row .int-stat').count().catch(() => 0);
    const statLabels = await page.locator('#int-stats-row .int-stat-label').allTextContents().catch(() => []);
    record('the stats row shows five stats including walk-aways',
      statCells === 5 && statLabels.includes('Walked away (wk)'),
      `${statCells} cell(s), labels: ${JSON.stringify(statLabels)}`);

    // ── Walking away: the close button shows the affirmation moment, records
    // the walk-away, then closes the tab (via the background — window.close
    // can't close a tab a script didn't open).
    const closedPromise = page.waitForEvent('close', { timeout: 6000 })
      .then(() => Date.now()).catch(() => null);
    await page.locator('#int-close').click();
    const sawMoment = await page.locator('.int-walkaway')
      .waitFor({ state: 'visible', timeout: 2000 }).then(() => true).catch(() => false);
    record('closing the gate shows the walk-away moment', sawMoment);
    if (sawMoment) {
      // The moment is click-skippable; skip it so the run stays quick.
      await page.waitForTimeout(150);
      await page.mouse.click(200, 200).catch(() => {});
    }
    const closedAt = await closedPromise;
    record('walking away closes the tab', closedAt != null);

    const walkedAwayCount = await waitFor(() => settings.evaluate(async () => {
      const { dailyStats = {} } = await chrome.storage.local.get('dailyStats');
      const d = new Date();
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      return dailyStats[key]?.['example.com']?.walkedAway || null;
    }), 5000, 200);
    record("the walk-away lands in today's stats", walkedAwayCount === 1,
      `dailyStats walkedAway: ${JSON.stringify(walkedAwayCount)}`);

    // ── Visit 2: same day, so the transcript survives. The gate must re-gate,
    // replay the conversation instantly, and NOT burn another opener request.
    const page2 = await context.newPage();
    await page2.goto('http://example.com/', { waitUntil: 'domcontentloaded' });
    await waitFor(() => page2.url().startsWith(gateUrlPrefix), 4000);
    record('the site is gated again after walking away',
      page2.url().startsWith(gateUrlPrefix), `url: ${page2.url()}`);

    const reopenAt = Date.now();
    const historyRenderedAt = await watchRendered(page2, OPENER_REPLY, 3000);
    record('a same-day reopen replays the earlier conversation instantly',
      historyRenderedAt != null && (historyRenderedAt - reopenAt) < 1500,
      historyRenderedAt == null ? 'history never rendered' : `${historyRenderedAt - reopenAt}ms`);

    await page2.waitForTimeout(2000);
    record('a reopen with history fires no second opener request',
      received.length === 1, `${received.length} request(s)`);

    // Script the rest of the conversation: an observation, a probe, a grant.
    stub.replyFor = (i) => ({
      1: {
        text: OBS_REPLY,
        toolCalls: [{ id: 'toolu_obs_1', name: 'note_observation', input: { observation: OBSERVATION } }],
        balanceCredits: 99
      },
      2: { text: PROBE_REPLY, toolCalls: [], balanceCredits: 98 },
      3: {
        text: GRANT_REPLY,
        toolCalls: [{ id: 'toolu_grant_1', name: 'grant_access', input: { minutes: 5, reason: 'check one work thing' } }],
        balanceCredits: 97
      }
    })[i] || null;

    // Message 1: the coach notes an observation.
    await page2.locator('#int-input').fill('honestly I just drift here most evenings');
    await page2.keyboard.press('Enter');
    const second = (await waitFor(() => received.length >= 2, 15000, 25)) ? received[1] : null;
    record('a typed message reaches the backend', Boolean(second),
      `${received.length} request(s)`);
    const obsRenderedAt = second ? await watchRendered(page2, OBS_REPLY, 5000) : null;

    const system2 = joinSystem(second?.body.system);
    record('after a walk-away, the prompt tells the coach about it',
      system2.includes('walked away without taking any time'),
      system2.split('\n').find(l => l.includes('walked away')) || '(absent)');

    record('the chat reply is fully rendered within 1s of the stub answering',
      obsRenderedAt != null && second && (obsRenderedAt - second.respondedAt) < 1000,
      obsRenderedAt == null ? 'never finished rendering' : `${obsRenderedAt - second.respondedAt}ms`);

    const noted = await waitFor(() => settings.evaluate(async (text) => {
      const { coachObservations = [] } = await chrome.storage.local.get('coachObservations');
      return coachObservations.some(o => o && o.text === text) || null;
    }, OBSERVATION), 5000, 200);
    record("a note_observation tool call is saved to the coach's memory",
      noted === true);

    // Message 2: the saved observation must resurface in the next prompt.
    await page2.waitForTimeout(100);
    await page2.locator('#int-input').fill('just need to check one thing quickly');
    await page2.keyboard.press('Enter');
    const third = (await waitFor(() => received.length >= 3, 15000, 25)) ? received[2] : null;
    const system3 = joinSystem(third?.body.system);
    record("the saved observation reaches the next prompt as a thing noticed before",
      system3.includes("Things you've noticed before") && system3.includes(OBSERVATION),
      `has header: ${system3.includes("Things you've noticed before")}, has text: ${system3.includes(OBSERVATION)}`);
    if (third) await watchRendered(page2, PROBE_REPLY, 5000);

    // Message 3: a grant. The reply must render fast and the redirect must
    // follow promptly — this is the impulse moment, latency is product.
    await page2.waitForTimeout(100);
    await page2.locator('#int-input').fill('I need five minutes to check a work thing');
    await page2.keyboard.press('Enter');
    const fourth = (await waitFor(() => received.length >= 4, 15000, 25)) ? received[3] : null;
    const grantRenderedAt = fourth ? await watchRendered(page2, GRANT_REPLY, 5000) : null;
    record('the grant reply is fully rendered within 1s of the stub answering',
      grantRenderedAt != null && fourth && (grantRenderedAt - fourth.respondedAt) < 1000,
      grantRenderedAt == null ? 'never finished rendering' : `${grantRenderedAt - fourth.respondedAt}ms`);

    const redirectedAt = await page2.waitForURL(u => !u.href.startsWith('chrome-extension://'),
      { timeout: 4000, waitUntil: 'commit' })
      .then(() => Date.now()).catch(() => null);
    record('a granted pass redirects back to the site within 1.2s of the reply',
      redirectedAt != null && grantRenderedAt != null && (redirectedAt - grantRenderedAt) < 1200,
      redirectedAt == null ? `still at: ${page2.url()}` : `${redirectedAt - grantRenderedAt}ms`);
    record('the redirect lands on the granted site',
      /example\.com/.test(page2.url()), `url: ${page2.url()}`);

    record('exactly the four expected backend requests were made',
      received.length === 4, `${received.length} request(s)`);

    // Being able to read the real thing beats inferring it from assertions —
    // this is the only place the actual shipped prompt can be seen.
    if (process.argv.includes('--print-prompt')) {
      console.log('\n\x1b[1m─── system prompt as sent (opener, blocks joined) ───\x1b[0m\n');
      console.log(joinSystem(received[0]?.body?.system) || '(nothing captured)');
      console.log('\n\x1b[1m─────────────────────────────\x1b[0m');
    }

    if (HEADED) await page2.waitForTimeout(5000);
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
