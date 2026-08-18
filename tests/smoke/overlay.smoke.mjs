// Does the in-page gate's styling stay inside the gate?
//
// content.css is injected into arbitrary third-party pages, and it now carries
// design tokens. Two things can go wrong and neither shows up in a unit test:
//
//   1. Tokens declared on :root would restyle the host site. The user opens a
//      blocked page, gets a gate, closes it, and the site underneath is a
//      different colour.
//   2. `all: initial` on #intention-root does NOT reset custom properties (the
//      `all` shorthand excludes them by spec), so a host page that happens to
//      define its own --border or --ink would inherit straight into the gate.
//
// Chromium's declarativeNetRequest redirects a blocked page to coaching.html
// before the in-page overlay is ever needed, so the real fallback path can't be
// provoked from here. This renders the real stylesheet over the real markup on
// a genuinely hostile page instead — which is precisely the property that
// changed.
//
// Run: node tests/smoke/overlay.smoke.mjs

import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const OVERLAY_CSS = readFileSync(join(REPO_ROOT, 'shared', 'content.css'), 'utf8');

const results = [];
const record = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  const mark = pass ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m';
  console.log(`${mark} ${name}${detail && !pass ? `\n    ${detail}` : ''}`);
};

// A page that declares every token name the overlay uses, in colours nothing
// would ever ship, plus its own visible content to check is left alone.
const HOSTILE_PAGE = `<!doctype html><html><head><style>
  :root {
    --paper: #ff00ff; --raised: #ff00ff; --ink: #00ff00; --text-muted: #00ff00;
    --text-dim: #00ff00; --border: #ff0000; --border-input: #ff0000;
    --hover: #ff00ff; --well: #ff00ff; --primary: #ff0000;
    --radius-card: 40px; --radius-control: 40px; --radius-pill: 0px;
  }
  body { background: #ff00ff; color: #00ff00; margin: 0; }
  #host-heading { color: #00ff00; }
</style></head><body>
  <h1 id="host-heading">The host page</h1>
  <div id="intention-root">
    <div class="int-column">
      <h1>Hold on</h1>
      <p class="int-subtitle">You opened example.com.</p>
      <div class="int-messages">
        <div class="int-msg int-msg-assistant">What are you here for?</div>
        <div class="int-msg int-msg-user">Checking one thing.</div>
      </div>
      <div class="int-composer"><input id="int-input"><button id="int-send">Send</button></div>
      <button class="int-primary-btn">Take 10 minutes</button>
    </div>
  </div>
</body></html>`;

async function main() {
  const browser = await chromium.launch({ headless: true, channel: 'chromium' });
  try {
    for (const scheme of ['light', 'dark']) {
      const page = await browser.newPage({ colorScheme: scheme });
      await page.setContent(HOSTILE_PAGE);
      // Appended last, exactly as a content-script stylesheet is: if the
      // overlay only won by document order, this would still expose it.
      await page.addStyleTag({ content: OVERLAY_CSS });
      // Messages fade in over 0.45s. Measuring or screenshotting before that
      // finishes reads a mid-animation opacity as a contrast failure.
      await page.waitForTimeout(700);

      const seen = await page.evaluate(() => {
        const root = document.getElementById('intention-root');
        const rs = getComputedStyle(root);
        const hostBody = getComputedStyle(document.body);
        const hostH1 = getComputedStyle(document.getElementById('host-heading'));
        const msg = getComputedStyle(root.querySelector('.int-msg-assistant'));
        return {
          rootBg: rs.backgroundColor,
          rootColor: rs.color,
          rootPaperVar: rs.getPropertyValue('--paper').trim(),
          rootInkVar: rs.getPropertyValue('--ink').trim(),
          msgColor: msg.color,
          hostBg: hostBody.backgroundColor,
          hostHeading: hostH1.color,
          rootZ: rs.zIndex
        };
      });

      const MAGENTA = 'rgb(255, 0, 255)';
      const GREEN = 'rgb(0, 255, 0)';

      record(`[${scheme}] the gate shadows the host page's --paper`,
        seen.rootPaperVar !== '#ff00ff' && seen.rootBg !== MAGENTA, JSON.stringify(seen));
      record(`[${scheme}] and its --ink`,
        seen.rootInkVar !== '#00ff00' && seen.rootColor !== GREEN, JSON.stringify(seen));
      record(`[${scheme}] a message is not painted in the host page's colours`,
        seen.msgColor !== GREEN, seen.msgColor);

      // The other direction: nothing the overlay brings may touch the page.
      record(`[${scheme}] the host page's own background is untouched`,
        seen.hostBg === MAGENTA, seen.hostBg);
      record(`[${scheme}] the host page's own text is untouched`,
        seen.hostHeading === GREEN, seen.hostHeading);

      record(`[${scheme}] the gate still sits above everything`,
        seen.rootZ === '2147483647', seen.rootZ);

      // The overlay was designed for a near-black surface, where a dim grey
      // still reads. Half of it now sits on warm white, and a mechanical
      // colour swap is exactly the kind of change that leaves body text at
      // 2:1 and looks fine to whoever made it. So: measure, don't look.
      const contrast = await page.evaluate(() => {
        const lum = (rgb) => {
          const [r, g, b] = rgb.match(/[\d.]+/g).slice(0, 3).map(Number).map(v => {
            const c = v / 255;
            return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
          });
          return 0.2126 * r + 0.7152 * g + 0.0722 * b;
        };
        const root = document.getElementById('intention-root');
        const bg = lum(getComputedStyle(root).backgroundColor);
        const ratio = (sel) => {
          const a = lum(getComputedStyle(root.querySelector(sel)).color);
          return Math.round(((Math.max(a, bg) + 0.05) / (Math.min(a, bg) + 0.05)) * 10) / 10;
        };
        return {
          assistant: ratio('.int-msg-assistant'),
          user: ratio('.int-msg-user'),
          subtitle: ratio('.int-subtitle'),
          input: ratio('.int-composer input'),
          send: ratio('.int-composer button')
        };
      });

      // 19px is not WCAG "large text" (that is 18.66px bold, or 24px), so the
      // conversation itself has to clear the full 4.5:1 on both surfaces.
      for (const what of ['assistant', 'user', 'subtitle', 'input', 'send']) {
        record(`[${scheme}] ${what} text clears 4.5:1 against the gate`,
          contrast[what] >= 4.5, `${contrast[what]}:1`);
      }

      await page.screenshot({ path: join(REPO_ROOT, 'build', 'shots', `overlay-${scheme}.png`) });
      await page.close();
    }

    // The two themes must actually differ, or the media query silently isn't
    // applying and every check above passes on one hardcoded palette.
    const read = async (scheme) => {
      const p = await browser.newPage({ colorScheme: scheme });
      await p.setContent(HOSTILE_PAGE);
      await p.addStyleTag({ content: OVERLAY_CSS });
      const bg = await p.evaluate(() =>
        getComputedStyle(document.getElementById('intention-root')).backgroundColor);
      await p.close();
      return bg;
    };
    const [light, dark] = [await read('light'), await read('dark')];
    record('the gate has two themes, not one', light !== dark, `${light} / ${dark}`);
  } finally {
    await browser.close();
  }

  const failed = results.filter(r => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) process.exit(1);
}

main().catch(err => { console.error('overlay smoke test crashed:', err); process.exit(1); });
