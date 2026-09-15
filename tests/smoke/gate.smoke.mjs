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
const SCOPED_REPLY = 'That one page, twelve minutes, and the block comes back when you leave it.';

// The last path segment carries a dash so page_context.js derives a title from
// the slug ("Scoped Page One"), which is what the badge and the scope block
// both quote back.
const FIXTURE_ONE_PATH = '/scoped-page-one';

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

// A two-page site on a host we can actually block. The scoped-pass assertions
// need a real second page on the same origin AND a record of what was
// requested over the wire, because "the drift screen appeared without a
// network navigation" is half of what a page-scoped pass claims to do.
//
// Both paths carry a dashed last segment, so page_context.js derives a title
// from the slug without a metadata fetch: the labels below are then fixed
// strings the assertions can name, rather than whatever an HTML round trip
// happened to return.
const FIXTURE_ONE = FIXTURE_ONE_PATH;
const FIXTURE_TWO = '/scoped-page-two';

function startFixtureServer() {
  const requests = [];
  return new Promise((resolveServer) => {
    const server = createServer((req, res) => {
      const path = (req.url || '').split('?')[0];
      requests.push(path);
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><html><head><title>Fixture ${path}</title></head>` +
        `<body><h1>${path}</h1><p>Local fixture page.</p></body></html>`);
    });
    server.listen(0, '127.0.0.1', () => {
      resolveServer({ server, requests, port: server.address().port });
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
  const fixture = await startFixtureServer();
  // Reached as `localhost` rather than `127.0.0.1`: the blocklist keys on a
  // hostname, and the backend stub is addressed by IP, so the two never
  // collide and blocking one cannot take the coach offline.
  const fixtureOrigin = `http://localhost:${fixture.port}`;
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
          // One intended open, so the run can take it and then reach the coach.
          { action: 'saveSettings', config: { blockedDomains: ['example.com'], domainLimits: { 'example.com': { maxGrants: 1, passMinutes: 5 } } } },
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

    // ── Visit 0: an open is left, so the gate offers it — no conversation, no
    // request to the coach at all.
    const page0 = await context.newPage();
    await page0.goto('http://example.com/', { waitUntil: 'domcontentloaded' });
    await waitFor(() => page0.url().startsWith(gateUrlPrefix), 4000);
    record('a blocked site with an open left shows the intention gate',
      page0.url().startsWith(gateUrlPrefix), `url: ${page0.url()}`);
    const openButton = page0.getByRole('button', { name: 'Open for 5 minutes' });
    await openButton.waitFor({ timeout: 5000 });
    const countText = await page0.locator('#int-intention-count').textContent({ timeout: 5000 }).catch(() => '');
    record('the gate says which open this is and how long it lasts',
      /Open 1 of 1 today/.test(countText || '') && /5 min/.test(countText || ''), JSON.stringify(countText));
    record('the intended open requires a reason', await openButton.isDisabled());
    await page0.getByPlaceholder('Give a specific reason').fill('Read the event details');
    await openButton.click();
    await waitFor(() => !page0.url().startsWith(gateUrlPrefix), 5000);
    record('taking the open lets the page through', !page0.url().startsWith(gateUrlPrefix), `url: ${page0.url()}`);
    const badgeReason = await page0.locator('#intention-badge-reason').textContent({ timeout: 3000 }).catch(() => '');
    record('the floating window keeps the stated reason visible', badgeReason === 'Reason: Read the event details', JSON.stringify(badgeReason));
    record('a free open never reaches the coach', received.length === 0, `${received.length} request(s)`);
    const opened0 = await settings.evaluate(async () => {
      const { dailyStats = {} } = await chrome.storage.local.get('dailyStats');
      const d = new Date();
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      return dailyStats[key]?.['example.com'] || null;
    });
    record('the open is counted, and not as negotiated',
      opened0?.grants === 1 && !opened0?.negotiated, JSON.stringify(opened0));
    record('the open records the user-given reason', opened0?.sessions?.[0]?.reason === 'Read the event details', JSON.stringify(opened0?.sessions));
    await page0.close();
    // End the pass so the next visit gates again.
    await settings.evaluate(async () => {
      await chrome.storage.local.set({ activeSessions: {} });
      await new Promise(done => chrome.runtime.sendMessage({ action: 'saveSettings', config: { blockedDomains: ['example.com'] } }, done));
    });
    await settings.waitForTimeout(500);

    // ── Visit 1: the intention is spent. The gate offers the coach, and only
    // tapping it starts a conversation.
    const page = await context.newPage();
    await page.goto('http://example.com/', { waitUntil: 'domcontentloaded' });
    await waitFor(() => page.url().startsWith(gateUrlPrefix), 4000);

    const landedOnGate = page.url().startsWith(gateUrlPrefix);
    record('a blocked site with its intention spent is gated',
      landedOnGate, `url: ${page.url()}`);
    await page.waitForTimeout(800);
    record('the spent gate starts no conversation on its own', received.length === 0, `${received.length} request(s)`);
    await page.getByRole('button', { name: 'Ask the coach' }).click();

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
    await page2.getByRole('button', { name: 'Ask the coach' }).click({ timeout: 5000 }).catch(() => {});

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

    // ── Page-scoped passes ────────────────────────────────────────────────
    //
    // A pass for ONE page rather than the whole site. Everything about it is
    // only true if two things hold at once: the domain's redirect rule stays
    // in place (so every other page still gates), and the content script
    // notices an in-page navigation that makes no network request at all (so
    // an autoplay into the next video ends the pass). Neither can be checked
    // anywhere but here — the vm suite has no rule store and no navigation.
    await settings.evaluate(async () => {
      await new Promise((done) => {
        chrome.runtime.sendMessage(
          { action: 'saveSettings', config: { blockedDomains: ['example.com', 'localhost'], domainLimits: { 'example.com': { maxGrants: 0 }, localhost: { maxGrants: 0 } } } },
          () => done()
        );
      });
    });

    let scopedRules = [];
    for (let attempt = 0; attempt < 20 && !scopedRules.includes('||localhost^'); attempt++) {
      await settings.waitForTimeout(250);
      scopedRules = await worker.evaluate(async () => {
        const dynamic = await chrome.declarativeNetRequest.getDynamicRules();
        return dynamic.map(r => r.condition?.urlFilter);
      });
    }
    record('the local fixture host is blocked like any other site',
      scopedRules.includes('||localhost^'), `rules: ${JSON.stringify(scopedRules)}`);

    // One exchange, which is what the scope guidance tells the coach a named
    // destination deserves.
    stub.replyFor = (i) => (i >= 4 ? {
      text: SCOPED_REPLY,
      toolCalls: [{
        id: 'toolu_scope_1',
        name: 'grant_access',
        input: { minutes: 12, reason: 'someone sent me this', scope: 'page' }
      }],
      balanceCredits: 96
    } : null);

    const scopedPage = await context.newPage();
    // A query string on the granted address, deliberately: the narrowed allow
    // rule is built from it, and whether the rule store accepts a urlFilter
    // carrying one is the thing this run has to settle.
    const grantedUrl = `${fixtureOrigin}${FIXTURE_ONE}?v=one`;
    await scopedPage.goto(grantedUrl, { waitUntil: 'domcontentloaded' });
    await waitFor(() => scopedPage.url().startsWith(gateUrlPrefix), 4000);
    record('the fixture page opens the coach',
      scopedPage.url().startsWith(gateUrlPrefix), `url: ${scopedPage.url()}`);
    await scopedPage.getByRole('button', { name: 'Ask the coach' }).click({ timeout: 5000 }).catch(() => {});

    const scopedOpened = await waitFor(() => received.length >= 5, 15000, 25);
    record('the scoped gate opens a conversation', Boolean(scopedOpened),
      `${received.length} request(s)`);

    const scopedSystem = joinSystem(received[4]?.body.system);
    record('the prompt offers the coach a page-scoped pass',
      scopedSystem.includes('grant_access with scope "page"'),
      scopedSystem.split('\n').find(l => l.includes('scope "page"')) || '(absent)');

    // Below the cache break and after the closing fence: inside the fence, the
    // page could pass its own text off as part of the rules about how easily
    // to let it through.
    record('the scope block lands after the untrusted page data fence',
      scopedSystem.lastIndexOf('</untrusted_page_data>') > -1 &&
      scopedSystem.indexOf('Scoped passes (these are facts') > scopedSystem.lastIndexOf('</untrusted_page_data>'));

    record('the grant tool carries the scope enum and does not require it',
      (received[4]?.body.tools || []).some(t => t.name === 'grant_access' &&
        JSON.stringify(t.schema?.properties?.scope?.enum) === '["page","site"]' &&
        !(t.schema?.required || []).includes('scope')));

    const backOnFixture = await scopedPage.waitForURL(
      u => u.href.startsWith(fixtureOrigin), { timeout: 6000, waitUntil: 'commit' }
    ).then(() => true).catch(() => false);
    record('a scoped grant lands on the exact page it was granted for',
      backOnFixture && scopedPage.url() === grantedUrl, `url: ${scopedPage.url()}`);

    // The badge has to say what the pass is FOR. "The block came back" a
    // minute later only reads as intended behaviour if this line was there.
    const badgeText = await waitFor(
      () => scopedPage.locator('#intention-badge').textContent().catch(() => null),
      6000, 100
    );
    record('the badge says the pass is for this page only',
      Boolean(badgeText) && /this page only/i.test(badgeText), `badge: ${badgeText}`);
    record('the badge names the page the pass was granted for',
      Boolean(badgeText) && /Scoped page one/i.test(badgeText), `badge: ${badgeText}`);

    // The rule above only survives on an engine background.js is willing to
    // trust with the ordering "priority-2 allow beats priority-1 redirect" —
    // and this is the browser where that ordering is actually exercised, so the
    // answer here has to be yes. It is asserted separately from the rule
    // itself because the first version of the detector ("Chromium is the
    // runtime with no `browser` namespace") was wrong — Chrome exposes
    // `browser` as an alias of `chrome` — and it reported THIS browser as
    // unverified, silently degrading every scoped pass to a site pass. Only
    // the check below can tell that apart from a rule that failed to register.
    const engineTrusted = await worker.evaluate(() => ({
      trusted: allowOutranksRedirect(),
      hasBrowserNamespace: typeof browser !== 'undefined'
    }));
    record('the engine this suite runs on is one the redirect logic trusts',
      engineTrusted.trusted === true, JSON.stringify(engineTrusted));

    // THE assertion. A scoped pass that dropped this rule would silently open
    // the whole site while the badge above said otherwise.
    const rulesDuringPass = await worker.evaluate(async () => {
      const dynamic = await chrome.declarativeNetRequest.getDynamicRules();
      return dynamic.map(r => `${r.condition?.urlFilter} ${r.action?.type}`);
    });
    record('the domain redirect rule is STILL registered during a scoped pass',
      rulesDuringPass.includes('||localhost^ redirect'),
      `dynamic rules: ${JSON.stringify(rulesDuringPass)}`);

    // The other half of the same mechanism: the per-tab allow rule has to be
    // narrowed to the granted address, or it would let the whole domain past
    // the redirect rule above.
    const sessionRules = await worker.evaluate(async () => {
      const rules = await chrome.declarativeNetRequest.getSessionRules();
      return rules.map(r => ({ filter: r.condition?.urlFilter, type: r.action?.type }));
    });
    const narrowed = sessionRules.find(r => r.type === 'allow' && r.filter && r.filter.includes(FIXTURE_ONE_PATH));
    record('the session allow rule was narrowed to the granted page',
      Boolean(narrowed), `session rules: ${JSON.stringify(sessionRules)}`);
    // If this one fails, dnrUrlFilterFor must return '' for query-bearing
    // URLs and enforcement falls back to the content script alone — which is
    // already how Safari enforces every pass, but it should be known.
    record('the rule store accepted a urlFilter carrying a query string',
      Boolean(narrowed && narrowed.filter.includes('?v=one')),
      `narrowed filter: ${narrowed ? narrowed.filter : '(none)'}`);

    // The navigation nobody sees: pushState makes no request, commits nothing
    // and re-injects no content script. It is exactly what a YouTube autoplay
    // into the next video is, and catching it is the whole point.
    // Favicon requests are the browser's, not the navigation's, so they are
    // not what "no network navigation" is about.
    const pageRequests = () => fixture.requests.filter(r => r !== '/favicon.ico');
    const requestsBefore = pageRequests().length;
    await scopedPage.evaluate((next) => {
      history.pushState({}, '', next);
    }, `${FIXTURE_TWO}?v=two`);

    const driftSeen = await scopedPage.locator('#intention-root')
      .filter({ hasText: 'That pass was for one page' })
      .waitFor({ state: 'visible', timeout: 2500 })
      .then(() => true).catch(() => false);
    record('an in-page navigation off the granted page shows the drift screen',
      driftSeen, `url: ${scopedPage.url()}`);

    record('and it did so with no network navigation at all',
      pageRequests().length === requestsBefore &&
      !fixture.requests.includes(FIXTURE_TWO),
      `fixture requests: ${JSON.stringify(fixture.requests)}`);

    record('the drift screen is not a second coach conversation',
      received.length === 5, `${received.length} request(s)`);

    // ── Part rules: only some of a site is blocked ────────────────────────
    //
    // Two things can only be checked here. First, a host carrying a part rule
    // has to LEAVE the blanket redirect list — a `||host^` urlFilter cannot
    // see a path, so it would redirect the sections the user explicitly left
    // open. Second, once it has left, the gate backstop is the thing most
    // likely to undo the feature: an allowed page never reports an overlay,
    // because there is nothing to report, and a backstop that read that as a
    // failure would navigate every allowed page to the coach three seconds in.
    // Only a real browser waits three real seconds.
    stub.replyFor = null;
    await settings.evaluate(async () => {
      // The scoped pass from the section above is still live and would show a
      // badge instead of a gate on the pages below.
      //
      // The rule itself is seeded straight into storage — the state a coach
      // conversation would have left behind — and only then saved through
      // saveSettings. saveSettings will not WIDEN a part rule (see
      // holdPartRuleDirection in background.js: carving a section out of a
      // fully blocked host leaves less of it blocked, and every loosening goes
      // through the coach), so a test that arrived here by sending the new rule
      // cold would be testing the guard rather than the redirect. Saving it a
      // second time is what this section is actually about: the write has to
      // re-sync the rules.
      const rule = { localhost: { maxGrants: 3, maxMinutes: 45, scope: 'only', parts: ['path:/blocked/*'] } };
      await chrome.storage.local.set({ activeSessions: {}, domainLimits: rule });
      await new Promise((done) => {
        chrome.runtime.sendMessage({
          action: 'saveSettings',
          config: { blockedDomains: ['example.com', 'localhost'], domainLimits: rule }
        }, () => done());
      });
    });

    const rulesFor = async () => worker.evaluate(async () => {
      const dynamic = await chrome.declarativeNetRequest.getDynamicRules();
      return dynamic.map(r => `${r.condition?.urlFilter} ${r.action?.type} p${r.priority}`);
    });

    let partRules = [];
    for (let attempt = 0; attempt < 20; attempt++) {
      partRules = await rulesFor();
      if (!partRules.some(r => r.startsWith('||localhost^'))) break;
      await settings.waitForTimeout(250);
    }
    record('a host with a part rule drops out of the blanket redirect',
      !partRules.some(r => r.startsWith('||localhost^')), `rules: ${JSON.stringify(partRules)}`);
    record('and a host without one keeps its rule',
      partRules.some(r => r.startsWith('||example.com^')), `rules: ${JSON.stringify(partRules)}`);

    const partPage = await context.newPage();
    await partPage.goto(`${fixtureOrigin}/allowed-page`, { waitUntil: 'domcontentloaded' });
    // Longer than GATE_BACKSTOP_GRACE_MS (3s) on purpose: the backstop firing
    // here is the failure this wait exists to catch.
    await partPage.waitForTimeout(4000);
    record('an address the rule leaves open is not gated at all',
      partPage.url().startsWith(fixtureOrigin) &&
      (await partPage.locator('#intention-root').count()) === 0,
      `url: ${partPage.url()}`);

    const requestsBeforeBlockedPart = fixture.requests.length;
    await partPage.goto(`${fixtureOrigin}/blocked/one`, { waitUntil: 'domcontentloaded' });
    const partGated = await waitFor(
      async () => (await partPage.locator('#intention-root').count()) > 0, 6000);
    record('the part the rule names is gated', Boolean(partGated), `url: ${partPage.url()}`);
    // Via the overlay, not a redirect: the page itself loaded, which is what a
    // sectioned host trades for being able to see the path at all. This is
    // already how Safari gates every blocked site.
    record('and it is gated by the overlay, on the page itself',
      partPage.url().startsWith(fixtureOrigin) &&
      fixture.requests.length > requestsBeforeBlockedPart,
      `url: ${partPage.url()}`);

    // The SPA case, which is the single test that proves the whole watcher
    // design: no request, no commit, no re-injected content script.
    const spaPage = await context.newPage();
    await spaPage.goto(`${fixtureOrigin}/allowed-page`, { waitUntil: 'domcontentloaded' });
    // The poll skips a hidden tab by design, and every page this run has left
    // open is a tab. Foreground it the way the user would.
    await spaPage.bringToFront();
    await spaPage.waitForTimeout(1000);
    const spaRequestsBefore = fixture.requests.filter(r => r !== '/favicon.ico').length;
    await spaPage.evaluate(() => { history.pushState({}, '', '/blocked/two'); });
    const spaGated = await waitFor(
      async () => (await spaPage.locator('#intention-root').count()) > 0, 3000);
    record('an in-page navigation onto a blocked part gates within a second or two',
      Boolean(spaGated), `url: ${spaPage.url()}`);
    record('and it did so with no network navigation at all',
      fixture.requests.filter(r => r !== '/favicon.ico').length === spaRequestsBefore &&
      !fixture.requests.includes('/blocked/two'),
      `fixture requests: ${JSON.stringify(fixture.requests.slice(-4))}`);

    // ── The other scope: everything except the parts named ────────────────
    //
    // Seeded and then saved, for the reason given at the top of this section:
    // 'only' -> 'except' is not comparable by list membership, so parts.js
    // answers "unprovable" and saveSettings refuses to make the change on its
    // own. What is under test here is the verdict, not the gate.
    await settings.evaluate(async () => {
      const rule = { localhost: { maxGrants: 3, maxMinutes: 45, scope: 'except', parts: ['path:/allowed*'] } };
      await chrome.storage.local.set({ activeSessions: {}, domainLimits: rule });
      await new Promise((done) => {
        chrome.runtime.sendMessage({
          action: 'saveSettings',
          config: { domainLimits: rule }
        }, () => done());
      });
    });
    await settings.waitForTimeout(500);

    const exceptPage = await context.newPage();
    await exceptPage.goto(`${fixtureOrigin}/allowed-page`, { waitUntil: 'domcontentloaded' });
    await exceptPage.waitForTimeout(4000);
    record('under an except rule the excepted path is not redirected and not gated',
      exceptPage.url().startsWith(fixtureOrigin) &&
      (await exceptPage.locator('#intention-root').count()) === 0,
      `url: ${exceptPage.url()}`);

    await exceptPage.goto(`${fixtureOrigin}/anything-else`, { waitUntil: 'domcontentloaded' });
    const exceptGated = await waitFor(
      async () => (await exceptPage.locator('#intention-root').count()) > 0, 6000);
    record('and everything outside the exception is gated',
      Boolean(exceptGated), `url: ${exceptPage.url()}`);

    // ── v1.5 probe: could an `except` rule keep its redirect after all? ────
    //
    // v1 takes a sectioned host off the redirect entirely. v1.5 would keep the
    // redirect and add one priority-3 `allow` rule per exception, which removes
    // the page flash on the commonest shape ("block Reddit except r/rust") —
    // but only if a higher-priority allow really does beat a lower-priority
    // redirect in Chromium's matcher. That is the whole of the go/no-go, and
    // it is answered here rather than assumed. Nothing below changes what the
    // extension ships; the probe rules are added and removed by hand.
    await settings.evaluate(async () => {
      await new Promise((done) => {
        chrome.runtime.sendMessage({
          action: 'saveSettings',
          config: { domainLimits: {} }
        }, () => done());
      });
    });
    let restored = [];
    for (let attempt = 0; attempt < 20; attempt++) {
      restored = await rulesFor();
      if (restored.some(r => r.startsWith('||localhost^'))) break;
      await settings.waitForTimeout(250);
    }
    record('removing a part rule puts the redirect back',
      restored.some(r => r.startsWith('||localhost^')), `rules: ${JSON.stringify(restored)}`);

    const probeAccepted = await worker.evaluate(async () => {
      try {
        await chrome.declarativeNetRequest.updateDynamicRules({
          addRules: [{
            id: 5001,
            priority: 3,
            action: { type: 'allow' },
            condition: { urlFilter: '/allowed-page', resourceTypes: ['main_frame'] }
          }]
        });
        return 'accepted';
      } catch (e) {
        return String((e && e.message) || e);
      }
    });
    record('[v1.5 probe] the rule store accepts a priority-3 allow beside a redirect',
      probeAccepted === 'accepted', probeAccepted);

    const probePage = await context.newPage();
    await probePage.goto(`${fixtureOrigin}/allowed-page`, { waitUntil: 'domcontentloaded' }).catch(() => {});
    const allowBeatRedirect = probePage.url().startsWith(fixtureOrigin);
    // The overlay may still cover the page afterwards — that is the content
    // script doing its job. The question here is only whether the request was
    // allowed to reach the network at all.
    record('[v1.5 probe] a higher-priority allow beats a lower-priority redirect',
      allowBeatRedirect, `url: ${probePage.url()}`);
    await worker.evaluate(async () => {
      await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: [5001] });
    });
    await probePage.close();

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
    fixture.server.close();
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
