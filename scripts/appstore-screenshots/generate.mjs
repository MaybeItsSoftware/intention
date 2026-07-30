// One-off generator for App Store Connect marketing screenshots.
// Recreates the same visual language (and content) as the Android Play
// Store screenshots — dark gradient backdrop, Arvo headline, phone-frame
// mockup around the real coaching/options UI — but rendered fresh at each
// target Apple device resolution via a headless Chromium.
//
// Usage: node scripts/appstore-screenshots/generate.mjs

import { chromium } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { COACHING_CSS, OPTIONS_CSS, screen1, screen2, screen3, screen4, screen5, fontFaceCss } from './content.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const FONTS_DIR = path.join(REPO_ROOT, 'shared', 'fonts');
const OUT_ROOT = path.join(REPO_ROOT, 'Intention Apple', 'appstore', 'screenshots');

// --- shared chrome: gradient stage + headline + phone frame -----------------

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
    margin-top: 6.4vh;
    padding: 0 8vw;
    text-align: center;
  }
  .headline .l1 {
    margin: 0;
    color: #f4f5f8;
    font-weight: 700;
    font-size: 5.6vw;
    line-height: 1.22;
  }
  .headline .l2 {
    margin: 0.4vw 0 0;
    color: #6f9cf0;
    font-weight: 700;
    font-style: italic;
    font-size: 5.3vw;
    line-height: 1.24;
  }

  .phone {
    margin-top: 4.2vh;
    width: 67vw;
    height: 78vh;
    flex-shrink: 0;
    box-sizing: border-box;
    padding: 1.5vw;
    background: #232c44;
    border-radius: 5.6vw;
    box-shadow: 0 1px 0 rgba(255,255,255,0.06) inset, 0 40px 90px rgba(0,0,0,0.5);
  }
  .screen {
    width: 100%;
    height: 100%;
    border-radius: 4.2vw;
    overflow: hidden;
    background: #0f1115;
    color: #e7e7ea;
    container-type: inline-size;
    container-name: screen;
    position: relative;
    display: flex;
    flex-direction: column;
  }
`;

const SCREENS = [
  { file: '1.png', l1: 'Real reasons get through.', l2: 'Hollow ones don’t.', body: screen1, extraCss: COACHING_CSS },
  { file: '2.png', l1: 'Pick the apps', l2: 'that pull you in', body: screen2, extraCss: OPTIONS_CSS },
  { file: '3.png', l1: 'State your reason.', l2: 'Earn your minutes.', body: screen3, extraCss: COACHING_CSS },
  { file: '4.png', l1: 'Your coach remembers you.', l2: 'Only you can rewrite it.', body: screen4, extraCss: OPTIONS_CSS },
  { file: '5.png', l1: 'Bring your own AI.', l2: 'Claude, GPT, Gemini, or Groq.', body: screen5, extraCss: OPTIONS_CSS },
];

const DEVICES = [
  { name: 'iphone-6.9', width: 1320, height: 2868 },
  { name: 'ipad-13', width: 2064, height: 2752 },
];

function pageHtml(screen) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
    ${BASE_CSS}
    ${screen.extraCss}
  </style></head><body>
    <div class="stage">
      <div class="headline"><p class="l1">${screen.l1}</p><p class="l2">${screen.l2}</p></div>
      <div class="phone"><div class="screen">${screen.body}</div></div>
    </div>
  </body></html>`;
}

async function main() {
  const browser = await chromium.launch();
  try {
    for (const device of DEVICES) {
      const outDir = path.join(OUT_ROOT, device.name);
      fs.mkdirSync(outDir, { recursive: true });
      const page = await browser.newPage({ viewport: { width: device.width, height: device.height } });
      for (const screen of SCREENS) {
        await page.setContent(pageHtml(screen), { waitUntil: 'load' });
        await page.evaluate(() => document.fonts.ready);
        const outPath = path.join(outDir, screen.file);
        await page.screenshot({ path: outPath });
        console.log('wrote', path.relative(REPO_ROOT, outPath));
      }
      await page.close();
    }
  } finally {
    await browser.close();
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
