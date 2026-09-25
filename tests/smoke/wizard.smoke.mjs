// End-to-end smoke test: walking the real setup wizard in a real Chromium,
// against the real unpacked extension.
//
// The vm tests in tests/ can tell you computeStepOrder returns the right list.
// They cannot tell you that showStep reveals the right section, that a section
// reused for N services actually repaints between them, that a draft written
// on step 6 comes back to step 6, or that the answers survive Finish and reach
// storage. Those are the questions this answers, by clicking Next.
//
// Run: node tests/smoke/wizard.smoke.mjs [--headed]

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

// Which section is actually on screen, and what the counter claims. Read
// together because the bug worth catching is them disagreeing.
const visibleStep = (page) => page.evaluate(() => {
  const shown = [...document.querySelectorAll('.setup-step')].filter(s => !s.hidden);
  return {
    ids: shown.map(s => s.id),
    title: shown[0]?.querySelector('h3')?.textContent || '',
    label: document.getElementById('setup-progress-label').textContent
  };
});

const next = async (page) => {
  await page.click('#setup-next-btn');
  await page.waitForTimeout(60);
};

// ── Every page fits a phone, without the page scrolling.
//
// The setup is a fixed-height column (see #setup-view in options.css): the
// document never scrolls, the nav is always on screen, and only a page's
// .setup-scroll region may scroll when its content outgrows the space. Walked
// at three phone sizes — a tall one, a common one, and a short one where the
// type has to tighten — with the Android app bridge faked so the apps page is
// part of the walk, and with the worst cases filled in: a long pick list, the
// catalogue expanded, every note and second question on a purpose page open.
const PHONES = [[360, 740], [412, 915], [360, 640]];

const fakeAndroidApps = () => {
  const installed = [
    ['com.instagram.android', 'Instagram'], ['com.zhiliaoapp.musically', 'TikTok'],
    ['com.google.android.youtube', 'YouTube'], ['com.twitter.android', 'X'],
    ['com.reddit.frontpage', 'Reddit'], ['com.facebook.katana', 'Facebook'],
    ['com.snapchat.android', 'Snapchat'], ['com.pinterest', 'Pinterest'],
    ['com.linkedin.android', 'LinkedIn'], ['com.netflix.mediaclient', 'Netflix']
  ].map(([packageName, label]) => ({ packageName, label }));
  window.intentionApps = {
    getInstalledApps: (cb) => setTimeout(() => cb(installed), 0),
    launchApp() {},
    hasUsageAccess: () => false,
    requestUsageAccess() {},
    getAppUsageStats: (days, cb) => cb({})
  };
};

const measureFit = (page) => page.evaluate(() => {
  const shown = [...document.querySelectorAll('.setup-step')].find(s => !s.hidden);
  const buttons = [...document.querySelectorAll('.setup-nav button')].filter(b => !b.hidden);
  return {
    id: shown?.id,
    scrollHeight: document.scrollingElement.scrollHeight,
    innerHeight,
    // The page box is allowed to scroll only as a last resort (a landscape
    // phone with the keyboard up); on these sizes it must not have to.
    pageOverflow: shown ? shown.scrollHeight - shown.clientHeight : 0,
    navOnScreen: buttons.length > 0 && buttons.every(b => {
      const r = b.getBoundingClientRect();
      return r.top >= 0 && r.bottom <= innerHeight + 0.5;
    })
  };
});

async function checkFitsOnPhones(context, optionsUrl) {
  for (const [width, height] of PHONES) {
    const page = await context.newPage();
    await page.setViewportSize({ width, height });
    await page.addInitScript(fakeAndroidApps);
    await page.goto(optionsUrl);
    // The previous size left a draft on the done page. Clearing while this
    // load is still restoring it lets the restore write it straight back, so
    // wait for the restore to settle, then clear until a load opens on welcome.
    // (The first load may be settings rather than setup, so no selector here.)
    await page.waitForLoadState('load');
    for (let attempt = 0; attempt < 5; attempt++) {
      await page.waitForTimeout(600); // past the draft debounce
      await page.evaluate(() => chrome.storage.local.clear());
      await page.reload();
      await page.waitForSelector('#setup-view:not([hidden])');
      if ((await visibleStep(page)).ids.join() === 'setup-step-welcome') break;
    }

    const fits = async (what) => {
      await page.waitForTimeout(350); // entrance animation and async renders
      const m = await measureFit(page);
      record(`${width}×${height}: ${what} fits without the page scrolling`,
        m.scrollHeight <= m.innerHeight && m.pageOverflow <= 1 && m.navOnScreen,
        JSON.stringify(m));
    };
    const tapNext = async () => { await page.click('#setup-next-btn'); await page.waitForTimeout(80); };

    await fits('welcome');
    await tapNext();
    await fits('apps, empty');
    for (const label of ['Instagram', 'TikTok', 'YouTube', 'Reddit']) {
      await page.locator('#setup-apps-recommend-grid .recommend-card', { hasText: label }).first().click();
      await page.waitForTimeout(120);
    }
    const appsMore = page.locator('#setup-apps-recommend-more');
    if (await appsMore.isVisible()) await appsMore.click();
    await fits('apps, four picked');
    await tapNext();
    await page.evaluate(async () => {
      for (const d of ['instagram.com', 'reddit.com', 'youtube.com', 'x.com', 'some-very-long-blog-name.example']) {
        await addDomainToBlocklist(d);
      }
    });
    const sitesMore = page.locator('#setup-sites-recommend-more');
    if (await sitesMore.isVisible()) await sitesMore.click();
    await fits('sites, five picked and the catalogue expanded');
    await tapNext();
    await fits('an intention');
    await page.click('#setup-intention-same-btn');
    await page.waitForTimeout(100);
    await fits('the reasons question');
    await page.click('#setup-reasons-yes-btn');
    await fits('a purpose page');
    for (const sel of ['.setup-service-note-toggle', '.setup-reason-more-toggle']) {
      const toggles = page.locator(`#setup-step-purpose ${sel}`);
      const count = await toggles.count();
      for (let i = 0; i < count; i++) {
        if (await toggles.nth(i).isVisible()) await toggles.nth(i).click();
      }
    }
    await fits('a purpose page with every note open');
    await page.click('#setup-purpose-skip-btn');
    await fits('access');
    await tapNext();
    await fits('done, with every intention listed');
    await page.close();
  }
}

async function main() {
  const profile = await mkdtemp(join(tmpdir(), 'intention-wizard-'));
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

    const page = await context.newPage();
    await page.goto(optionsUrl);
    await page.evaluate(() => chrome.storage.local.clear());
    await page.reload();
    await page.waitForSelector('#setup-view:not([hidden])');

    // ── The wizard opens on welcome, and says what is coming.
    let step = await visibleStep(page);
    record('opens on the welcome page', step.ids.join() === 'setup-step-welcome', JSON.stringify(step));
    record('and labels it with the name, not a step count', step.label === 'Intention', step.label);
    record('the first button says Begin', (await page.textContent('#setup-next-btn')) === 'Begin');

    const agenda = await page.textContent('#setup-welcome-checklist');
    record('the agenda says past an intention the coach decides',
      /Past that, the coach decides/.test(agenda), agenda.slice(0, 200));

    // ── Pick. Nothing picked means nowhere to go.
    await next(page);
    step = await visibleStep(page);
    record('reaches the pick page', step.ids.join() === 'setup-step-sites', JSON.stringify(step));
    record('Continue waits for something to be picked',
      await page.locator('#setup-next-btn').isDisabled());

    await page.evaluate(async () => {
      await addDomainToBlocklist('instagram.com');
      await addDomainToBlocklist('some-blog.example');
    });
    await page.waitForTimeout(80);
    record('the pick rows carry no settings of their own',
      (await page.locator('#setup-websites-list .intention-field').count()) === 0);
    record('and Continue is live once something is picked',
      !(await page.locator('#setup-next-btn').isDisabled()));
    step = await visibleStep(page);
    record('picking does not move the page you are on', step.ids.join() === 'setup-step-sites', JSON.stringify(step));

    // ── One intention page per site.
    await next(page);
    step = await visibleStep(page);
    record('the first intention page asks about Instagram by name',
      step.ids.join() === 'setup-step-intention' && step.title === 'How much time a day do you want for Instagram?',
      JSON.stringify(step));
    record('and counts only the intention pages', step.label === 'Intentions · 1 of 2', step.label);
    const startDraft = await page.evaluate(() => setupDomainLimits['instagram.com']);
    record('it starts at the default of 30 minutes a day',
      startDraft?.intentionMode === 'dailyTime' && startDraft?.dailyTimeMinutes === 30, JSON.stringify(startDraft));

    await page.click('#setup-intention-mode [data-mode="dailyTime"]');
    await page.locator('#setup-intention-daily input').fill('60');
    await page.locator('#setup-intention-daily input').dispatchEvent('change');
    await page.locator('#setup-intention-daily .stepper-btn').last().click();
    const oneMinuteMore = await page.evaluate(() => setupDomainLimits['instagram.com'].dailyTimeMinutes);
    record('daily minute plus adjusts by exactly one minute', oneMinuteMore === 61, String(oneMinuteMore));
    await page.locator('#setup-intention-daily .stepper-btn').first().click();
    await page.click('#setup-intention-mode [data-mode="dailyTime"]');
    const timeDraft = await page.evaluate(() => setupDomainLimits['instagram.com']);
    record('can choose a daily time allowance instead of visit count',
      timeDraft?.intentionMode === 'dailyTime' && timeDraft?.dailyTimeMinutes === 60,
      JSON.stringify(timeDraft));
    record('the daily allowance hides the visit counter',
      await page.locator('#setup-step-intention .setup-counter').isHidden());
    await page.click('#setup-intention-mode [data-mode="opens"]');
    for (let i = 0; i < 3; i++) await page.click('#setup-intention-minus');

    await page.click('#setup-intention-plus');
    await page.locator('#setup-intention-minutes input').fill('15');
    await page.locator('#setup-intention-minutes input').dispatchEvent('change');
    await page.locator('#setup-intention-minutes .stepper-btn').last().click();
    const visitMinuteMore = await page.evaluate(() => setupDomainLimits['instagram.com'].passMinutes);
    record('visit minute plus adjusts by exactly one minute', visitMinuteMore === 16, String(visitMinuteMore));
    await page.locator('#setup-intention-minutes .stepper-btn').first().click();
    await page.waitForTimeout(80);
    const drafted = await page.evaluate(() => setupDomainLimits['instagram.com']);
    record('plus and custom minutes land in the draft',
      drafted?.maxGrants === 4 && drafted?.passMinutes === 15, JSON.stringify(drafted));
    const sum = await page.textContent('#setup-intention-sum');
    record('and the line underneath adds it up as a day', /Up to 60 minutes a day, in four visits/.test(sum), sum);
    record('offers to use it for the last one',
      (await page.textContent('#setup-intention-same-btn')) === 'Use this for the last one too');

    await next(page);
    step = await visibleStep(page);
    record('the second intention page is the hand-typed site',
      step.title === 'How much time a day do you want for some-blog.example?', step.title);
    record('and its count moved within the run', step.label === 'Intentions · 2 of 2', step.label);
    record('the last intention page offers no "use this for the rest"',
      await page.locator('#setup-intention-same-btn').isHidden());

    // New targets start on daily minutes; 30 of them become three visits.
    await page.click('#setup-intention-mode [data-mode="opens"]');
    record('switching to visits turns 30 minutes into three',
      (await page.textContent('#setup-intention-opens')) === '3');
    // Zero opens is a block, and the minutes question goes away with it.
    for (let i = 0; i < 3; i++) await page.click('#setup-intention-minus');
    await page.waitForTimeout(60);
    record('down to zero says not at all', (await page.textContent('#setup-intention-unit')) === 'not at all');
    record('and hides how long each time', await page.locator('#setup-intention-minutes-wrap').isHidden());
    record('and minus stops there', await page.locator('#setup-intention-minus').isDisabled());
    await page.click('#setup-intention-plus');
    await page.waitForTimeout(40);

    // ── The purpose pages are an offer.
    await next(page);
    step = await visibleStep(page);
    record('then asks whether to say what each one is for',
      step.ids.join() === 'setup-step-reasons', JSON.stringify(step));
    record('with the two answers as the only way on', await page.locator('#setup-next-btn').isHidden());

    await page.click('#setup-reasons-yes-btn');
    await page.waitForTimeout(80);
    step = await visibleStep(page);
    record('a yes opens one page per service',
      step.ids.join() === 'setup-step-purpose' && step.title === 'When is opening Instagram fair enough?',
      JSON.stringify(step));
    record('counting only the purpose pages', step.label === 'Purpose · 1 of 2', step.label);

    const chip = (service, bucket, id) =>
      page.locator(`[data-service="${service}"] [data-bucket="${bucket}"][data-chip="${id}"]`);
    const preview = (service) => page.textContent(`[data-service="${service}"] .setup-service-preview`);
    const noteToggle = (service, i) =>
      page.locator(`[data-service="${service}"] .setup-service-note-toggle`).nth(i);
    const note = (service, i) =>
      page.locator(`[data-service="${service}"] .setup-service-note`).nth(i);

    await chip('instagram.com', 'needs', 'dm').click();
    await page.waitForTimeout(60);
    record('tapping a chip presses it',
      (await chip('instagram.com', 'needs', 'dm').getAttribute('aria-pressed')) === 'true');
    record('and rewrites the preview into what the coach will do',
      (await preview('instagram.com')) === 'Your coach will hear you out for a DM reply, and push back on the feed, Reels and Explore.',
      await preview('instagram.com'));

    // The phone case that used to lose the answer: a chip tap that does not
    // move focus off a half-typed note repaints the page around it.
    await noteToggle('instagram.com', 0).click();
    await note('instagram.com', 0).click();
    await note('instagram.com', 0).pressSequentially('Only my sister messages, never the feed');
    await chip('instagram.com', 'needs', 'sent').dispatchEvent('click');
    await page.waitForTimeout(60);
    record('a chip tapped with the keyboard still up does not wipe the note',
      (await note('instagram.com', 0).inputValue()) === 'Only my sister messages, never the feed');
    await note('instagram.com', 0).fill('A specific reply. Never the feed.');
    await note('instagram.com', 0).blur();

    // The second question is folded away until asked for.
    record('why it is on the list is folded away at first',
      await page.locator('[data-service="instagram.com"] .setup-reason-more').isHidden());
    await page.click('[data-service="instagram.com"] .setup-reason-more-toggle');
    await noteToggle('instagram.com', 1).click();
    await note('instagram.com', 1).fill('DMs from my sister.');
    await note('instagram.com', 1).blur();
    await page.waitForTimeout(60);

    // ── The draft round-trip lands on the same page, for the same service.
    await page.reload();
    await page.waitForSelector('#setup-view:not([hidden])');
    await page.waitForTimeout(200);
    step = await visibleStep(page);
    record('a reload returns to the same purpose page',
      step.title === 'When is opening Instagram fair enough?', JSON.stringify(step));
    record('the chip tapped before the reload is still pressed',
      (await chip('instagram.com', 'needs', 'dm').getAttribute('aria-pressed')) === 'true');
    record('and the folded question stays open because it has an answer',
      await page.locator('[data-service="instagram.com"] .setup-reason-more').isVisible());

    await next(page);
    step = await visibleStep(page);
    record('the next purpose page is the hand-typed site',
      step.title === 'When is opening some-blog.example fair enough?', step.title);

    await chip('some-blog.example', 'needs', 'sent').click();
    await chip('some-blog.example', 'needs', 'none').click();
    await page.waitForTimeout(60);
    record('the "nothing" chip clears the reasons beside it',
      (await chip('some-blog.example', 'needs', 'sent').getAttribute('aria-pressed')) === 'false');
    record('and swaps the preview to starting from no',
      /start every visit from no/.test(await preview('some-blog.example')));
    await chip('some-blog.example', 'needs', 'none').click();
    await page.click('[data-service="some-blog.example"] .setup-reason-more-toggle');
    await noteToggle('some-blog.example', 1).click();
    await note('some-blog.example', 1).fill('Reading one author.');
    await note('some-blog.example', 1).blur();
    await page.waitForTimeout(60);

    // ── More time, then done.
    await next(page);
    step = await visibleStep(page);
    record('explains what happens past an intention',
      step.ids.join() === 'setup-step-access', JSON.stringify(step));

    await next(page);
    step = await visibleStep(page);
    record('ends on the ready page', step.ids.join() === 'setup-step-done', JSON.stringify(step));
    const rules = await page.locator('#setup-done-list li').allTextContents();
    record('which reads every intention back',
      rules.length === 2 && rules[0].includes('4 × 15 min') && rules[1].includes('1 × 10 min'),
      JSON.stringify(rules));
    record('and Start replaces Continue', await page.locator('#setup-save-btn').isVisible());

    // Back from the end still works, and the purpose skip goes to the end.
    await page.click('#setup-back-btn');
    await page.click('#setup-back-btn');
    await page.waitForTimeout(60);
    await page.click('#setup-purpose-skip-btn');
    await page.waitForTimeout(60);
    step = await visibleStep(page);
    record('"Skip the rest" goes past the purpose pages',
      step.ids.join() === 'setup-step-access', JSON.stringify(step));
    await next(page);

    await page.click('#setup-save-btn');
    await page.waitForSelector('#settings-view:not([hidden])', { timeout: 5000 });

    const saved = await page.evaluate(() => new Promise(done =>
      chrome.storage.local.get(['domainLimits'], done)));
    record('the intentions reached storage',
      saved.domainLimits?.['instagram.com']?.maxGrants === 4 &&
      saved.domainLimits?.['instagram.com']?.passMinutes === 15 &&
      saved.domainLimits?.['some-blog.example']?.maxGrants === 1,
      JSON.stringify(saved.domainLimits));

    const stored = await page.evaluate(() => new Promise(done =>
      chrome.storage.local.get(['serviceReasons', 'setupDraft'], done)));

    record('the answers reached storage under the service key',
      stored.serviceReasons?.['instagram.com']?.purpose === 'DMs from my sister.',
      JSON.stringify(stored.serviceReasons));
    record('both halves of the answer survived',
      stored.serviceReasons?.['instagram.com']?.legitimateUse?.includes('Never the feed'));
    record('the hand-typed domain kept its own answer',
      stored.serviceReasons?.['some-blog.example']?.purpose === 'Reading one author.');
    record('the draft was cleared on finish', stored.setupDraft === undefined);

    // ── The settings row shows it back, and says nothing false about sharing.
    await page.waitForTimeout(200);
    const rowSummary = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('#domain-list li')];
      return rows.map(li => ({
        name: li.querySelector('.domain-name')?.textContent,
        value: li.querySelector('.row-reason-input')?.value,
        shared: li.querySelector('.row-reason-shared')?.textContent || null
      }));
    });
    const insta = rowSummary.find(r => r.name === 'instagram.com');
    record('the settings row offers the same two questions back',
      insta?.value === 'DMs from my sister.', JSON.stringify(rowSummary));
    record('and does not claim to be shared when only the site is blocked',
      insta?.shared === null, JSON.stringify(insta));

    // ── Now block the Instagram app too. The two rows must read as one
    // service: the same answer in both, and each saying the edit reaches the
    // other.
    //
    // The apps card only renders where a native bridge exists, so Chrome never
    // calls renderApps on its own — it is driven directly here. Still the real
    // function against the real DOM; only the platform gate is bypassed.
    await page.evaluate(() => new Promise(done => chrome.runtime.sendMessage({
      action: 'saveSettings',
      config: {
        blockedApps: ['com.instagram.android'],
        appLimits: { 'com.instagram.android': { maxGrants: 3, passMinutes: 10 } },
        appLabels: { 'com.instagram.android': 'Instagram' }
      }
    }, done)));

    const paired = await page.evaluate(async () => {
      const s = await getConfig();
      renderApps(s.blockedApps, s.appLimits, s.appLabels, s.serviceReasons);
      renderDomains(s.blockedDomains, s.domainLimits, s.serviceReasons);
      const read = (sel) => [...document.querySelectorAll(sel)].map(li => ({
        value: li.querySelector('.row-reason-input')?.value,
        shared: li.querySelector('.row-reason-shared')?.textContent || null
      }));
      return { sites: read('#domain-list li'), apps: read('#app-list li') };
    });

    const appRow = paired.apps[0];
    record('the Instagram app row inherits the website\'s answer',
      appRow?.value === 'DMs from my sister.', JSON.stringify(paired.apps));
    record('and tells the user the edit reaches both',
      /same service/i.test(appRow?.shared || ''), JSON.stringify(appRow?.shared));
    record('the website row now names the app as its pair',
      /Instagram app/.test(paired.sites.find(r => r.value === 'DMs from my sister.')?.shared || ''),
      JSON.stringify(paired.sites));

    const blogRow = paired.sites.find(r => r.value === 'Reading one author.');
    record('an unrelated site is not dragged into the pairing',
      blogRow?.shared === null, JSON.stringify(blogRow));

    // ── Writing from the app row must land on the website's answer, or the
    // "shared" line above is a lie. Blank one half first, so the box being
    // typed into is a FIRST write: those go straight in, exactly as the
    // coach-context card's first write does — there is no weak moment to
    // guard against before an answer exists.
    await page.evaluate(() => new Promise(done => chrome.runtime.sendMessage({
      action: 'saveSettings',
      config: { serviceReasons: { 'instagram.com': { purpose: 'DMs from my sister.' } } }
    }, done)));
    await page.evaluate(async () => {
      const s = await getConfig();
      renderApps(s.blockedApps, s.appLimits, s.appLabels, s.serviceReasons);
      const area = [...document.querySelectorAll('#app-list li .row-reason-input')][1];
      area.value = 'Only to reply, never to browse.';
      area.dispatchEvent(new Event('change'));
    });
    await page.waitForTimeout(300);
    const afterFirst = await page.evaluate(() => new Promise(done =>
      chrome.storage.local.get('serviceReasons', r => done(r.serviceReasons))));
    record('a first answer typed on the app row lands on the shared key, not a second copy',
      afterFirst['instagram.com']?.legitimateUse === 'Only to reply, never to browse.'
        && afterFirst['com.instagram.android'] === undefined,
      JSON.stringify(afterFirst));

    // ── An edit after that is saved too. These answers only change what the
    // coach reads, and the coach is reached only past a spent intention and
    // is paid for, so there is nothing to defer.
    const afterSecond = await page.evaluate(async () => {
      const area = [...document.querySelectorAll('#app-list li .row-reason-input')][1];
      area.value = 'Anything I feel like, actually.';
      area.dispatchEvent(new Event('change'));
      await new Promise(r => setTimeout(r, 300));
      const stored = await new Promise(done =>
        chrome.storage.local.get('serviceReasons', r => done(r.serviceReasons)));
      return { stored, shown: area.value };
    });
    record('editing an answer that already exists saves it on the shared key',
      afterSecond.stored['instagram.com']?.legitimateUse === 'Anything I feel like, actually.',
      JSON.stringify(afterSecond.stored));
    record('and the box keeps what was typed',
      afterSecond.shown === 'Anything I feel like, actually.', afterSecond.shown);

    await checkFitsOnPhones(context, optionsUrl);

    if (HEADED) await page.waitForTimeout(5000);
  } finally {
    await context.close();
    await rm(profile, { recursive: true, force: true });
  }

  const failed = results.filter(r => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) process.exit(1);
}

main().catch((err) => {
  console.error('wizard smoke test crashed:', err);
  process.exit(1);
});
