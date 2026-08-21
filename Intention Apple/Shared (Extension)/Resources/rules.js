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

// What a target falls back to when it carries no per-item override. `mode`,
// `behavior` and `passMinutes` all have a global setting behind them, so the
// per-item field is genuinely optional; `looseUntilMinutes` deliberately does
// not (see normalizeLooseUntil).
const BLOCK_DEFAULTS = { mode: 'coach', behavior: 'pass', passMinutes: 10 };

// maxMinutes -1 means "no daily ceiling", which is not the same as 0.
const LIMIT_DEFAULTS = { maxGrants: 3, maxMinutes: -1, looseUntilMinutes: null };

// `looseUntilMinutes`: how many of today's minutes on a target the coach spends
// in its lenient phase before it turns strict (see renderPhaseLine in
// prompts.js). Absent is a real answer, not a missing one — it means no split,
// which is exactly how every entry written before the field existed behaves —
// so anything that isn't a finite number of minutes normalises to null rather
// than to a number. In particular `Number(null)` is 0, and 0 would mean
// "strict from the first minute", which is the opposite of what an unset field
// should do. There is no global default either: a lenient window is a per-site
// line, or it is nothing.
function normalizeLooseUntil(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
}

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

// A per-item `mode` override on a limits entry wins; otherwise the global
// blockingMode applies. Split out because the options page resolves the mode
// on its own, for a row it is already rendering, without the rest of the
// block config.
function resolveMode(entry, globalMode) {
  return (entry && entry.mode) || globalMode || BLOCK_DEFAULTS.mode;
}

// The full gating verdict for one target: which mode applies, and — in simple
// mode — what a pass looks like. `globals` carries the global settings as read
// from storage (blockingMode, simpleBehavior, simplePassMinutes).
//
// looseUntilMinutes rides along even though only the coach branches on it
// today, because a mirror that answers a different shape is a mirror nobody
// can trust the next time one of them grows a branch.
function resolveBlockConfig(entry, globals = {}) {
  const globalPassMinutes = Number(globals.simplePassMinutes) > 0
    ? Number(globals.simplePassMinutes)
    : BLOCK_DEFAULTS.passMinutes;
  return {
    mode: resolveMode(entry, globals.blockingMode),
    behavior: (entry && entry.behavior) || globals.simpleBehavior || BLOCK_DEFAULTS.behavior,
    passMinutes: Number(entry && entry.passMinutes) > 0
      ? Number(entry.passMinutes)
      : globalPassMinutes,
    looseUntilMinutes: normalizeLooseUntil(entry && entry.looseUntilMinutes)
  };
}

// The daily allowances for one target. Unlike the block config these have no
// global setting behind them — an absent entry means the defaults above.
function resolveLimits(entry) {
  if (!entry) return { ...LIMIT_DEFAULTS };
  const maxGrants = Number(entry.maxGrants);
  const maxMinutes = Number(entry.maxMinutes);
  return {
    maxGrants: Number.isNaN(maxGrants) ? LIMIT_DEFAULTS.maxGrants : maxGrants,
    maxMinutes: Number.isNaN(maxMinutes) ? LIMIT_DEFAULTS.maxMinutes : maxMinutes,
    looseUntilMinutes: normalizeLooseUntil(entry.looseUntilMinutes)
  };
}
