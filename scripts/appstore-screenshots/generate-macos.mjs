// One-off generator for App Store Connect macOS marketing screenshots.
// Unlike the iOS/iPad generator (generate.mjs), there's no device to frame
// the UI in on the Mac — the extension's coaching/options pages are real
// Safari tabs, so these mock a Safari browser window instead of a phone.
// Content/styles are shared with generate.mjs via content.mjs so copy and
// chip colors stay pixel-accurate to the real app.
//
// Usage: node scripts/appstore-screenshots/generate-macos.mjs

import { chromium } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { icon, chip, coachingScreen, websiteChips, rowItem, modelPills, fontFaceCss } from './content.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const FONTS_DIR = path.join(REPO_ROOT, 'shared', 'fonts');
const OUT_DIR = path.join(REPO_ROOT, 'Intention Apple', 'appstore', 'screenshots', 'macos');

const INTENTION_ICON_SVG = `<svg viewBox="0 0 512 512" style="width:100%;height:100%" xmlns="http://www.w3.org/2000/svg">
  <rect width="512" height="512" rx="112" fill="#007FFF" />
  <path d="M210.856 206.653H272.632V364.564H301.144V396.0H211.222V364.564H238.272V238.089H210.856ZM231.875 139.577Q231.875 134.825 233.794 130.53Q235.713 126.235 238.911 123.037Q242.11 119.838 246.496 117.919Q250.883 116.0 255.817 116.0Q260.569 116.0 264.864 117.919Q269.159 119.838 272.358 123.037Q275.556 126.235 277.475 130.53Q279.394 134.825 279.394 139.577Q279.394 144.512 277.475 148.898Q275.556 153.285 272.358 156.666Q269.159 160.047 264.864 161.966Q260.569 163.885 255.817 163.885Q250.883 163.885 246.496 161.966Q242.11 160.047 238.911 156.666Q235.713 153.285 233.794 148.898Q231.875 144.512 231.875 139.577Z" fill="#fff" />
</svg>`;

const BASE_CSS = `
  ${fontFaceCss(FONTS_DIR)}

  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; width: 100%; height: 100%; overflow: hidden; font-family: 'Arvo', Georgia, serif; -webkit-font-smoothing: antialiased; }

  .stage {
    width: 100vw;
    height: 100vh;
    display: flex;
    flex-direction: column;
    align-items: center;
    background:
      radial-gradient(120% 60% at 50% 0%, #223357 0%, rgba(34,51,87,0) 60%),
      linear-gradient(180deg, #0b0f1a 0%, #101a2c 55%, #0c1220 100%);
  }

  .headline {
    margin-top: 4.6vh;
    padding: 0 8vw;
    text-align: center;
  }
  .headline .l1 {
    margin: 0;
    color: #f4f5f8;
    font-weight: 700;
    font-size: 2.9vw;
    line-height: 1.24;
  }
  .headline .l2 {
    margin: 0.3vw 0 0;
    color: #6f9cf0;
    font-weight: 700;
    font-style: italic;
    font-size: 2.75vw;
    line-height: 1.26;
  }

  .browser-window {
    margin-top: 2.6vh;
    margin-bottom: 3.4vh;
    width: 84vw;
    height: 76vh;
    flex-shrink: 0;
    border-radius: 0.85vw;
    overflow: hidden;
    background: #1c1d22;
    box-shadow: 0 1px 0 rgba(255,255,255,0.06) inset, 0 40px 90px rgba(0,0,0,0.5);
    display: flex;
    flex-direction: column;
  }
  .browser-titlebar {
    height: 4.6vh;
    flex-shrink: 0;
    background: #2b2c31;
    display: flex;
    align-items: center;
    padding: 0 1.3vw;
    gap: 0.5vw;
  }
  .traffic-light { width: 0.75vw; height: 0.75vw; border-radius: 50%; flex-shrink: 0; }
  .traffic-light.red { background: #ff5f57; }
  .traffic-light.yellow { background: #febc2e; }
  .traffic-light.green { background: #28c840; }

  .browser-tabbar {
    height: 4.8vh;
    flex-shrink: 0;
    background: #242529;
    display: flex;
    align-items: flex-end;
    padding: 0 0.9vw;
    gap: 0.35vw;
  }
  .browser-tab {
    display: flex;
    align-items: center;
    gap: 0.55vw;
    max-width: 15vw;
    padding: 0 1vw;
    height: 3.9vh;
    border-radius: 0.55vw 0.55vw 0 0;
    color: #9aa0ac;
    font-size: 0.85vw;
  }
  .browser-tab.active { background: #17181c; color: #e7e7ea; }
  .browser-tab .fav { width: 0.85vw; height: 0.85vw; border-radius: 0.2vw; overflow: hidden; flex-shrink: 0; display: flex; }
  .browser-tab .title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  .browser-addressbar {
    height: 5vh;
    flex-shrink: 0;
    background: #17181c;
    border-bottom: 1px solid rgba(255,255,255,0.07);
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .browser-address-pill {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.5vw;
    min-width: 24vw;
    background: rgba(255,255,255,0.06);
    border-radius: 0.6vw;
    padding: 0.7vh 1.2vw;
    color: #9aa0ac;
    font-size: 0.85vw;
  }
  .browser-address-pill .lock { opacity: 0.7; }

  .browser-content {
    flex: 1;
    min-height: 0;
    overflow: hidden;
    background: #0f1115;
    color: #e7e7ea;
    container-type: size;
    container-name: screen;
    position: relative;
    display: flex;
    flex-direction: column;
  }
`;

// --- macOS-specific screen layout: real desktop settings.html is a
// centered, two-column grid (see options.css #settings-view / .settings-grid,
// max-width 1000px) rather than the single-column mobile card stack used for
// the iOS mockups. The wide-but-short browser window here has a very
// different aspect ratio to a phone screen, so these component sizes are
// calibrated fresh against cqw rather than reusing OPTIONS_CSS's portrait
// scale, which overflowed badly when tried as-is. --------------------------
const SETTINGS_CSS = `
  .settings-shell { height: 100%; overflow: hidden; padding: 2.6cqw 4.2cqw 0; }
  .settings-head h1 { margin: 0 0 0.3cqw; font-size: 2.6cqw; font-weight: 700; letter-spacing: -0.02em; color: #f1f5f9; }
  .settings-head p { margin: 0 0 1.6cqw; font-size: 1.05cqw; color: #94a3b8; }
  .settings-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 1.4cqw; align-items: start; }
  .settings-col { display: flex; flex-direction: column; gap: 1.1cqw; min-width: 0; }

  .card { background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.08); border-radius: 1.4cqw; padding: 1.5cqw 1.7cqw; }
  .card h2 { margin: 0 0 0.6cqw; font-size: 1.25cqw; color: #f1f5f9; }
  .card .subtitle { color: #94a3b8; font-size: 0.92cqw; line-height: 1.45; margin: 0 0 0.9cqw; }
  blockquote {
    margin: 0 0 0.9cqw; padding: 0.9cqw 1.1cqw; background: rgba(255,255,255,0.03);
    border-left: 0.2cqw solid rgba(59,130,246,0.5); border-radius: 0.6cqw; color: #cbd5e1;
    font-size: 0.92cqw; line-height: 1.5;
    display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 3; overflow: hidden;
  }
  .btn { display: block; width: 100%; text-align: center; padding: 0.65cqw 1.1cqw; border-radius: 0.7cqw; font-weight: 600; font-size: 0.9cqw; box-sizing: border-box; }
  .btn.primary { background: #3b82f6; color: #fff; }
  .btn.secondary { background: transparent; border: 1px solid rgba(255,255,255,0.2); color: #cbd5e1; }
  .row-list { list-style: none; margin: 0.7cqw 0 0; padding: 0; }
  .row-list li { display: flex; justify-content: space-between; align-items: center; gap: 0.8cqw; padding: 0.6cqw 0.9cqw; background: rgba(255,255,255,0.03); border-radius: 0.7cqw; margin-bottom: 0.4cqw; font-size: 0.88cqw; }
  .row-list li .meta { color: #94a3b8; display: flex; align-items: center; gap: 0.5cqw; }
  .row-list li .meta b { color: #cbd5e1; font-weight: 400; }
  .row-list li .remove { padding: 0.3cqw 0.7cqw; font-size: 0.8cqw; border-radius: 0.5cqw; border: 1px solid rgba(255,255,255,0.2); color: #cbd5e1; }
  .chips { display: flex; flex-wrap: wrap; gap: 0.6cqw; margin: 0.3cqw 0 0.9cqw; }
  .chip { display: inline-flex; align-items: center; gap: 0.5cqw; padding: 0.55cqw 1cqw; border-radius: 999px; border: 1px solid rgba(255,255,255,0.15); background: rgba(255,255,255,0.04); color: #cbd5e1; font-size: 0.95cqw; }
  .chip.selected { background: rgba(59,130,246,0.2); border-color: rgba(59,130,246,0.6); color: #f1f5f9; }
  .field-label { display: block; font-size: 0.85cqw; color: #cbd5e1; margin: 0.9cqw 0 0.4cqw; }
  .field { width: 100%; padding: 0.65cqw 0.8cqw; border-radius: 0.7cqw; background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.1); color: #f1f5f9; font-size: 0.9cqw; box-sizing: border-box; }
  .pills { display: flex; flex-wrap: wrap; gap: 0.5cqw; margin: 0.3cqw 0 0.8cqw; }
  .pill { padding: 0.4cqw 0.9cqw; border-radius: 0.7cqw; font-size: 0.8cqw; background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.15); color: #cbd5e1; }
  .pill.selected { background: rgba(59,130,246,0.22); border-color: rgba(59,130,246,0.65); color: #f1f5f9; }
  .stat-line { font-size: 1cqw; color: #e7e7ea; margin: 0 0 0.5cqw; }
  .stat-line b { font-weight: 700; }
  .stat-sub { font-size: 0.92cqw; color: #94a3b8; margin: 0 0 0.5cqw; }
`;

const COACHING_MACOS_CSS = `
  .coach-col { max-width: 76cqw; width: 100%; margin: 0 auto; flex: 1; min-height: 0; overflow: hidden; padding: 3.4cqh 2.4cqw 0; }
  .coach-eyebrow { margin: 0 0 0.4cqh; font-size: 1.05cqw; font-weight: 600; letter-spacing: 0.08cqw; text-transform: uppercase; color: #6b7280; }
  .coach-subtitle { margin: 0 0 2.2cqh; font-size: 1.15cqw; color: #8b8f99; }
  .coach-stats { display: flex; flex-wrap: wrap; gap: 1.6cqw; margin-bottom: 2.4cqh; font-size: 1cqw; }
  .coach-stat b { color: #9aa0ac; font-weight: 600; }
  .coach-stat span { color: #545863; }
  .coach-messages { display: flex; flex-direction: column; gap: 1.8cqh; }
  .coach-msg { font-size: 1.35cqw; line-height: 1.55; }
  .coach-msg.assistant { color: #f3f4f6; }
  .coach-msg.user { color: #7c818c; }
  .coach-msg.user b { color: #4b5563; font-weight: 400; }
  .coach-bottom { flex-shrink: 0; padding: 1.6cqh 2.4cqw 2.6cqh; border-top: 1px solid rgba(255,255,255,0.08); }
  .coach-composer { display: flex; align-items: center; gap: 1vw; border-bottom: 1px solid rgba(255,255,255,0.14); padding-bottom: 1cqh; }
  .coach-composer span.ph { flex: 1; color: #545863; font-size: 1.2cqw; }
  .coach-composer span.send { color: #9aa0ac; font-weight: 600; font-size: 1.05cqw; }
  .coach-close { margin-top: 1cqh; color: #545863; font-size: 1cqw; }
`;

// --- tab / address chrome ---------------------------------------------------

const browserWindow = ({ tabFav, tabTitle, address, body }) => `
  <div class="browser-window">
    <div class="browser-titlebar">
      <span class="traffic-light red"></span><span class="traffic-light yellow"></span><span class="traffic-light green"></span>
    </div>
    <div class="browser-tabbar">
      <div class="browser-tab active"><span class="fav">${tabFav}</span><span class="title">${tabTitle}</span></div>
    </div>
    <div class="browser-addressbar">
      <div class="browser-address-pill"><span class="lock">&#128274;</span><span>${address}</span></div>
    </div>
    <div class="browser-content">${body}</div>
  </div>
`;

// --- screen 1: coaching intervention, condensed for a wide/short window ----

const coachingBody = coachingScreen({
  eyebrowSub: 'instagram.com — let’s check in before you go through',
  stats: [['12m', 'Today'], ['94m', 'Week'], ['640m', 'Year'], ['1210m', 'All Time']],
  messages: [
    { role: 'assistant', text: 'Hey. I see you’ve opened instagram.com. What’s going on — what are you hoping to get out of it?' },
    { role: 'user', text: 'just bored, kind of avoiding my essay' },
    { role: 'assistant', text: 'That’s honest, thank you. Avoiding the essay is exactly the pattern you told me you wanted to catch early. What’s the smallest next step you could take on it right now instead?' },
    { role: 'user', text: 'ok fair… I guess I could just write the intro paragraph' },
    { role: 'assistant', text: 'That’s a real, doable step. Go do that first, I’ll be here after. Close the tab?' },
  ],
});

// --- screen 2: settings dashboard, real two-column desktop layout ----------

const settingsBody = `
  <div class="settings-shell">
    <div class="settings-head">
      <h1><i>Intention</i></h1>
      <p>Your coach, your sites, your rules.</p>
    </div>
    <div class="settings-grid">
      <div class="settings-col">
        <div class="card">
          <h2>Your coach’s context</h2>
          <p class="subtitle">The coach updates this only through conversation with you.</p>
          <blockquote>Alex is a second-year CS student finishing a dissertation on distributed systems. Biggest trigger is opening Instagram or X ‘just for a second’ while stuck on a hard problem, which turns into 40+ minutes of scrolling.</blockquote>
          <span class="btn secondary">Talk with your coach</span>
        </div>
        <div class="card">
          <h2>Today</h2>
          <p class="stat-line"><b>23 min</b> on blocked sites today.</p>
          <p class="stat-sub" style="margin-bottom:0">Past 7 days: <b style="color:#e7e7ea">187 min</b>.</p>
        </div>
      </div>
      <div class="settings-col">
        <div class="card">
          <h2>Blocked sites</h2>
          <p class="subtitle">Add domains you want to be mindful about.</p>
          <div class="chips">${websiteChips}</div>
          <ul class="row-list">
            ${rowItem('instagram.co…')}
            ${rowItem('x.com')}
          </ul>
        </div>
      </div>
    </div>
  </div>
`;

// --- screen 3: bring-your-own-AI provider card ------------------------------

const providerBody = `
  <div class="settings-shell">
    <div class="settings-head">
      <h1><i>Intention</i></h1>
      <p>Bring your own AI. You bring the API key, we don’t see it.</p>
    </div>
    <div class="settings-grid">
      <div class="settings-col">
        <div class="card">
          <h2>Provider</h2>
          <p class="subtitle">Intention uses the LLM you choose. Nothing leaves your machine except calls to that provider.</p>
          <span class="field-label" style="margin-top:0">Provider</span>
          <div class="field" style="margin-bottom:1.6cqw">Anthropic (Claude)</div>
          <span class="field-label">Model</span>
          <div class="pills">
            ${modelPills.map(([label, sel]) => `<span class="pill${sel ? ' selected' : ''}">${label}</span>`).join('')}
          </div>
          <span class="field-label">API key</span>
          <div class="field">&bull;&bull;&bull;&bull;&bull;&bull;&bull;&bull;&bull;&bull;&bull;&bull;&bull;&bull;&bull;&bull;&bull;&bull;&bull;&bull;</div>
          <span class="btn primary" style="margin-top:1.6cqw">Save</span>
        </div>
      </div>
      <div class="settings-col">
        <div class="card">
          <h2>Which apps pull you in?</h2>
          <p class="subtitle">Tap the common ones, or add your own.</p>
          <div class="chips">
            ${chip('instagram.com', true)}${chip('tiktok.com', true)}${chip('youtube.com', true)}${chip('x.com', false)}
            ${chip('reddit.com', false)}${chip('facebook.com', false)}
          </div>
          <ul class="row-list">
            ${rowItem('Instagram')}
            ${rowItem('TikTok')}
          </ul>
        </div>
      </div>
    </div>
  </div>
`;

const SCREENS = [
  {
    file: '1.png', l1: 'Real reasons get through.', l2: 'Hollow ones don’t.',
    extraCss: COACHING_MACOS_CSS,
    window: browserWindow({ tabFav: icon('instagram.com', '100%'), tabTitle: 'Instagram', address: 'instagram.com', body: coachingBody }),
  },
  {
    file: '2.png', l1: 'Your coach remembers you.', l2: 'Only you can rewrite it.',
    extraCss: SETTINGS_CSS,
    window: browserWindow({ tabFav: INTENTION_ICON_SVG, tabTitle: 'Intention', address: 'Intention — Settings', body: settingsBody }),
  },
  {
    file: '3.png', l1: 'Bring your own AI.', l2: 'Claude, GPT, Gemini, or Groq.',
    extraCss: SETTINGS_CSS,
    window: browserWindow({ tabFav: INTENTION_ICON_SVG, tabTitle: 'Intention', address: 'Intention — Settings', body: providerBody }),
  },
];

const CANVAS = { width: 2880, height: 1800 };

function pageHtml(screen) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
    ${BASE_CSS}
    ${screen.extraCss}
  </style></head><body>
    <div class="stage">
      <div class="headline"><p class="l1">${screen.l1}</p><p class="l2">${screen.l2}</p></div>
      ${screen.window}
    </div>
  </body></html>`;
}

async function main() {
  const browser = await chromium.launch();
  try {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    const page = await browser.newPage({ viewport: CANVAS });
    for (const screen of SCREENS) {
      await page.setContent(pageHtml(screen), { waitUntil: 'load' });
      await page.evaluate(() => document.fonts.ready);
      const outPath = path.join(OUT_DIR, screen.file);
      await page.screenshot({ path: outPath });
      console.log('wrote', path.relative(REPO_ROOT, outPath));
    }
    await page.close();
  } finally {
    await browser.close();
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
