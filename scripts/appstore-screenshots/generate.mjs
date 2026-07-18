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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const FONTS_DIR = path.join(REPO_ROOT, 'shared', 'fonts');
const OUT_ROOT = path.join(REPO_ROOT, 'Intention Apple', 'appstore', 'screenshots');

const fontUrl = (name) => 'file://' + path.join(FONTS_DIR, name).replace(/ /g, '%20');

// Same Simple Icons path data + brand colors used by the live options.js
// chip UI (Intention Apple/Shared (Extension)/Resources/options.js), so the
// mockup chips are pixel-accurate to the real app rather than invented.
const SITE_META = {
  'x.com': { name: 'X', color: '#e7e9ea', icon: 'M14.234 10.162 22.977 0h-2.072l-7.591 8.824L7.251 0H.258l9.168 13.343L.258 24H2.33l8.016-9.318L16.749 24h6.993zm-2.837 3.299-.929-1.329L3.076 1.56h3.182l5.965 8.532.929 1.329 7.754 11.09h-3.182z' },
  'twitter.com': { name: 'Twitter', color: '#1d9bf0', icon: 'M21.543 7.104c.015.211.015.423.015.636 0 6.507-4.954 14.01-14.01 14.01v-.003A13.94 13.94 0 0 1 0 19.539a9.88 9.88 0 0 0 7.287-2.041 4.93 4.93 0 0 1-4.6-3.42 4.916 4.916 0 0 0 2.223-.084A4.926 4.926 0 0 1 .96 9.167v-.062a4.887 4.887 0 0 0 2.235.616A4.928 4.928 0 0 1 1.67 3.148 13.98 13.98 0 0 0 11.82 8.292a4.929 4.929 0 0 1 8.39-4.49 9.868 9.868 0 0 0 3.128-1.196 4.941 4.941 0 0 1-2.165 2.724A9.828 9.828 0 0 0 24 4.555a10.019 10.019 0 0 1-2.457 2.549z' },
  'youtube.com': { name: 'YouTube', color: '#ff0000', icon: 'M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z' },
  'reddit.com': { name: 'Reddit', color: '#ff4500', icon: 'M12 0C5.373 0 0 5.373 0 12c0 3.314 1.343 6.314 3.515 8.485l-2.286 2.286C.775 23.225 1.097 24 1.738 24H12c6.627 0 12-5.373 12-12S18.627 0 12 0Zm4.388 3.199c1.104 0 1.999.895 1.999 1.999 0 1.105-.895 2-1.999 2-.946 0-1.739-.657-1.947-1.539v.002c-1.147.162-2.032 1.15-2.032 2.341v.007c1.776.067 3.4.567 4.686 1.363.473-.363 1.064-.58 1.707-.58 1.547 0 2.802 1.254 2.802 2.802 0 1.117-.655 2.081-1.601 2.531-.088 3.256-3.637 5.876-7.997 5.876-4.361 0-7.905-2.617-7.998-5.87-.954-.447-1.614-1.415-1.614-2.538 0-1.548 1.255-2.802 2.803-2.802.645 0 1.239.218 1.712.585 1.275-.79 2.881-1.291 4.64-1.365v-.01c0-1.663 1.263-3.034 2.88-3.207.188-.911.993-1.595 1.959-1.595Zm-8.085 8.376c-.784 0-1.459.78-1.506 1.797-.047 1.016.64 1.429 1.426 1.429.786 0 1.371-.369 1.418-1.385.047-1.017-.553-1.841-1.338-1.841Zm7.406 0c-.786 0-1.385.824-1.338 1.841.047 1.017.634 1.385 1.418 1.385.785 0 1.473-.413 1.426-1.429-.046-1.017-.721-1.797-1.506-1.797Zm-3.703 4.013c-.974 0-1.907.048-2.77.135-.147.015-.241.168-.183.305.483 1.154 1.622 1.964 2.953 1.964 1.33 0 2.47-.81 2.953-1.964.057-.137-.037-.29-.184-.305-.863-.087-1.795-.135-2.769-.135Z' },
  'instagram.com': { name: 'Instagram', color: '#ff0069', icon: 'M7.0301.084c-1.2768.0602-2.1487.264-2.911.5634-.7888.3075-1.4575.72-2.1228 1.3877-.6652.6677-1.075 1.3368-1.3802 2.127-.2954.7638-.4956 1.6365-.552 2.914-.0564 1.2775-.0689 1.6882-.0626 4.947.0062 3.2586.0206 3.6671.0825 4.9473.061 1.2765.264 2.1482.5635 2.9107.308.7889.72 1.4573 1.388 2.1228.6679.6655 1.3365 1.0743 2.1285 1.38.7632.295 1.6361.4961 2.9134.552 1.2773.056 1.6884.069 4.9462.0627 3.2578-.0062 3.668-.0207 4.9478-.0814 1.28-.0607 2.147-.2652 2.9098-.5633.7889-.3086 1.4578-.72 2.1228-1.3881.665-.6682 1.0745-1.3378 1.3795-2.1284.2957-.7632.4966-1.636.552-2.9124.056-1.2809.0692-1.6898.063-4.948-.0063-3.2583-.021-3.6668-.0817-4.9465-.0607-1.2797-.264-2.1487-.5633-2.9117-.3084-.7889-.72-1.4568-1.3876-2.1228C21.2982 1.33 20.628.9208 19.8378.6165 19.074.321 18.2017.1197 16.9244.0645 15.6471.0093 15.236-.005 11.977.0014 8.718.0076 8.31.0215 7.0301.0839m.1402 21.6932c-1.17-.0509-1.8053-.2453-2.2287-.408-.5606-.216-.96-.4771-1.3819-.895-.422-.4178-.6811-.8186-.9-1.378-.1644-.4234-.3624-1.058-.4171-2.228-.0595-1.2645-.072-1.6442-.079-4.848-.007-3.2037.0053-3.583.0607-4.848.05-1.169.2456-1.805.408-2.2282.216-.5613.4762-.96.895-1.3816.4188-.4217.8184-.6814 1.3783-.9003.423-.1651 1.0575-.3614 2.227-.4171 1.2655-.06 1.6447-.072 4.848-.079 3.2033-.007 3.5835.005 4.8495.0608 1.169.0508 1.8053.2445 2.228.408.5608.216.96.4754 1.3816.895.4217.4194.6816.8176.9005 1.3787.1653.4217.3617 1.056.4169 2.2263.0602 1.2655.0739 1.645.0796 4.848.0058 3.203-.0055 3.5834-.061 4.848-.051 1.17-.245 1.8055-.408 2.2294-.216.5604-.4763.96-.8954 1.3814-.419.4215-.8181.6811-1.3783.9-.4224.1649-1.0577.3617-2.2262.4174-1.2656.0595-1.6448.072-4.8493.079-3.2045.007-3.5825-.006-4.848-.0608M16.953 5.5864A1.44 1.44 0 1 0 18.39 4.144a1.44 1.44 0 0 0-1.437 1.4424M5.8385 12.012c.0067 3.4032 2.7706 6.1557 6.173 6.1493 3.4026-.0065 6.157-2.7701 6.1506-6.1733-.0065-3.4032-2.771-6.1565-6.174-6.1498-3.403.0067-6.156 2.771-6.1496 6.1738M8 12.0077a4 4 0 1 1 4.008 3.9921A3.9996 3.9996 0 0 1 8 12.0077' },
  'tiktok.com': { name: 'TikTok', color: '#f1f5f9', icon: 'M12.525.02c1.31-.02 2.61-.01 3.91-.02.08 1.53.63 3.09 1.75 4.17 1.12 1.11 2.7 1.62 4.24 1.79v4.03c-1.44-.05-2.89-.35-4.2-.97-.57-.26-1.1-.59-1.62-.93-.01 2.92.01 5.84-.02 8.75-.08 1.4-.54 2.79-1.35 3.94-1.31 1.92-3.58 3.17-5.91 3.21-1.43.08-2.86-.31-4.08-1.03-2.02-1.19-3.44-3.37-3.65-5.71-.02-.5-.03-1-.01-1.49.18-1.9 1.12-3.72 2.58-4.96 1.66-1.44 3.98-2.13 6.15-1.72.02 1.48-.04 2.96-.04 4.44-.99-.32-2.15-.23-3.02.37-.63.41-1.11 1.04-1.36 1.75-.21.51-.15 1.07-.14 1.61.24 1.64 1.82 3.02 3.5 2.87 1.12-.01 2.19-.66 2.77-1.61.19-.33.4-.67.41-1.06.1-1.79.06-3.57.07-5.36.01-4.03-.01-8.05.02-12.07z' },
  'facebook.com': { name: 'Facebook', color: '#0866ff', icon: 'M9.101 23.691v-7.98H6.627v-3.667h2.474v-1.58c0-4.085 1.848-5.978 5.858-5.978.401 0 .955.042 1.468.103a8.68 8.68 0 0 1 1.141.195v3.325a8.623 8.623 0 0 0-.653-.036 26.805 26.805 0 0 0-.733-.009c-.707 0-1.259.096-1.675.309a1.686 1.686 0 0 0-.679.622c-.258.42-.374.995-.374 1.752v1.297h3.919l-.386 2.103-.287 1.564h-3.246v8.245C19.396 23.238 24 18.179 24 12.044c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.628 3.874 10.35 9.101 11.647Z' },
  'twitch.tv': { name: 'Twitch', color: '#9146ff', icon: 'M11.571 4.714h1.715v5.143H11.57zm4.715 0H18v5.143h-1.714zM6 0L1.714 4.286v15.428h5.143V24l4.286-4.286h3.428L22.286 12V0zm14.571 11.143l-3.428 3.428h-3.429l-3 3v-3H6.857V1.714h13.714Z' },
  'netflix.com': { name: 'Netflix', color: '#e50914', icon: 'm5.398 0 8.348 23.602c2.346.059 4.856.398 4.856.398L10.113 0H5.398zm8.489 0v9.172l4.715 13.33V0h-4.715zM5.398 1.5V24c1.873-.225 2.81-.312 4.715-.398V14.83L5.398 1.5z' },
  'linkedin.com': { name: 'LinkedIn', color: '#0a66c2', icon: 'M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433c-1.144 0-2.063-.926-2.063-2.065 0-1.138.92-2.063 2.063-2.063 1.14 0 2.064.925 2.064 2.063 0 1.139-.925 2.065-2.064 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z' },
};

const icon = (key, size = '1.6cqw') => {
  const meta = SITE_META[key];
  return `<svg viewBox="0 0 24 24" style="width:${size};height:${size};flex-shrink:0" fill="${meta.color}" aria-hidden="true"><path d="${meta.icon}"/></svg>`;
};

const chip = (key, selected) =>
  `<span class="chip${selected ? ' selected' : ''}">${icon(key)}<span>${SITE_META[key].name}</span></span>`;

// --- shared chrome: gradient stage + headline + phone frame -----------------

const BASE_CSS = `
  @font-face { font-family: 'Arvo'; font-style: normal; font-weight: 400; src: url('${fontUrl('Arvo-Regular.woff2')}') format('woff2'); }
  @font-face { font-family: 'Arvo'; font-style: normal; font-weight: 700; src: url('${fontUrl('Arvo-Bold.woff2')}') format('woff2'); }
  @font-face { font-family: 'Arvo'; font-style: italic; font-weight: 400; src: url('${fontUrl('Arvo-Italic.woff2')}') format('woff2'); }
  @font-face { font-family: 'Arvo'; font-style: italic; font-weight: 700; src: url('${fontUrl('Arvo-BoldItalic.woff2')}') format('woff2'); }

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

// --- reusable "screen" component styles (container-query units, so they
// scale with the phone frame's own width regardless of canvas size) --------

const COACHING_CSS = `
  .coach-col { max-width: 92cqw; width: 100%; margin: 0 auto; flex: 1; min-height: 0; overflow: hidden; padding: 9cqw 4.6cqw 0; }
  .coach-eyebrow { margin: 0 0 0.6cqw; font-size: 2.1cqw; font-weight: 600; letter-spacing: 0.14cqw; text-transform: uppercase; color: #6b7280; }
  .coach-subtitle { margin: 0 0 4.4cqw; font-size: 2.35cqw; color: #8b8f99; }
  .coach-stats { display: flex; flex-wrap: wrap; gap: 2.8cqw; margin-bottom: 4.6cqw; font-size: 2.05cqw; }
  .coach-stat b { color: #9aa0ac; font-weight: 600; }
  .coach-stat span { color: #545863; }
  .coach-messages { display: flex; flex-direction: column; gap: 3.4cqw; }
  .coach-msg { font-size: 3cqw; line-height: 1.6; }
  .coach-msg.assistant { color: #f3f4f6; }
  .coach-msg.user { color: #7c818c; }
  .coach-msg.user b { color: #4b5563; font-weight: 400; }
  .coach-bottom { flex-shrink: 0; padding: 1.8cqw 4.6cqw 3.6cqw; border-top: 1px solid rgba(255,255,255,0.08); }
  .coach-composer { display: flex; align-items: center; gap: 1.9cqw; border-bottom: 1px solid rgba(255,255,255,0.14); padding-bottom: 1.3cqw; }
  .coach-composer span.ph { flex: 1; color: #545863; font-size: 2.85cqw; }
  .coach-composer span.send { color: #9aa0ac; font-weight: 600; font-size: 2.35cqw; }
  .coach-close { margin-top: 1.6cqw; color: #545863; font-size: 2.2cqw; }
`;

const OPTIONS_CSS = `
  .opt-col { height: 100%; padding: 6.4cqw 5cqw 0; overflow: hidden; }
  .opt-header h1 { margin: 0 0 0.6cqw; font-size: 5.2cqw; font-weight: 700; letter-spacing: -0.02em; color: #f1f5f9; }
  .opt-header p { margin: 0 0 4.6cqw; font-size: 2.3cqw; color: #94a3b8; }
  .card { background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.08); border-radius: 4.1cqw; padding: 3.3cqw 3.6cqw; margin-bottom: 2.4cqw; }
  .card h2 { margin: 0 0 1.2cqw; font-size: 2.7cqw; color: #f1f5f9; }
  .card h3 { margin: 0 0 1.2cqw; font-size: 2.55cqw; font-weight: 600; color: #f1f5f9; }
  .card .subtitle { color: #94a3b8; font-size: 2.1cqw; line-height: 1.5; margin: 0 0 2.1cqw; }
  blockquote { margin: 0 0 2.1cqw; padding: 2.1cqw 2.4cqw; background: rgba(255,255,255,0.03); border-left: 0.45cqw solid rgba(59,130,246,0.5); border-radius: 1.2cqw; color: #cbd5e1; font-size: 2.15cqw; line-height: 1.55; }
  .btn { display: block; width: 100%; text-align: center; padding: 1.5cqw 2.4cqw; border-radius: 1.5cqw; font-weight: 600; font-size: 2.1cqw; box-sizing: border-box; }
  .btn.primary { background: #3b82f6; color: #fff; }
  .btn.secondary { background: transparent; border: 1px solid rgba(255,255,255,0.2); color: #cbd5e1; }
  .row-list { list-style: none; margin: 1.5cqw 0 0; padding: 0; }
  .row-list li { display: flex; justify-content: space-between; align-items: center; gap: 1.8cqw; padding: 1.5cqw 2.1cqw; background: rgba(255,255,255,0.03); border-radius: 1.5cqw; margin-bottom: 0.9cqw; font-size: 2.1cqw; }
  .row-list li .meta { color: #94a3b8; display: flex; align-items: center; gap: 1cqw; }
  .row-list li .meta b { color: #cbd5e1; font-weight: 400; }
  .row-list li .remove { padding: 0.6cqw 1.5cqw; font-size: 1.8cqw; border-radius: 1.2cqw; border: 1px solid rgba(255,255,255,0.2); color: #cbd5e1; }
  .chips { display: flex; flex-wrap: wrap; gap: 1.5cqw; margin: 0.6cqw 0 2.1cqw; }
  .chip { display: inline-flex; align-items: center; gap: 1.2cqw; padding: 1.5cqw 2.4cqw; border-radius: 999px; border: 1px solid rgba(255,255,255,0.15); background: rgba(255,255,255,0.04); color: #cbd5e1; font-size: 2.3cqw; }
  .chip.selected { background: rgba(59,130,246,0.2); border-color: rgba(59,130,246,0.6); color: #f1f5f9; }
  .field-label { display: block; font-size: 1.95cqw; color: #cbd5e1; margin: 2.1cqw 0 0.9cqw; }
  .field { width: 100%; padding: 1.5cqw 1.8cqw; border-radius: 1.5cqw; background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.1); color: #f1f5f9; font-size: 2.1cqw; box-sizing: border-box; }
  .field.muted { color: #545863; }
  .field-row { display: flex; gap: 1.2cqw; margin-bottom: 1.5cqw; }
  .field-row .field.grow { flex: 1; }
  .field-row .field.narrow { width: 15%; text-align: center; }
  .field-row .btn.add { flex-shrink: 0; width: auto; padding: 1.5cqw 2.7cqw; }
  .progress-row { display: flex; align-items: center; gap: 2.1cqw; margin-bottom: 3cqw; }
  .progress-track { flex: 1; height: 0.9cqw; background: rgba(255,255,255,0.08); border-radius: 999px; overflow: hidden; }
  .progress-fill { height: 100%; background: #3b82f6; }
  .progress-label { font-size: 1.95cqw; color: #94a3b8; white-space: nowrap; }
  .pills { display: flex; flex-wrap: wrap; gap: 1.2cqw; margin: 0.6cqw 0 1.8cqw; }
  .pill { padding: 1cqw 2.1cqw; border-radius: 1.5cqw; font-size: 1.95cqw; background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.15); color: #cbd5e1; }
  .pill.selected { background: rgba(59,130,246,0.22); border-color: rgba(59,130,246,0.65); color: #f1f5f9; }
  .stat-line { font-size: 2.3cqw; color: #e7e7ea; margin: 0 0 1.2cqw; }
  .stat-line b { font-weight: 700; }
  .stat-sub { font-size: 2.1cqw; color: #94a3b8; margin: 0 0 1.2cqw; }
  .nav-row { display: flex; gap: 2.1cqw; margin-top: 1.2cqw; }
  .nav-row .btn { flex: 1; }
`;

// --- content: exact copy reused from the Android Play Store screenshots ----

const coachingScreen = ({ eyebrowSub, stats, messages, closeLabel = 'Close tab' }) => `
  <div class="coach-col">
    <div class="coach-eyebrow">INTENTION</div>
    <div class="coach-subtitle">${eyebrowSub}</div>
    <div class="coach-stats">
      ${stats.map(([v, l]) => `<div class="coach-stat"><b>${v}</b> <span>${l}</span></div>`).join('')}
    </div>
    <div class="coach-messages">
      ${messages.map(m => m.role === 'user'
        ? `<div class="coach-msg user"><b>You — </b>${m.text}</div>`
        : `<div class="coach-msg assistant">${m.text}</div>`).join('')}
    </div>
  </div>
  <div class="coach-bottom">
    <div class="coach-composer"><span class="ph">Type your reply…</span><span class="send">Send</span></div>
    <div class="coach-close">${closeLabel}</div>
  </div>
`;

const screen1 = coachingScreen({
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

const screen3 = coachingScreen({
  eyebrowSub: 'x.com — let’s check in before you go through',
  stats: [['12m', 'Today'], ['94m', 'Week'], ['640m', 'Year'], ['1210m', 'All Time']],
  messages: [
    { role: 'assistant', text: 'Hey. I see you’ve opened x.com. What’s going on — what are you hoping to get out of it?' },
    { role: 'user', text: 'I need to check a DM from my study group about tomorrow’s deadline, then I’m done' },
    { role: 'assistant', text: 'Got it, that’s specific and time-bound. I’ll give you 5 minutes to check that DM and reply. Checking back in when the time’s up.' },
    { role: 'assistant', text: 'Go on, enjoy. See you in 5.' },
  ],
});

const websiteChips = [
  chip('x.com', true), chip('twitter.com', false), chip('youtube.com', true), chip('reddit.com', false),
  chip('instagram.com', true), chip('tiktok.com', true), chip('facebook.com', false), chip('twitch.tv', false),
  chip('netflix.com', false), chip('linkedin.com', false),
].join('');

const rowItem = (label, minutes = 10) => `
  <li><span class="meta"><b>${label}</b></span><span class="meta">Absolute Max: ${minutes} min/day</span><span class="remove">Remove</span></li>
`;

const screen2 = `
  <div class="opt-col">
    <div class="card">
      <div class="opt-header" style="margin-bottom:0">
        <h2 style="font-size:3cqw;margin-bottom:0.3cqw">Use the internet with <i>Intention</i></h2>
        <p class="subtitle" style="margin-bottom:2.4cqw">A few quick steps to set up your coach.</p>
      </div>
      <div class="progress-row">
        <div class="progress-track"><div class="progress-fill" style="width:25%"></div></div>
        <span class="progress-label">Step 1 of 4</span>
      </div>
    </div>
    <div class="card">
      <h3>Which websites pull you in?</h3>
      <p class="subtitle">Tap the common ones, or add your own below. Each gets a 10 min/day absolute max you can adjust.</p>
      <div class="chips">${websiteChips}</div>
      <p class="subtitle" style="margin-bottom:0.9cqw">Add another website &amp; absolute max</p>
      <div class="field-row">
        <span class="field grow muted">e.g. news.ycombinator.com</span>
        <span class="field narrow">10</span>
        <span class="btn primary add">Add</span>
      </div>
      <ul class="row-list">
        ${rowItem('x.com')}
        ${rowItem('youtube.com')}
        ${rowItem('instagram.co…')}
        ${rowItem('tiktok.com')}
      </ul>
    </div>
    <div class="card">
      <h3>Which apps pull you in?</h3>
      <p class="subtitle">Tap the common ones, or search your installed apps. Same 10 min/day absolute max.</p>
      <div class="chips">
        ${chip('instagram.com', true)}${chip('tiktok.com', true)}${chip('youtube.com', true)}${chip('x.com', false)}
        ${chip('reddit.com', false)}${chip('facebook.com', false)}<span class="chip">Snapchat</span>${chip('twitch.tv', false)}
        ${chip('netflix.com', false)}${chip('linkedin.com', false)}
      </div>
      <p class="subtitle" style="margin-bottom:0.9cqw">Search installed apps</p>
      <div class="field-row"><span class="field grow muted" style="flex:1">e.g. Instagram</span></div>
      <ul class="row-list">
        ${rowItem('Instagram')}
        ${rowItem('TikTok')}
        ${rowItem('YouTube')}
      </ul>
    </div>
  </div>
`;

const screen4 = `
  <div class="opt-col">
    <div class="opt-header">
      <h1><i>Intention</i></h1>
      <p>Your coach, your sites, your rules.</p>
    </div>
    <div class="card">
      <h2>Your coach’s context</h2>
      <p class="subtitle">The coach updates this only through conversation with you, so you can’t silently rewrite the rules in a weak moment.</p>
      <blockquote>Alex is a second-year CS student finishing a dissertation on distributed systems. Biggest trigger is opening Instagram or X ‘just for a second’ while stuck on a hard problem, which turns into 40+ minutes of scrolling. Wants to protect deep-work blocks in the mornings, and is trying to reply to messages with intention instead of reflexively checking every app.</blockquote>
      <span class="btn secondary">Talk with your coach</span>
    </div>
    <div class="card">
      <h2>Today</h2>
      <p class="stat-line"><b>23 min</b> on blocked sites today.</p>
      <p class="stat-sub">instagram.com: 14m &middot; x.com: 9m</p>
      <p class="stat-sub" style="margin-bottom:0">Past 7 days: <b style="color:#e7e7ea">187 min</b>.</p>
    </div>
    <div class="card">
      <h2>Blocked sites</h2>
      <p class="subtitle">Add domains you want to be mindful about. Tap the common ones, or add your own below.</p>
      <div class="chips">${websiteChips}</div>
      <div class="field-row">
        <span class="field grow muted">e.g. twitter.com</span>
        <span class="field narrow">10</span>
        <span class="btn primary add">Add</span>
      </div>
      <ul class="row-list">
        ${rowItem('instagram.co…')}
        ${rowItem('x.com')}
      </ul>
    </div>
  </div>
`;

const modelPills = [
  ['claude-sonnet-5 (default)', true], ['claude-fable-5', false], ['claude-opus-4-8', false],
  ['claude-haiku-4-5', false], ['Custom…', false],
];

const screen5 = `
  <div class="opt-col">
    <div class="card">
      <div class="opt-header" style="margin-bottom:0">
        <h2 style="font-size:3cqw;margin-bottom:0.3cqw">Use the internet with <i>Intention</i></h2>
        <p class="subtitle" style="margin-bottom:2.4cqw">A few quick steps to set up your coach.</p>
      </div>
      <div class="progress-row">
        <div class="progress-track"><div class="progress-fill" style="width:100%"></div></div>
        <span class="progress-label">Step 4 of 4</span>
      </div>
    </div>
    <div class="card">
      <h3>Choose your LLM provider</h3>
      <p class="subtitle">Intention uses the LLM you choose. You bring your own API key. Nothing leaves your machine except calls to that provider.</p>
      <span class="field-label">Provider</span>
      <div class="field" style="margin-bottom:2.1cqw">Anthropic (Claude)</div>
      <span class="field-label" style="margin-top:0">Model</span>
      <div class="pills">
        ${modelPills.map(([label, sel]) => `<span class="pill${sel ? ' selected' : ''}">${label}</span>`).join('')}
      </div>
      <div class="field muted" style="margin-bottom:2.1cqw">claude-sonnet-5 / claude-fable-5 / claude-opus-4-8</div>
      <span class="field-label">API key</span>
      <div class="field">&bull;&bull;&bull;&bull;&bull;&bull;&bull;&bull;&bull;&bull;&bull;&bull;&bull;&bull;&bull;&bull;&bull;&bull;&bull;&bull;&bull;&bull;</div>
    </div>
    <div class="nav-row">
      <span class="btn secondary">Back</span>
      <span class="btn primary">Finish Setup &amp; Start</span>
    </div>
  </div>
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
