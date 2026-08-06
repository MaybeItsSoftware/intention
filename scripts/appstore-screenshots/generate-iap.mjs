// Generates the per-product "review screenshot" App Store Connect requires
// for every in-app purchase. Unlike the marketing screenshots next door, this
// one is not a mockup: App Review wants to see where the purchase actually
// appears in the app, so the page below loads the real shared/billing.js and
// calls the real renderPaywall() against the real shared/options.css. Nothing
// here restates the paywall's markup or copy — change the paywall and these
// screenshots follow on the next run.
//
// The product list comes from Intention.storekit, the same file the StoreKit
// testing configuration reads, so prices and names can't drift from what the
// store actually offers either.
//
// Usage: node scripts/appstore-screenshots/generate-iap.mjs

import { chromium } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { fontFaceCss } from './content.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SHARED = path.join(REPO_ROOT, 'shared');
const FONTS_DIR = path.join(SHARED, 'fonts');
const STOREKIT = path.join(REPO_ROOT, 'Intention Apple', 'Shared (App)', 'Intention.storekit');
const OUT_DIR = path.join(REPO_ROOT, 'Intention Apple', 'appstore', 'iap');

// App Store Connect requires at least 640x920. Rendering at iPhone logical
// size with a 3x device pixel ratio gives 1242x2688 — a real device screenshot
// shape rather than a desktop page shrunk down, which is what review expects.
const VIEWPORT = { width: 414, height: 896 };
const SCALE = 3;

// Ring the plan the screenshot is filed against. Each product needs its own
// screenshot and all three plans are on screen at once, so without this the
// three uploads would be pixel-identical and reviewers would have to guess
// which product each was meant to show.
const HIGHLIGHT = true;

// --- product list, straight from the StoreKit configuration -----------------

// displayPrice in a .storekit file is a bare number ("0.99"); on device,
// StoreKit hands the same field back already localized ("£0.99"). These are
// GBP-priced products, so format them the way the store will.
const formatPrice = (displayPrice) => `£${Number(displayPrice).toFixed(2)}`;

function loadProducts() {
  const storekit = JSON.parse(fs.readFileSync(STOREKIT, 'utf8'));
  return storekit.products
    .map((product) => {
      const loc = product.localizations.find((l) => l.locale === 'en_US') || product.localizations[0];
      return {
        id: product.productID,
        title: loc.displayName,
        description: loc.description,
        price: formatPrice(product.displayPrice),
        type: 'one-time',
        sortPrice: Number(product.displayPrice),
      };
    })
    // Cheapest first, matching IntentionStore.products() — the order a
    // reviewer will actually see on device.
    .sort((a, b) => a.sortPrice - b.sortPrice);
}

// --- page ------------------------------------------------------------------

// options.css declares its own @font-face against a relative fonts/ path,
// which resolves to nothing for a page set via setContent. Drop those and use
// the base64-embedded faces the other generators already rely on.
function loadOptionsCss() {
  const css = fs.readFileSync(path.join(SHARED, 'options.css'), 'utf8');
  return fontFaceCss(FONTS_DIR) + css.replace(/^@font-face \{[^}]*\}\n?/gm, '');
}

// Inlining a script whose source contains the literal "</script>" would close
// the tag early. None currently do, but this is cheap insurance.
const inlineScript = (file) =>
  fs.readFileSync(path.join(SHARED, file), 'utf8').replace(/<\/script>/gi, '<\\/script>');

function buildHtml(products) {
  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
${loadOptionsCss()}

/* Not part of the app: marks which plan this particular upload documents. */
.iap-highlight {
  outline: 3px solid #60a5fa;
  outline-offset: 3px;
  border-radius: 12px;
}
</style></head>
<body>
  <div class="container">
    <main id="settings-view">
      <div class="settings-header">
        <h1>Intention</h1>
        <p class="muted">Your coach, your sites, your rules.</p>
      </div>

      <div id="section-tabs" class="settings-tabs section-tabs">
        <button type="button" class="tab-btn" data-section-tab="blocking">Blocking</button>
        <button type="button" class="tab-btn" data-section-tab="activity">Activity</button>
        <button type="button" class="tab-btn" data-section-tab="coach">Coach</button>
        <button type="button" class="tab-btn selected" data-section-tab="settings">Settings</button>
      </div>

      <section class="card" data-section="settings">
        <h2>AI access</h2>
        <div id="access-paywall"></div>
      </section>
    </main>
  </div>

  <script>
    // Stands in for ios-bridge.js's window.intentionBilling. It has to exist
    // before billing.js runs, because detectBillingMode() reads it at load and
    // only the 'store' mode renders purchase buttons at all.
    const PRODUCTS = ${JSON.stringify(products)};
    window.intentionBilling = {
      products: (cb) => cb({ available: true, products: PRODUCTS }),
      purchase: (id, cb) => cb({ status: 'failed' }),
      restore: (cb) => cb({ status: 'none' })
    };
  </script>
  <script>${inlineScript('providers.js')}</script>
  <script>${inlineScript('billing.js')}</script>
  <script>
    // No entitlement: the pre-purchase state, which is the one that shows the
    // buyable products.
    window.__ready = renderPaywall(document.getElementById('access-paywall'), {
      entitlement: null,
      onPurchase: async () => {},
      onRestore: async () => {}
    });
  </script>
</body></html>`;
}

// --- render ----------------------------------------------------------------

async function main() {
  const products = loadProducts();
  if (!products.length) throw new Error(`No products found in ${STOREKIT}`);

  fs.mkdirSync(OUT_DIR, { recursive: true });

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: SCALE });
  await page.setContent(buildHtml(products), { waitUntil: 'load' });
  await page.evaluate(() => window.__ready);
  await page.evaluate(() => document.fonts.ready);

  const rendered = await page.evaluate(() => document.querySelectorAll('.int-pw-plan').length);
  if (rendered !== products.length) {
    throw new Error(`Paywall rendered ${rendered} plan buttons, expected ${products.length}`);
  }

  // A review screenshot should look like something taken on a device, so this
  // clips to the viewport rather than capturing the full page. Warn instead of
  // silently cropping if the paywall has outgrown one screen.
  const overflow = await page.evaluate(() => document.body.scrollHeight - window.innerHeight);
  if (overflow > 0) {
    console.warn(`! Content overflows the viewport by ${overflow}px — the screenshot will be cropped.`);
  }

  for (const product of products) {
    await page.evaluate(({ title, highlight }) => {
      for (const btn of document.querySelectorAll('.int-pw-plan')) {
        const label = btn.querySelector('.int-pw-plan-title');
        btn.classList.toggle('iap-highlight', highlight && label?.textContent === title);
      }
    }, { title: product.title, highlight: HIGHLIGHT });

    const out = path.join(OUT_DIR, `${product.id}.png`);
    await page.screenshot({ path: out });
    console.log(`✓ ${product.id}  ${product.price}  ${path.relative(REPO_ROOT, out)}`);
  }

  await browser.close();
  console.log(`\n${products.length} review screenshots at ${VIEWPORT.width * SCALE}x${VIEWPORT.height * SCALE} in ${path.relative(REPO_ROOT, OUT_DIR)}/`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
