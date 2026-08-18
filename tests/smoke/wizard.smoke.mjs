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
    members: document.getElementById('setup-purpose-members')?.textContent || '',
    label: document.getElementById('setup-progress-label').textContent
  };
});

const next = async (page) => {
  await page.click('#setup-next-btn');
  await page.waitForTimeout(60);
};

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

    // ── The wizard opens on welcome, and announces the per-service run.
    let step = await visibleStep(page);
    record('opens on the welcome step', step.ids.join() === 'setup-step-welcome', JSON.stringify(step));

    const agenda = await page.textContent('#setup-welcome-checklist');
    record('the welcome agenda warns the questions are coming',
      /for each site/i.test(agenda), agenda.slice(0, 200));

    // ── Pick two sites. This is a browser build, so there is no apps step.
    await next(page);
    step = await visibleStep(page);
    record('reaches the sites step', step.ids.join() === 'setup-step-sites', JSON.stringify(step));

    await page.evaluate(async () => {
      await addDomainToBlocklist('instagram.com', 10);
      await addDomainToBlocklist('some-blog.example', 10);
    });
    await page.waitForTimeout(60);

    // The counter has to grow the moment the list does — the whole point of
    // recomputing the order inside refreshSetupNav. A browser build is
    // welcome + sites + why + mode + access + done, so two sites make eight.
    step = await visibleStep(page);
    record('the step count grows with the blocklist',
      step.label === 'Step 2 of 8', step.label);

    // ── Global why, then one screen per service.
    await next(page);
    step = await visibleStep(page);
    record('the global why step still comes first',
      step.ids.join() === 'setup-step-why', JSON.stringify(step));

    await next(page);
    step = await visibleStep(page);
    record('the first per-service screen is Instagram, named from the catalogue',
      step.ids.join() === 'setup-step-purpose' && step.title === 'Instagram',
      JSON.stringify(step));

    const whyLabel = await page.textContent('#setup-purpose-why-label');
    record('the question names the service',
      whyLabel.includes('Instagram'), whyLabel);

    await page.fill('#setup-purpose-why-input', 'DMs from my sister.');
    await page.fill('#setup-purpose-legit-input', 'A specific reply. Never the feed.');
    await page.locator('#setup-purpose-legit-input').blur();

    // ── The section is reused, so the real risk is it not repainting.
    await next(page);
    step = await visibleStep(page);
    record('the second service repaints the same section',
      step.ids.join() === 'setup-step-purpose' && step.title === 'some-blog.example',
      JSON.stringify(step));

    const carried = await page.inputValue('#setup-purpose-why-input');
    record('it does not carry the previous service\'s answer over', carried === '', carried);

    await page.fill('#setup-purpose-why-input', 'Reading one author.');
    await page.locator('#setup-purpose-why-input').blur();

    // ── A draft written on a per-service screen has to come back to it. The
    // step used to be stored as a bare index, which stops meaning anything
    // once the length depends on the blocklist.
    await page.reload();
    await page.waitForSelector('#setup-view:not([hidden])');
    await page.waitForTimeout(120);
    step = await visibleStep(page);
    record('a reload returns to the same service, not to step 1',
      step.ids.join() === 'setup-step-purpose' && step.title === 'some-blog.example',
      JSON.stringify(step));
    record('and the answer typed before the reload is still there',
      (await page.inputValue('#setup-purpose-why-input')) === 'Reading one author.');

    // ── Skip jumps the whole run, not one screen.
    await page.click('#setup-back-btn');
    await page.waitForTimeout(60);
    await page.click('#setup-purpose-skip-btn');
    await page.waitForTimeout(60);
    step = await visibleStep(page);
    record('Skip clears every remaining service, not just this one',
      step.ids.join() === 'setup-step-mode', JSON.stringify(step));

    // ── Simple mode must not change the denominator (the bug the access step
    // is unconditionally in the order to avoid).
    const beforeToggle = (await visibleStep(page)).label;
    await page.click('#setup-mode-simple-btn');
    await page.waitForTimeout(60);
    const afterToggle = (await visibleStep(page)).label;
    record('toggling to Simple does not move the step count',
      beforeToggle === afterToggle, `${beforeToggle} -> ${afterToggle}`);
    await page.click('#setup-mode-coach-btn');
    await page.waitForTimeout(60);

    // ── Finish, and check what actually landed in storage.
    await next(page);
    await next(page);
    step = await visibleStep(page);
    record('ends on the done step', step.ids.join() === 'setup-step-done', JSON.stringify(step));

    await page.click('#setup-save-btn');
    await page.waitForSelector('#settings-view:not([hidden])', { timeout: 5000 });

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
        summary: li.querySelector('.row-reason summary')?.textContent,
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
        appLimits: { 'com.instagram.android': { maxGrants: 3, maxMinutes: 10 } },
        appLabels: { 'com.instagram.android': 'Instagram' }
      }
    }, done)));

    const paired = await page.evaluate(async () => {
      const s = await getConfig();
      renderApps(s.blockedApps, s.appLimits, s.appLabels, s.blockingMode, s.serviceReasons);
      renderDomains(s.blockedDomains, s.domainLimits, s.blockingMode, s.serviceReasons);
      const read = (sel) => [...document.querySelectorAll(sel)].map(li => ({
        summary: li.querySelector('.row-reason summary')?.textContent,
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

    // ── Editing the app row must move the website's answer too, or the
    // "shared" line above is a lie.
    await page.evaluate(async () => {
      const area = document.querySelector('#app-list li .row-reason-input');
      area.value = 'Only to reply, never to browse.';
      area.dispatchEvent(new Event('change'));
    });
    await page.waitForTimeout(300);
    const afterEdit = await page.evaluate(() => new Promise(done =>
      chrome.storage.local.get('serviceReasons', r => done(r.serviceReasons))));
    record('editing the app row rewrites the shared answer, not a second copy',
      afterEdit['instagram.com']?.purpose === 'Only to reply, never to browse.'
        && afterEdit['com.instagram.android'] === undefined,
      JSON.stringify(afterEdit));

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
