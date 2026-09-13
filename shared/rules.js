// rules.js — the single place a blocked target's rules are resolved.
//
// Four contexts have to answer "what are this site's rules?" and they cannot
// share a module the ordinary way: there is no bundler here, the background
// worker, the options page, the coaching page and the content script are four
// separate global scopes, and the content script in particular must reach a
// verdict with the background worker dead (that is the whole point of
// checkFromStorage). So this file is loaded into all four as a plain script
// and everything in it is a pure function of values the caller already holds.
//
// It exists because the resolution used to be written out three times — in
// background.js, content.js and options.js — held together by nothing but a
// "change one, change all three" comment on each copy. They had already
// drifted. Nothing in here reads storage or touches `chrome`; the async
// storage-reading wrappers stay in background.js, where the storage keys live.

// ===========================================================================
// INTENTIONS — how often, and for how long, the user means to open a target
// ===========================================================================
//
// Every blocked site or app carries one intention: "open it at most N times a
// day, M minutes each time". Inside that, a visit is one tap and costs nothing
// — no conversation, no credit. Past it, the only way to more time today is to
// negotiate with the coach. There is no mode to choose and no second cap: the
// intention IS the day's allowance, and `opens: 0` is what a hard block is.
//
// Stored on the per-target limits entry under the field names the grant
// bookkeeping has always used — `maxGrants` is opens, `passMinutes` is minutes
// each — so the session, sync and native layers read an unchanged shape.

// What a target with no entry, or an unreadable one, resolves to.
const INTENTION_DEFAULTS = { maxGrants: 3, passMinutes: 10 };

// A fixed set rather than a free number, for the same reason the leave delay
// is a ladder: this is a commitment, and four rungs are enough to mean
// something without inviting "call it eleven".
const PASS_MINUTE_CHOICES = [5, 10, 15, 30];

// Opens per day never goes past this. Beyond ten a day the intention has
// stopped describing an intention.
const MAX_OPENS = 10;

// The per-item limits entry for a target, from a plain object holding the
// `domainLimits` / `appLimits` maps as read from storage.
//
// Apps and sites can't collide: appLimits is keyed by Android package name,
// domainLimits by hostname, so a single lookup across both is safe. Callers
// that only ever hold one of the two maps (the content script never sees apps)
// can pass just that one — a missing map reads as empty, not as an error.
function limitEntryFor(target, stored) {
  if (!target || !stored) return null;
  const domainLimits = stored.domainLimits || {};
  const appLimits = stored.appLimits || {};
  return domainLimits[target] || appLimits[target] || null;
}

// The intention for one target, as `{ opens, minutesEach }`.
//
// Unreadable values fall back to the defaults rather than to zero, because
// zero opens is a real answer (blocked outright) and a corrupt field must not
// silently become one. Out-of-range values are clamped into range: an opens
// count above MAX_OPENS reads as MAX_OPENS, and a minutes value off the ladder
// snaps DOWN to the rung below it — the same direction normalizeLeaveDelay
// snaps, for the same reason: being wrong must only ever mean less time.
function resolveIntention(entry) {
  const rawOpens = entry ? Number(entry.maxGrants) : NaN;
  const opens = Number.isFinite(rawOpens)
    ? Math.max(0, Math.min(MAX_OPENS, Math.floor(rawOpens)))
    : INTENTION_DEFAULTS.maxGrants;
  const rawMinutes = entry ? Number(entry.passMinutes) : NaN;
  let minutesEach = INTENTION_DEFAULTS.passMinutes;
  if (Number.isFinite(rawMinutes) && rawMinutes > 0) {
    minutesEach = PASS_MINUTE_CHOICES[0];
    for (const choice of PASS_MINUTE_CHOICES) {
      if (choice <= rawMinutes) minutesEach = choice;
    }
  }
  return { opens, minutesEach };
}

// Whether moving a target from one intention to another gives the user more
// time. More opens or longer opens is a loosening; everything else — fewer,
// shorter, or the same — is not. Both sides go through resolveIntention, so a
// raw stored entry and a freshly edited one compare like for like.
//
// Loosening is never refused, only deferred: it takes effect the next day
// unless the coach agrees to it now. Tightening applies the moment it is saved.
function isLoosening(current, next) {
  const a = resolveIntention(current);
  const b = resolveIntention(next);
  return b.opens > a.opens || b.minutesEach > a.minutesEach;
}

// When a deferred loosening made at `now` takes effect: midnight at the start
// of the next local day. A day boundary rather than "24 hours from now" so the
// promise is one a person can hold in their head — "tomorrow" — and so a
// change made at 23:55 does not buy a whole extra evening.
function nextDayStart(now = Date.now()) {
  const d = new Date(now);
  d.setHours(24, 0, 0, 0);
  return d.getTime();
}

// ===========================================================================
// LEAVING — the cool-off a user puts in front of removing Intention
// ===========================================================================
//
// Removing Intention is the biggest loosening there is, so it goes through the
// same mechanism every other loosening does: a conversation with the coach.
// This is the one number the user sets in front of that conversation — "when I
// ask to leave, make me wait N hours first" — and it lives here for the same
// reason everything else in this file does. background.js decides whether the
// wait has elapsed, options.js paints the picker, and prompts.js tells the
// coach how long it is; three contexts, one answer.
//
// Nothing here is a lock and the copy must never suggest otherwise. The wait
// is something the user chose while they were thinking clearly, and there is
// always a working way out before it is up — see docs/LEAVING.md.

// Off, an hour, a day, three days. A fixed ladder rather than a free-text
// number of minutes because this is a commitment, not a setting: an arbitrary
// value invites the haggling ("call it forty minutes") that the whole feature
// exists to slow down, and four rungs is enough to mean something.
const LEAVE_DELAY_CHOICES = [0, 60, 1440, 4320];

// Snap an arbitrary value onto the ladder.
//
// It snaps DOWN, never up, and that direction is the whole point. Rounding to
// the *nearest* rung would let a corrupt or hand-edited 90 become 1440 — a
// day's wait nobody agreed to, imposed by a rounding rule. Snapping down can
// only ever give the user back time they already had a claim on, which is the
// safe direction to be wrong in for a number that stands between someone and
// the exit. Anything unreadable is 0 (no delay at all) for the same reason:
// the failure mode of this function must never be a longer commitment.
function normalizeLeaveDelay(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  let out = 0;
  for (const choice of LEAVE_DELAY_CHOICES) {
    if (choice <= n) out = choice;
  }
  return out;
}

// The delay as the coach and the settings card both say it. Prose rather than
// a number of minutes because both of them are writing sentences: "your
// 24 hours starts now" reads as a promise, "your 1440 minutes starts now"
// reads as a machine. The empty string for "no delay" is deliberate — every
// caller either has a sentence for that case or has nothing to say at all.
function formatLeaveDelay(minutes) {
  switch (normalizeLeaveDelay(minutes)) {
    case 60: return 'an hour';
    case 1440: return '24 hours';
    case 4320: return '3 days';
    default: return '';
  }
}
