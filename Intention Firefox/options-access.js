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
    // A patch, not a replacement. This is the top-up of someone who very often
    // already holds a token and a balance; writing `{ active: false, receipt }`
    // whole used to delete both, so one backend hiccup during a second purchase
    // locked out a user who had been coaching happily a minute before. Only the
    // new receipt and the fact that it still needs confirming are news here —
    // see pendingReceiptPatch in billing.js, shared with the gate's paywall.
    await patchEntitlement(pendingReceiptPatch(platform, receipt, e));
    throw new Error(PENDING_VERIFICATION_MESSAGE);
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
    const model = (provider && env[`${provider.toUpperCase()}_MODEL`]) || env.DEFAULT_MODEL || '';
    return { provider, apiKey, model };
  } catch (e) {
    return null;
  }
}

// Resolves to the access state it rendered, so a caller about to run
// onAccessChanged can hand it over instead of asking the background a second
// time for the answer this has only just read.
async function refreshAccessUI(containerId, { compact = false, errorCode = null } = {}) {
  const container = document.getElementById(containerId);
  if (!container) return null;
  const access = await getAccessState();
  const entitlement = access?.entitlement || null;
  refreshCoachAccessStatus(access, errorCode);
  const keyConfig = BYOK_IS_OFFERED && !compact ? await getConfig() : null;

  const rerender = () => refreshAccessUI(containerId, { compact });

  await renderPaywall(container, {
    entitlement,
    compact,
    keyDefaults: await envKeyDefaults(),
    keyConfig,
    errorCode,
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
      await onAccessChanged(await rerender());
    },
    onRestore: async () => {
      const result = await restorePurchases();
      if (!result || !result.receipt) {
        throw new Error(result?.error || 'No pending purchase found.');
      }
      await verifyAndStore(result.platform || storePlatform(), result.receipt);
      await onAccessChanged(await rerender());
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
      await onAccessChanged(await rerender());
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
      await onAccessChanged(await rerender());
      return null;
    } : null,
    // Only Android's bridge can answer this; Apple's omits it and it stays
    // undefined, which renders nothing. See storeAccountRestored in billing.js.
    accountRestored: await accountRestoredFlag(),
    // Provider configuration belongs to the API-key flow. Apple has no flow;
    // compact gates send users to the full settings card instead of collecting
    // credentials while they are trying to open a blocked page.
    onUseOwnKey: BYOK_IS_OFFERED ? () => openOwnKeyFlow() : null,
    onSaveKey: BYOK_IS_OFFERED && !compact ? async ({ provider, apiKey, model }) => {
      await sendBg({ action: 'saveSettings', config: { provider, apiKey, model } });
      await onAccessChanged(await rerender());
    } : null,
    onRemoveKey: BYOK_IS_OFFERED && !compact ? async () => {
      await sendBg({ action: 'saveSettings', config: { provider: '', apiKey: '', model: '' } });
      await onAccessChanged(await rerender());
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
    return access;
  }
  if (entitlementSignature(reconciled) !== entitlementSignature(entitlement)) {
    const settled = await refreshAccessUI(containerId, { compact });
    await onAccessChanged(settled);
    return settled;
  }
  return access;
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
  window.addEventListener('intention-app-active', async (event) => {
    // Android hands over a purchase it credited in the background (a redeemed
    // code). Verifying it here is idempotent server-side and is what gives
    // this device the token and balance — without it the credit sat on the
    // backend while the paywall still said there was none.
    //
    // A verify that fails must not stop the refresh behind it. verifyAndStore
    // has already kept the receipt as pending when it throws, and the refresh
    // is what shows that and retries it; letting the throw escape skipped both
    // and surfaced only as an unhandled rejection from an event listener.
    const purchase = event?.detail;
    if (purchase?.receipt) {
      try {
        await verifyAndStore(purchase.platform || storePlatform(), purchase.receipt);
      } catch (e) {
        console.warn('Intention: could not verify a purchase credited in the background', e);
      }
    }
    try {
      // The account id can have been minted or restored while we were away (a
      // redemption finished in Play, a backup landing); the render asks again.
      invalidateAccountTokenCache();
      await onAccessChanged(await refreshAccessUI(containerId));
    } catch (e) {
      console.warn('Intention: could not refresh AI access on return', e);
    }
  });
}

// Called after any change that can flip the access route, so the settings view
// stops offering a locked coach (or starts offering an unlocked one).
//
// `known` is an access state the caller has just read (refreshAccessUI returns
// the one it rendered); without one, the background is asked.
async function onAccessChanged(known = null) {
  const access = known || await getAccessState();
  refreshCoachAccessStatus(access);
  const modal = document.getElementById('paywall-modal');
  if (access?.route !== 'locked' && modal && !modal.hidden) modal.hidden = true;
  // The header chip is the one balance readout that is on screen no matter
  // which tab is showing, so anything that can move the balance has to tell it.
  await refreshCreditChip();
}

// The setup wizard and the settings view both need a way to send someone who
// is locked out to the purchase flow without derailing what they were doing.
async function openPaywallModal(errorCode = null) {
  const modal = document.getElementById('paywall-modal');
  modal.hidden = false;
  await refreshAccessUI('paywall-modal-body', { compact: true, errorCode });
}

async function openOwnKeyFlow() {
  // A compact gate hands off to the full settings flow. If setup is still
  // showing, finish it first so the destination is visible.
  if (!document.getElementById('setup-view').hidden) {
    await finishSetup();
  }
  setSettingsSection('settings');
  const modal = document.getElementById('paywall-modal');
  if (modal) modal.hidden = true;
  await refreshAccessUI('access-paywall');
  const keyDetails = document.getElementById('int-pw-key-route');
  if (keyDetails) {
    keyDetails.open = true;
    keyDetails.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
  document.getElementById('int-pw-key')?.focus();
}

function refreshCoachAccessStatus(access, errorCode = null) {
  const status = document.getElementById('coach-access-status');
  if (!status || !access) return;
  status.innerHTML = '';
  const locked = access.route === 'locked';
  const low = access.route === 'hosted' && !!access.lowCredit;
  const insufficient = errorCode === 'balance_exhausted';
  status.hidden = !locked && !low && !insufficient;
  if (status.hidden) return;
  const message = document.createElement('p');
  message.textContent = BILLING_MODE === 'byok'
    ? 'Your coach needs an API key before you can talk.'
    : insufficient
      ? 'Not enough coaching credit to send this message. Top up to continue.'
      : locked
      ? 'No coaching credit. Top up before talking with your coach.'
      : `Coaching credit is low: ${Number(access.balanceCredits || 0).toLocaleString()} credits. Top up soon to keep talking.`;
  status.appendChild(message);
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'secondary';
  button.textContent = BILLING_MODE === 'byok' ? 'Set up your API key' : 'Top up coaching credit';
  button.addEventListener('click', () => {
    if (BILLING_MODE === 'byok') { openOwnKeyFlow(); return; }
    setSettingsSection('settings');
    document.getElementById('ai-access-card')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  status.appendChild(button);
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
