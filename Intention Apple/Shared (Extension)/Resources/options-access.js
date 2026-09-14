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

// The same write, but as a patch merged over whatever is stored right now
// rather than a whole-object replacement of a snapshot taken before an await.
//
// Every recovery write goes through this, because every one of them is on the
// far side of an unbounded network call. The purchase that completed while
// /v1/entitlement/recover was in flight — the user came back from the Play
// sheet, 'intention-app-active' fired, a second refreshAccessUI ran and
// persisted 5,000 credits — is the case that matters: the 404 arriving
// afterwards used to write back its own stale snapshot and take the receipt,
// the token and the balance with it. It took the money and locked the user out,
// and the recoveryCheckedAt it wrote in their place suppressed the re-check for
// a day. The merge itself is background.js's mergeEntitlement — named apart
// from this the way saveEntitlement is named apart from persistEntitlement,
// because one of the pair is a message and the other is the write.
function patchEntitlement(patch) {
  return sendBg({ action: 'mergeEntitlement', entitlement: patch });
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
//
// `route` is the resolved AI route, threaded through to the account-id
// question at the bottom of this — see RECOVERY_ROUTES in billing.js for why
// that is a different question from which build this is.
async function reconcileEntitlement(entitlement, route) {
  // Nothing to re-check against — no token, no receipt, quite possibly no
  // entitlement at all. This used to return immediately, and it is exactly the
  // shape a reinstall leaves behind: the balance is still on the server, the
  // account id is still on the device, and the only thing missing was anyone
  // asking. It is also the shape a brand-new user has, which is why the
  // question has to be asked silently and a "no" has to be silent too.
  if (!entitlement || (!entitlement.token && !entitlement.receipt)) {
    return recoverStrandedCredit(entitlement, { route });
  }
  const stale = entitlement.pendingVerification || !entitlement.token;
  if (!stale) return entitlement;
  const backendUrl = await currentBackendUrl();
  const refreshed = await refreshEntitlement(entitlement, backendUrl, { route });
  if (refreshed && entitlementSignature(refreshed) !== entitlementSignature(entitlement)) {
    await persistEntitlement(refreshed);
  }
  return refreshed;
}

// How long a "we asked, there was nothing" answer stands before it is worth
// asking again. /v1/entitlement/recover is unauthenticated and rate-limited
// per IP, so a settings page that re-asked on every open would burn the
// allowance of everyone behind the same office or campus NAT on behalf of one
// person opening a tab. A day is long enough to be free and short enough that
// an Android backup landing overnight is noticed by morning.
const RECOVERY_RECHECK_MS = 24 * 60 * 60 * 1000;

// `force` skips the marker: the manual "Restore credit from a previous
// install" button exists precisely for the person who knows something has
// changed since we last asked, and telling them to come back tomorrow would
// make the button a decoration. It is also the one caller that is allowed to
// hear about a failure, because it is the one somebody is watching.
async function recoverStrandedCredit(entitlement, { force = false, route = null } = {}) {
  // A browser build has no bridge, therefore no account id, therefore nothing
  // to ask with — and attemptSilentRecovery would correctly make no request.
  // The guard is here as well so that a fresh Chrome install does not get an
  // entitlement object written over its `null` purely to record a question we
  // were never going to ask.
  if (BILLING_MODE !== 'store') return entitlement || null;
  // And the same again for the route rather than the build, which is not the
  // same test: BILLING_MODE is 'store' on Android whether the coach is running
  // on our credit or on the user's own Anthropic key. attemptSilentRecovery
  // refuses 'byok' itself; stopping here as well means we also skip writing a
  // recoveryCheckedAt marker to record a question nobody was going to ask.
  // `force` is exempt, here and in attemptSilentRecovery's own guard: pressing
  // "Restore credit from a previous install" is itself the request, whatever
  // route the coach happens to be on.
  if (!force && !RECOVERY_ROUTES.includes(route)) return entitlement || null;

  const checkedAt = Number(entitlement?.recoveryCheckedAt || 0);
  if (!force && Date.now() - checkedAt < RECOVERY_RECHECK_MS) return entitlement || null;

  const backendUrl = await currentBackendUrl();
  let recovered = null;
  try {
    recovered = await attemptSilentRecovery(backendUrl, { route, userAsked: force });
  } catch (e) {
    // An opportunistic question must never be able to take the page down with
    // it, and this one could: nothing between here and options.js's
    // showSettingsView catches, so one offline /v1/entitlement/recover used to
    // abort the whole settings render — no blocked-site list, no mode card, no
    // stats, no buttons bound. A device that cannot reach the backend has
    // simply not been told anything, so nothing is written down (not even the
    // 24-hour marker, since we never got an answer to record) and the next
    // settings open asks again.
    if (force) throw e;
    return entitlement || null;
  }
  if (recovered) {
    // Merged, not replaced: /v1/entitlement/recover knows nothing about a
    // receipt, so writing its answer whole would delete the one we are holding.
    return (await patchEntitlement(recoveredPatch(recovered)))?.entitlement || recovered;
  }
  // Nothing attached to this device. Record only the fact that we asked, on
  // top of whatever is there NOW — a purchase may well have landed while the
  // question was in flight, and this used to overwrite it with a snapshot taken
  // before it existed.
  const marked = await patchEntitlement({ recoveryCheckedAt: Date.now() });
  return marked?.entitlement || { ...(entitlement || { active: false, source: '' }), recoveryCheckedAt: Date.now() };
}

// What a successful recovery actually learned, and nothing else.
//
// recoverEntitlement normalises its response like any other, which means it
// arrives carrying `receipt: null` — not because the receipt is gone but
// because that endpoint has never heard of one. Merging the whole object would
// therefore delete a perfectly good stored receipt, which is the only thing
// that can re-verify this device later. So the receipt is left out of the
// patch, and whatever is stored keeps standing.
function recoveredPatch(recovered) {
  const patch = { ...recovered };
  delete patch.receipt;
  return patch;
}

// Development convenience, and nothing else. env.txt is gitignored and is
// stripped from every release artefact, so loadEnv() finds no file in a
// shipped build and this returns null.
//
// It exists because the settings page's key card and the paywall's key card
// are two different pairs of elements, and only the first was ever wired to
// env.txt. `web-ext run` hands you a brand new profile on every single launch,
// so onboarding always opened on the wrong provider with an empty key field
// even with a perfectly good key sitting in the file beside it.
async function envKeyDefaults() {
  try {
    if (typeof loadEnv !== 'function') return null;
    const env = await loadEnv();
    if (!env) return null;
    const wanted = String(env.DEFAULT_PROVIDER || '').trim().toLowerCase();
    const provider = wanted && PROVIDERS[wanted] && !PROVIDERS[wanted].hosted ? wanted : '';
    const apiKey = (provider && env[`${provider.toUpperCase()}_API_KEY`]) || env.API_KEY || '';
    if (!provider && !apiKey) return null;
    return { provider, apiKey };
  } catch (e) {
    return null;
  }
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
    keyDefaults: await envKeyDefaults(),
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
    // A store-issued code (App Store promo / Play promo), redeemed through
    // the store's own sheet. This one grants.
    onRedeemStoreCode: async () => {
      const result = await redeemStoreCode();
      if (!result || result.status === 'cancelled') return;
      // Android hands off to another app and answers as soon as it has done
      // so — the grant arrives later, credited by the sweep that runs when the
      // user comes back. Returning a notice rather than throwing is the point:
      // this used to block until a two-minute poll expired and then report a
      // failure, for a code that was very often about to work.
      //
      // The route matters enough to say out loud. A browser is usually signed
      // into a different Google account than the device's Play Store, and a
      // code redeemed there is granted to an account this app will never see —
      // which looks, from here, exactly like a code that did nothing.
      if (result.status === 'opened') {
        return result.route === 'browser'
          ? 'Google Play opened in your browser. Make sure it\'s the same Google account as the Play Store on this device, or the credit will land somewhere Intention can\'t see it. It\'ll appear here once redeemed.'
          : 'Finish redeeming in Google Play. Your credit will appear here when it lands.';
      }
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
    // The manual form of the silent check, for the person who has just
    // restored a backup or signed back into their store account and knows more
    // than we did an hour ago. Resolves to a notice rather than throwing on a
    // miss: not finding credit is the expected answer for most of the people
    // who will press it.
    onRecoverFromDevice: BILLING_MODE === 'store' ? async () => {
      // Re-read rather than reusing the render-time snapshot above: this button
      // is pressed minutes after the paywall was painted, and by then a
      // purchase, a redemption or the app-active sweep may have moved the
      // entitlement on. The write itself merges (see mergeEntitlement), so a
      // stale base can no longer clobber; what a stale base would still get
      // wrong is the answer this returns to the user.
      const fresh = await getAccessState();
      const recovered = await recoverStrandedCredit(fresh?.entitlement || null,
        { force: true, route: fresh?.route || null });
      if (!entitlementIsActive(recovered)) {
        return 'No credit is attached to this device.';
      }
      await rerender();
      await onAccessChanged();
      return null;
    } : null,
    // Only Android's bridge can answer this; Apple's omits it and it stays
    // undefined, which renders nothing. See storeAccountRestored in billing.js.
    accountRestored: await accountRestoredFlag(),
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
  // Deliberately last, and deliberately unable to fail: everything above has
  // already rendered, and a backend we cannot reach must not take the page with
  // it. recoverStrandedCredit and refreshEntitlement both swallow their own
  // network failures now; this is the backstop for anything else, because the
  // caller of this function (options.js's showSettingsView) does not await it
  // and would lose the rest of the settings page to a rejection.
  let reconciled = entitlement;
  try {
    reconciled = await reconcileEntitlement(entitlement, access?.route || null);
  } catch (e) {
    console.warn('Intention: could not re-check coaching credit', e);
    return;
  }
  if (entitlementSignature(reconciled) !== entitlementSignature(entitlement)) {
    await refreshAccessUI(containerId, { compact });
    await onAccessChanged();
  }
}

// Whether the platform put this device's account id back, or `undefined` where
// that cannot be told — which every caller must treat as "say nothing".
//
// Wrapped, because this is a second round trip to the native bridge evaluated
// inside the argument list of the render call: a bridge that throws, or one
// that answers a method it does not implement by never calling back at all,
// used to leave the AI-access card permanently empty with nothing logged. The
// deadline lives in sendBilling; this catches the throwing half, the way the
// neighbouring accountToken call in billing.js already does.
async function accountRestoredFlag() {
  if (BILLING_MODE !== 'store') return undefined;
  try {
    return await storeAccountRestored();
  } catch (e) {
    console.warn('Intention: store bridge could not answer accountToken', e);
    return undefined;
  }
}

function storePlatform() {
  return HAS_APP_BLOCKING ? 'google' : 'apple';
}

// Returning to the app is the one moment a redemption finished elsewhere can
// have landed — the host sweeps for the grant and then fires this event
// (MainActivity.onResume on Android, ViewController.appDidBecomeActive on
// iOS). Without it the paywall keeps showing whatever balance it was rendered
// with, and a credit that arrived seconds ago stays invisible until the page
// is reopened, which reads as the code having failed.
let accessRefreshOnReturnWired = false;

function wireAccessRefreshOnReturn(containerId) {
  if (accessRefreshOnReturnWired) return;
  accessRefreshOnReturnWired = true;
  window.addEventListener('intention-app-active', async () => {
    await refreshAccessUI(containerId);
    await onAccessChanged();
  });
}

// Called after any change that can flip the access route, so the settings view
// stops offering a locked coach (or starts offering an unlocked one).
async function onAccessChanged() {
  const access = await getAccessState();
  const modal = document.getElementById('paywall-modal');
  if (access?.route !== 'locked' && modal && !modal.hidden) modal.hidden = true;
  // The header chip is the one balance readout that is on screen no matter
  // which tab is showing, so anything that can move the balance has to tell it.
  await refreshCreditChip();
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
