// ---------------------------------------------------------------------------
// Hosted AI access: in-app purchases, entitlement bookkeeping, paywall UI.
// ---------------------------------------------------------------------------
//
// Intention's coach runs on Intention's own backend, which holds the LLM
// provider key. Access to it is sold through the platform's own in-app
// purchase system — StoreKit on Apple, Play Billing on Android — surfaced to
// this layer as `window.intentionBilling` by ios-bridge.js / android-bridge.js.
// That bridge is the ONLY way anything is bought here: no checkout page, no
// outside link, no key to fetch from a third party.
//
// This file is page-side only (options.html, coaching.html). The background
// worker needs just the entitlement predicate and the hosted transport, which
// live in providers.js so the worker doesn't have to load a UI module.

// How the AI plan can be bought or managed *on this build*:
//
//   'store'   — a native store bridge is present (the iOS/macOS app, the
//               Android app). Apple IAP / Google Play Billing, and nothing
//               else, may be offered.
//   'managed' — an Apple platform with no bridge: the Safari web extension's
//               own pages, which ship inside the same App Store app. Access is
//               bought in the app and syncs across; never show a key field or
//               an outside link here either.
//   'byok'    — Chrome / Firefox. There is no store to buy through in a
//               browser extension, so a user-supplied provider key stays a
//               first-class, visible option on these builds.
function detectBillingMode() {
  if (typeof window !== 'undefined' && window.intentionBilling) return 'store';
  const ua = (typeof navigator !== 'undefined' && navigator.userAgent) || '';
  const isApple = /Safari/.test(ua) && !/Chrome|Chromium|Android/.test(ua);
  return isApple ? 'managed' : 'byok';
}

const BILLING_MODE = detectBillingMode();

// Whether a user-supplied provider key may be offered as a starting option.
// Everywhere Apple or Google review the build, it may not — it stays reachable
// only from Settings -> Advanced, which is what STORE_MODES gates.
const STORE_MODES = ['store', 'managed'];
const BYOK_IS_PRIMARY = !STORE_MODES.includes(BILLING_MODE);

function sendBilling(method, arg) {
  return new Promise(resolve => {
    if (!window.intentionBilling || typeof window.intentionBilling[method] !== 'function') {
      resolve({ available: false });
      return;
    }
    if (arg === undefined) window.intentionBilling[method](resolve);
    else window.intentionBilling[method](arg, resolve);
  });
}

// ---- Store bridge ----------------------------------------------------------

// Resolves { available, products: [{ id, title, description, price, period,
// type }] }. `price` is already localized and formatted by the store.
function fetchStoreProducts() {
  return sendBilling('products');
}

// Resolves { status: 'purchased' | 'cancelled' | 'pending' | 'failed',
// receipt?, error? }. `receipt` is whatever the backend needs to verify with
// the store: Apple's signed transaction (JWS), or Play's purchase token.
function purchaseProduct(productId) {
  return sendBilling('purchase', productId);
}

function restorePurchases() {
  return sendBilling('restore');
}

function storeEntitlementStatus() {
  return sendBilling('status');
}

// ---- Backend verification --------------------------------------------------

async function postBackend(backendUrl, path, body) {
  const base = (backendUrl || DEFAULT_INTENTION_BACKEND_URL).replace(/\/+$/, '');
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  let data = null;
  try { data = await res.json(); } catch (e) {}
  if (!res.ok) {
    const err = new Error((data && data.error) || `Backend ${res.status}`);
    err.code = (data && data.code) || 'backend_error';
    throw err;
  }
  return data || {};
}

// Hands the store's proof-of-purchase to Intention's backend, which checks it
// with Apple/Google and mints the access token the coach calls are made with.
// Returns the entitlement to persist.
async function verifyPurchase({ platform, receipt, backendUrl }) {
  const data = await postBackend(backendUrl, '/v1/entitlement/verify', { platform, receipt });
  return normalizeEntitlement({ ...data, source: platform, receipt });
}

// Re-checks a stored entitlement's live balance. Falls back to the entitlement
// we already hold if the backend can't be reached, so a flaky connection never
// locks a paying user out mid-flight.
async function refreshEntitlement(entitlement, backendUrl) {
  if (!entitlement || (!entitlement.token && !entitlement.receipt)) return entitlement || null;
  try {
    const data = entitlement.token
      ? await postBackend(backendUrl, '/v1/entitlement/refresh', { token: entitlement.token })
      : await postBackend(backendUrl, '/v1/entitlement/verify', {
          platform: entitlement.source,
          receipt: entitlement.receipt
        });
    return normalizeEntitlement({ ...data, source: entitlement.source, receipt: entitlement.receipt });
  } catch (e) {
    // A rejected token is not necessarily a dead entitlement: tokens now age
    // out at an absolute lifetime, and the stored receipt is the durable
    // proof. Re-verify from it before declaring the entitlement dead.
    if (e.code === 'entitlement_invalid' || e.code === 'entitlement_expired') {
      if (entitlement.receipt && entitlement.source && entitlement.source !== 'code') {
        try {
          const data = await postBackend(backendUrl, '/v1/entitlement/verify', {
            platform: entitlement.source,
            receipt: entitlement.receipt
          });
          return normalizeEntitlement({ ...data, source: entitlement.source, receipt: entitlement.receipt });
        } catch (e2) {
          // fall through: the receipt itself no longer verifies either
        }
      }
      return { ...entitlement, active: false, pendingVerification: false, lastError: e.code };
    }
    return { ...entitlement, pendingVerification: true, lastError: String(e.message || e) };
  }
}

// Browser builds have no store to buy through. An access code, generated in
// the mobile app for an existing balance, links this browser to the same
// account — no payment happens here.
async function redeemAccessCode(code, backendUrl) {
  const data = await postBackend(backendUrl, '/v1/entitlement/redeem', { code: String(code || '').trim() });
  return normalizeEntitlement({ ...data, source: 'code' });
}

// The other half of that: an app with coaching credit mints the code its
// owner types into their browser. Nothing is sold here — it links a device to
// an account that already has credit bought through the store.
async function requestAccessCode(entitlement, backendUrl) {
  if (!entitlement || !entitlement.token) throw new Error('No coaching credit on this device yet.');
  const base = (backendUrl || DEFAULT_INTENTION_BACKEND_URL).replace(/\/+$/, '');
  const res = await fetch(`${base}/v1/entitlement/code`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'authorization': `Bearer ${entitlement.token}`
    },
    body: '{}'
  });
  let data = null;
  try { data = await res.json(); } catch (e) {}
  if (!res.ok) throw new Error((data && data.error) || `Backend ${res.status}`);
  return data;
}

function normalizeEntitlement(raw) {
  if (!raw) return null;
  return {
    active: !!raw.active,
    productId: raw.productId || '',
    // The server never sends this for a top-up (no renewal to expire) — kept
    // as an always-falsy field so entitlementIsActive() (providers.js), which
    // treats "no expiresAt" as active forever, needs no change.
    expiresAt: raw.expiresAt ? Number(raw.expiresAt) : null,
    source: raw.source || '',
    token: raw.token || '',
    receipt: raw.receipt || null,
    balanceMicros: Number(raw.balanceMicros || 0),
    balanceGbp: Number(raw.balanceGbp || 0),
    balanceCredits: Number(raw.balanceCredits || 0),
    pendingVerification: !!raw.pendingVerification,
    lastError: raw.lastError || '',
    updatedAt: Date.now()
  };
}

// What actually matters about an entitlement, for "did this change?" checks.
// A plain deep-compare is useless here: normalizeEntitlement re-stamps
// `updatedAt` every time, so every refresh would look like a change and the
// caller would re-render (and re-hit the backend) forever. balanceCredits is
// included so a balance change after a chat message is itself detected as a
// change, even when active/token/productId all hold.
function entitlementSignature(entitlement) {
  if (!entitlement) return 'none';
  return [
    entitlement.active ? 1 : 0,
    entitlement.token || '',
    entitlement.productId || '',
    entitlement.balanceCredits || 0,
    entitlement.pendingVerification ? 1 : 0
  ].join('|');
}

// Deliberately shown as "tokens," not a £ figure: what a top-up actually
// credits is net of the store's commission and Intention's own margin
// (server/src/config.js's creditMicrosForTopUp), so a currency amount here
// would look like a broken conversion rather than the game-currency balance
// it actually is.
function formatBalance(entitlement) {
  if (!entitlement) return '';
  const credits = Number(entitlement.balanceCredits || 0);
  return `You have ${credits.toLocaleString()} coaching credits.`;
}

// ---- Paywall ---------------------------------------------------------------

const PAYWALL_BENEFITS = [
  'Your coach, on every blocked site and app',
  'Pay once for a set amount of credit — no recurring charge',
  'Top up again any time your balance runs low'
];

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

// Renders the access UI into `container`.
//
// opts:
//   entitlement   currently stored entitlement (may be null)
//   onPurchase(productId)   -> Promise, called for a store purchase
//   onRestore()             -> Promise, recovers an interrupted purchase
//   onRedeem(code)          -> Promise         (byok builds only)
//   onUseOwnKey()           -> void, optional  (byok builds only)
//   onLinkBrowser()         -> Promise, optional (store builds only)
//   compact                 tighter layout for the in-gate paywall
//
// Copy discipline, deliberately: on store/managed builds this never names an
// LLM vendor, never mentions API keys, and never renders a link out of the app
// — the only way to pay from here is the platform's own purchase sheet.
//
// A top-up is always repurchasable, so unlike the old subscription paywall
// this never stops at "you're covered" — a positive balance still falls
// through to the purchase buttons (as "add more"), it just leads with a
// balance line instead of a lede.
async function renderPaywall(container, opts = {}) {
  const { entitlement, onPurchase, onRestore, onRedeem, onUseOwnKey, compact } = opts;
  container.innerHTML = '';
  container.className = 'int-paywall' + (compact ? ' int-paywall-compact' : '');

  const errorEl = el('div', 'int-pw-error');
  errorEl.hidden = true;

  const setError = (msg) => {
    errorEl.textContent = msg || '';
    errorEl.hidden = !msg;
  };

  // Plan buttons stack their price and description in child elements, so their
  // label can't be swapped for "Working…" without flattening them — those just
  // grey out instead.
  const busy = (node, on, label) => {
    node.disabled = on;
    if (node.firstElementChild) return;
    if (on) {
      node.dataset.idleLabel = node.textContent;
      node.textContent = label || 'Working…';
    } else if (node.dataset.idleLabel) {
      node.textContent = node.dataset.idleLabel;
    }
  };

  const active = entitlement && entitlementIsActive(entitlement);

  if (active) {
    const status = el('div', 'int-pw-status');
    status.appendChild(el('strong', null, 'Coaching credit'));
    status.appendChild(el('p', 'int-pw-sub', formatBalance(entitlement)));
    container.appendChild(status);

    // Same balance, other devices: a browser has no store to buy through,
    // so it's linked with a short-lived code minted here instead.
    if (opts.onLinkBrowser && BILLING_MODE === 'store' && !compact) {
      const linkBtn = el('button', 'secondary int-pw-link', 'Link a browser');
      linkBtn.type = 'button';
      const codeOut = el('p', 'int-pw-sub');
      codeOut.hidden = true;
      linkBtn.addEventListener('click', async () => {
        setError('');
        busy(linkBtn, true, 'Generating…');
        try {
          const result = await opts.onLinkBrowser();
          codeOut.textContent = `Enter ${result.code} in Intention's settings in your browser. It expires in 15 minutes.`;
          codeOut.hidden = false;
        } catch (e) {
          setError(String(e.message || e));
        } finally {
          busy(linkBtn, false);
        }
      });
      container.appendChild(linkBtn);
      container.appendChild(codeOut);
    }
  } else {
    container.appendChild(el('p', 'int-pw-lede', compact
      ? 'Buy coaching credit to talk to your coach.'
      : 'Coaching credit turns on your coach. Pay once for a set amount — no recurring charge.'));

    if (!compact) {
      const list = el('ul', 'int-pw-benefits');
      for (const benefit of PAYWALL_BENEFITS) list.appendChild(el('li', null, benefit));
      container.appendChild(list);
    }
  }

  if (BILLING_MODE === 'managed') {
    if (!active) {
      container.appendChild(el('p', 'int-pw-note',
        'Open the Intention app on this device to buy coaching credit. It applies here automatically.'));
    }
    container.appendChild(errorEl);
    return;
  }

  if (BILLING_MODE === 'store') {
    const plansEl = el('div', 'int-pw-plans');
    plansEl.appendChild(el('p', 'int-pw-sub', 'Loading top-ups…'));
    container.appendChild(plansEl);

    const restoreBtn = el('button', 'secondary int-pw-restore', 'Recover an interrupted purchase');
    restoreBtn.type = 'button';
    container.appendChild(restoreBtn);
    container.appendChild(errorEl);

    restoreBtn.addEventListener('click', async () => {
      setError('');
      busy(restoreBtn, true, 'Checking…');
      try {
        await onRestore();
      } catch (e) {
        setError(String(e.message || e));
      } finally {
        busy(restoreBtn, false);
      }
    });

    const result = await fetchStoreProducts();
    plansEl.innerHTML = '';
    const products = (result && result.products) || [];
    if (!products.length) {
      plansEl.appendChild(el('p', 'int-pw-sub',
        (result && result.error) || 'Top-ups are unavailable right now. Please try again in a moment.'));
      return;
    }
    if (active) {
      plansEl.appendChild(el('p', 'int-pw-sub', 'Add more coaching credit:'));
    }
    for (const product of products) {
      const btn = el('button', 'primary int-pw-plan');
      btn.type = 'button';
      btn.appendChild(el('span', 'int-pw-plan-title', product.title || 'Coaching credit'));
      if (product.price) btn.appendChild(el('span', 'int-pw-plan-price', product.price));
      if (product.description) btn.appendChild(el('span', 'int-pw-plan-desc', product.description));
      btn.addEventListener('click', async () => {
        setError('');
        busy(btn, true, 'Opening store…');
        try {
          await onPurchase(product.id);
        } catch (e) {
          setError(String(e.message || e));
        } finally {
          busy(btn, false);
        }
      });
      plansEl.appendChild(btn);
    }
    return;
  }

  // 'byok' — Chrome / Firefox. Already-linked credit has nothing further to
  // show here; there's no purchase path in a browser extension either way.
  if (active) {
    container.appendChild(errorEl);
    return;
  }

  const codeWrap = el('div', 'int-pw-code');
  codeWrap.appendChild(el('label', null, 'Already have coaching credit? Enter your access code'));
  const codeRow = el('div', 'input-group');
  const codeInput = el('input');
  codeInput.type = 'text';
  codeInput.id = 'int-pw-code-input';
  codeInput.placeholder = 'INT-XXXX-XXXX';
  const codeBtn = el('button', 'primary', 'Unlock');
  codeBtn.type = 'button';
  codeRow.appendChild(codeInput);
  codeRow.appendChild(codeBtn);
  codeWrap.appendChild(codeRow);
  codeWrap.appendChild(el('p', 'int-pw-sub', 'Generate a code in the Intention mobile app under Settings → AI access.'));
  container.appendChild(codeWrap);

  codeBtn.addEventListener('click', async () => {
    const code = codeInput.value.trim();
    if (!code) return;
    setError('');
    busy(codeBtn, true, 'Checking…');
    try {
      await onRedeem(code);
    } catch (e) {
      setError(String(e.message || e));
    } finally {
      busy(codeBtn, false);
    }
  });

  if (onUseOwnKey) {
    const divider = el('div', 'int-pw-divider', 'or');
    container.appendChild(divider);
    const keyBtn = el('button', 'secondary int-pw-byok', 'Use your own API key');
    keyBtn.type = 'button';
    keyBtn.addEventListener('click', () => onUseOwnKey());
    container.appendChild(keyBtn);
  }

  container.appendChild(errorEl);
}
