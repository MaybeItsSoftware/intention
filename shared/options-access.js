// options-access.js - coaching credit: buying it, restoring it, and the
// paywall shown when there is none.
//
// The rule this file exists to keep in one place: an entitlement is only ever
// trusted after the backend has verified the store receipt. Nothing here
// decides on its own that someone has paid.

// ---------------------------------------------------------------------------
// AI access: coaching-credit purchase, restore, and the paywall
// ---------------------------------------------------------------------------

function getAccessState() {
  return sendBg({ action: 'getAccess' });
}

function persistEntitlement(entitlement) {
  return sendBg({ action: 'saveEntitlement', entitlement });
}

async function currentBackendUrl() {
  const state = await getConfig();
  return state?.backendUrl || '';
}

// Hands the store's receipt to the backend, which checks it with Apple/Google
// and mints the token coach calls are made with. A purchase we can't confirm
// right now is kept (with its receipt) rather than thrown away, so the retry on
// the next load can turn it into access without charging anyone twice.
async function verifyAndStore(platform, receipt) {
  const backendUrl = await currentBackendUrl();
  try {
    const entitlement = await verifyPurchase({ platform, receipt, backendUrl });
    await persistEntitlement(entitlement);
    return entitlement;
  } catch (e) {
    await persistEntitlement({
      active: false,
      source: platform,
      receipt,
      pendingVerification: true,
      lastError: String(e.message || e)
    });
    throw new Error("Your purchase went through, but we couldn't confirm it yet. It'll be applied automatically — reopen Settings to retry.");
  }
}

// Re-checks a stored entitlement against the backend — a purchase that
// couldn't be verified when it was made, or (rarely) a stored token that's
// simply missing. There's no renewal to pre-empt for a top-up, so unlike the
// old subscription version, this only re-checks when something is actually
// unresolved rather than on a timer.
async function reconcileEntitlement(entitlement) {
  if (!entitlement) return null;
  const stale = entitlement.pendingVerification || !entitlement.token;
  if (!stale) return entitlement;
  const backendUrl = await currentBackendUrl();
  const refreshed = await refreshEntitlement(entitlement, backendUrl);
  if (refreshed && entitlementSignature(refreshed) !== entitlementSignature(entitlement)) {
    await persistEntitlement(refreshed);
  }
  return refreshed;
}

async function refreshAccessUI(containerId, { compact = false } = {}) {
  const container = document.getElementById(containerId);
  if (!container) return;
  const access = await getAccessState();
  const entitlement = access?.entitlement || null;

  const rerender = () => refreshAccessUI(containerId, { compact });

  await renderPaywall(container, {
    entitlement,
    compact,
    // A custom key is access too, but it leaves no entitlement behind — without
    // this the paywall keeps asking for one after the key is already working.
    route: access?.route || null,
    onPurchase: async (productId) => {
      const result = await purchaseProduct(productId);
      if (!result || result.status === 'cancelled') return;
      if (result.status === 'pending') {
        throw new Error('Your purchase is pending approval. It will unlock automatically once approved.');
      }
      if (result.status !== 'purchased') {
        throw new Error(result.error || "The purchase didn't complete.");
      }
      await verifyAndStore(result.platform || storePlatform(), result.receipt);
      await rerender();
      await onAccessChanged();
    },
    onRestore: async () => {
      const result = await restorePurchases();
      if (!result || !result.receipt) {
        throw new Error(result?.error || 'No pending purchase found.');
      }
      await verifyAndStore(result.platform || storePlatform(), result.receipt);
      await rerender();
      await onAccessChanged();
    },
    onRedeem: async (code) => {
      const backendUrl = await currentBackendUrl();
      const entitlement = await redeemAccessCode(code, backendUrl);
      if (!entitlementIsActive(entitlement)) throw new Error('That code isn\'t active.');
      await persistEntitlement(entitlement);
      await rerender();
      await onAccessChanged();
    },
    // A store-issued code (App Store promo / Play promo), redeemed through
    // the store's own sheet — a different thing from onRedeem's access code,
    // which only moves an existing balance to a browser. This one grants.
    onRedeemStoreCode: async () => {
      const result = await redeemStoreCode();
      if (!result || result.status === 'cancelled') return;
      if (result.status === 'none') {
        throw new Error('No redeemed code was found. If you have just redeemed one, give it a moment and try again.');
      }
      if (result.status !== 'purchased') {
        throw new Error(result.error || "That code didn't unlock anything.");
      }
      await verifyAndStore(result.platform || storePlatform(), result.receipt);
      await rerender();
      await onAccessChanged();
    },
    onLinkBrowser: async () => {
      const backendUrl = await currentBackendUrl();
      return requestAccessCode(entitlement, backendUrl);
    },
    // Offered wherever a store doesn't forbid it: Chrome/Firefox, where it is
    // the way in, and Android, where it sits under the purchase buttons as an
    // alternative. On Apple it stays null and lives solely in Settings ->
    // Advanced (see BYOK_IS_OFFERED in billing.js for why the two differ).
    //
    // Entering the key in place, rather than jumping to a disclosure inside a
    // disclosure, is reserved for builds where BYOK leads — and only in the
    // full-size paywall. The compact one renders inside a blocked page, which
    // is the worst possible moment to ask someone to go and fetch a key.
    onUseOwnKey: BYOK_IS_OFFERED ? () => openAdvancedKeySection() : null,
    onSaveKey: BYOK_IS_PRIMARY && !compact ? async ({ provider, apiKey, model }) => {
      await sendBg({ action: 'saveSettings', config: { provider, apiKey, model } });
      await rerender();
      await onAccessChanged();
    } : null
  });

  // A verified purchase that arrived while the app was closed settles here.
  const reconciled = await reconcileEntitlement(entitlement);
  if (entitlementSignature(reconciled) !== entitlementSignature(entitlement)) {
    await refreshAccessUI(containerId, { compact });
    await onAccessChanged();
  }
}

function storePlatform() {
  return HAS_APP_BLOCKING ? 'google' : 'apple';
}

// Called after any change that can flip the access route, so the settings view
// stops offering a locked coach (or starts offering an unlocked one).
async function onAccessChanged() {
  const access = await getAccessState();
  const modal = document.getElementById('paywall-modal');
  if (access?.route !== 'locked' && modal && !modal.hidden) modal.hidden = true;
}

// The setup wizard and the settings view both need a way to send someone who
// is locked out to the purchase flow without derailing what they were doing.
async function openPaywallModal() {
  const modal = document.getElementById('paywall-modal');
  modal.hidden = false;
  await refreshAccessUI('paywall-modal-body', { compact: true });
}

async function openAdvancedKeySection() {
  // Reached from the onboarding paywall on browser and Android builds: the
  // advanced field lives in the settings view, so the wizard has to be
  // committed first or the click would silently do nothing behind a hidden
  // view. Committing is safe by then — the access step is the last thing
  // before "done", and blocking is already configured either way.
  if (!document.getElementById('setup-view').hidden) {
    await finishSetup();
  }
  setSettingsSection('settings');
  const advanced = document.getElementById('advanced-card');
  const keyDetails = document.getElementById('custom-key-details');
  const modal = document.getElementById('paywall-modal');
  if (modal) modal.hidden = true;
  if (advanced) advanced.open = true;
  if (keyDetails) {
    keyDetails.open = true;
    keyDetails.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
  document.getElementById('api-key-input-2')?.focus();
}

// Every coach entry point funnels through this: with no access, the paywall
// opens instead of a conversation that would only fail at the LLM call.
async function requireAccess() {
  const access = await getAccessState();
  if (access?.route === 'locked') {
    await openPaywallModal();
    return false;
  }
  return true;
}
