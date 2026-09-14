// parts.js — the two questions that are asked about a URL, answered in one
// place: "is this part of the site one they asked me to block?" and "is this
// still the page their pass was for?".
//
// Both questions have the same three awkward properties, which is why they
// share a file rather than living next to the code that asks them.
//
// First, they have to be answerable with the background worker dead. Safari
// suspends it aggressively and Chrome's is a service worker that stops
// whenever it feels like it, so content.js has a storage-only fail-safe path
// (checkFromStorage) that must reach the same verdict on its own. A verdict
// that lives in the worker is a verdict the fail-safe path cannot reach.
//
// Second, they are asked from three different global scopes — the content
// script, the background worker and the options page — and this codebase has
// no bundler. Three scopes means three copies unless the answer is a plain
// script loaded into all three, which is exactly what rules.js already is and
// exactly why it exists. tests/parts.test.js carries the same "no second copy"
// guard that tests/rules.test.js does, for the same reason: the copies came
// back last time.
//
// Third — and this is the one that shapes the code rather than the file — they
// run on every page load, in a content script, before anything is painted. A
// throw here is not an error dialog; it is a blocked site that silently opens.
// So every exported entry point below is wrapped, and every wrapper fails in
// the direction that keeps the block on. A caller may treat "it returned" as
// unconditional.
//
// What this file deliberately does NOT do:
//
//   * It never touches `chrome`, storage or the DOM. The callers hold the
//     stored entry already (limitEntryFor in rules.js hands it over); this
//     file is a pure function of the values they pass in.
//   * It does not depend on page_context.js or sites.js. options.html loads
//     parts.js but not page_context.js, and the Android background WebView
//     ("Intention Android/app/src/main/assets/background.html") loads neither.
//     A reference to one of their globals is a ReferenceError on exactly one
//     platform, in the context nobody runs locally — the failure mode this
//     architecture makes easy and no linter can catch from a single context.
//     That is why the small amount of overlap with page_context.js (a label
//     clamp, a placeholder-title test) is re-stated here rather than reached
//     for, and why tests/parts.test.js asserts the absence of both.
//
// Two vocabularies live here and they are NOT the same thing, however similar
// they read:
//
//   * A PART RULE is a property of the blocklist — "on instagram.com, block
//     only Reels". It lives on the limits entry as `scope` + `parts`, and it
//     decides whether the coach appears at all.
//   * A PAGE SCOPE is a property of one granted pass — "this twelve minutes
//     was for that one video". It lives on the session, and it decides when a
//     pass that was already granted stops applying.
//
// Nothing here ever writes `scope: 'all'` or `{ kind: 'site' }`. Absence is
// the third state in both vocabularies, and it is what makes every entry and
// every session written before this feature existed behave exactly as it did
// before, with no migration to run.

// ===========================================================================
// PART RULES — which parts of a site are blocked
// ===========================================================================

// A part id is `<service>:<key>` or `<service>:<key>:<arg>` for a catalogue
// part, or `path:<glob>` for an address the user wrote themselves.
//
// The charset is deliberately narrow. These ids are matched against URLs, some
// of them by building a RegExp out of the `<arg>` half, and they are rendered
// into a system prompt. A narrow charset is the cheapest guard against both:
// there is no regex metacharacter in here except `.` and `-`, and both are
// escaped anyway before they reach a RegExp (see escapePartArg).
//
// No nested quantifier over overlapping classes, so no catastrophic
// backtracking: the three runs are separated by literal colons, which means
// the engine can never redistribute characters between them.
const PART_ID_RE = /^[a-z0-9]+:[a-z0-9_]+(?::[a-z0-9_.~@-]{1,64})?$/;

// A custom address rule: everything after the domain, with `*` standing for
// anything. Validated separately from PART_ID_RE because a path legitimately
// contains `/`, `?`, `=` and `&`, none of which may appear in a catalogue id.
//
// `..` is rejected outright. It cannot mean anything useful in a matcher that
// never resolves the path, and a rule the user cannot predict the behaviour of
// is worse than no rule.
const PART_GLOB_RE = /^[a-z0-9/_.~%?=&*+@:-]{1,200}$/i;

// An id longer than this is not a part somebody typed; it is something that
// got pasted or corrupted, and it is on its way into a system prompt.
const PART_ID_MAX = 96;

// How many parts one target may carry. Twenty is well past any real list and
// short enough that the per-navigation match stays trivially cheap.
const PART_LIST_MAX = 20;

// The catalogue: the parts this build knows how to recognise, keyed by id.
//
//   service     the SITE_META / serviceKeyFor key this part belongs to, so a
//               part is offered for instagram.com and com.instagram.android
//               alike without either being named here. tests/parts.test.js
//               pins every one of these to a real catalogue key.
//   label       the human name, or a function of the argument for the
//               parameterised entries ('r/rust', '@veritasium').
//   pickerLabel what the picker calls a parameterised entry before it has an
//               argument ('Subreddit'), since `label` needs one.
//   param       the argument's name, absent for a fixed part.
//   argRe       what a valid argument looks like, on top of PART_ID_RE.
//   path        a RegExp over the lowercased pathname, or a function of the
//               argument returning one.
//   dnr         urlFilter fragments a declarativeNetRequest rule could use for
//               this part. Present for the parts where the path prefix is
//               stable enough to be worth a rule; read by nobody yet — the
//               shipped path is the content-script overlay, and the DNR half
//               is gated on a smoke test that has not run (see plan §6).
//
// Every regex is anchored at `^` and none contains a quantifier over a class
// that overlaps its neighbour, so none of them can backtrack catastrophically.
// Every one of them is pinned by tests/parts.test.js to at least one canonical
// URL it must match and one sibling URL it must reject — an entry that
// silently never matches is strictly worse than no entry, because the user
// believes a part is blocked and it is not.
const PART_CATALOGUE = {
  // ---- Instagram --------------------------------------------------------
  // `/reels/` and `/reel/` are both live; the singular is what a shared link
  // uses and the plural is what the tab does.
  'instagram:reels': {
    service: 'instagram.com', label: 'Reels',
    path: /^\/reels?(\/|$)/i, dnr: ['||instagram.com/reels', '||instagram.com/reel']
  },
  'instagram:explore': {
    service: 'instagram.com', label: 'Explore',
    path: /^\/explore(\/|$)/i, dnr: ['||instagram.com/explore']
  },
  'instagram:stories': {
    service: 'instagram.com', label: 'Stories',
    path: /^\/stories(\/|$)/i, dnr: ['||instagram.com/stories']
  },
  'instagram:dms': {
    service: 'instagram.com', label: 'Direct messages',
    path: /^\/direct(\/|$)/i, dnr: ['||instagram.com/direct']
  },
  // The home feed is the bare host and nothing else. `/^\/?$/` is the whole
  // rule, and it is why "block the feed, keep DMs" is expressible at all.
  'instagram:feed': {
    service: 'instagram.com', label: 'Home feed',
    path: /^\/?$/
  },
  'instagram:posts': {
    service: 'instagram.com', label: 'Posts',
    path: /^\/p\//i, dnr: ['||instagram.com/p/']
  },

  // ---- Reddit -----------------------------------------------------------
  'reddit:home': {
    service: 'reddit.com', label: 'Home',
    path: /^\/?$/
  },
  'reddit:popular': {
    service: 'reddit.com', label: 'Popular',
    path: /^\/r\/popular(\/|$)/i, dnr: ['||reddit.com/r/popular']
  },
  'reddit:all': {
    service: 'reddit.com', label: 'All',
    path: /^\/r\/all(\/|$)/i, dnr: ['||reddit.com/r/all']
  },
  // Reddit caps subreddit names at 21 characters and allows only letters,
  // digits and underscores, so the argument pattern is the site's own rule
  // rather than a guess.
  'reddit:sub': {
    service: 'reddit.com', param: 'subreddit', pickerLabel: 'Subreddit',
    argRe: /^[a-z0-9_]{2,21}$/i,
    label: (arg) => `r/${arg}`,
    path: (arg) => new RegExp(`^/r/${escapePartArg(arg)}(/|$)`, 'i'),
    dnr: (arg) => [`||reddit.com/r/${arg}`]
  },
  'reddit:user': {
    service: 'reddit.com', param: 'user', pickerLabel: 'Redditor',
    argRe: /^[a-z0-9_-]{3,20}$/i,
    label: (arg) => `u/${arg}`,
    path: (arg) => new RegExp(`^/u(?:ser)?/${escapePartArg(arg)}(/|$)`, 'i'),
    dnr: (arg) => [`||reddit.com/user/${arg}`]
  },

  // ---- YouTube ----------------------------------------------------------
  'youtube:shorts': {
    service: 'youtube.com', label: 'Shorts',
    path: /^\/shorts(\/|$)/i, dnr: ['||youtube.com/shorts']
  },
  'youtube:home': {
    service: 'youtube.com', label: 'Home',
    path: /^\/?$/
  },
  'youtube:subs': {
    service: 'youtube.com', label: 'Subscriptions',
    path: /^\/feed\/subscriptions/i, dnr: ['||youtube.com/feed/subscriptions']
  },
  'youtube:watch': {
    service: 'youtube.com', label: 'Videos',
    path: /^\/watch/i, dnr: ['||youtube.com/watch']
  },
  // A handle, not a channel id: `/@veritasium` is what the address bar shows
  // and what a user can be expected to recognise and type.
  'youtube:channel': {
    service: 'youtube.com', param: 'channel', pickerLabel: 'Channel',
    argRe: /^[a-z0-9_.-]{3,30}$/i,
    label: (arg) => `@${arg}`,
    path: (arg) => new RegExp(`^/@${escapePartArg(arg)}(/|$)`, 'i'),
    dnr: (arg) => [`||youtube.com/@${arg}`]
  },

  // ---- X ----------------------------------------------------------------
  // "For You" and "Following" are BOTH x.com/home. They are not distinguishable
  // from the address, so they are not offered as separate parts and must not
  // be added later without a mechanism that can actually tell them apart — an
  // offered part that never matches is a promise the product cannot keep.
  'x:home': {
    service: 'x.com', label: 'Home timeline',
    path: /^\/home(\/|$)/i, dnr: ['||x.com/home', '||twitter.com/home']
  },
  'x:dms': {
    service: 'x.com', label: 'Direct messages',
    path: /^\/messages(\/|$)/i, dnr: ['||x.com/messages', '||twitter.com/messages']
  },
  'x:explore': {
    service: 'x.com', label: 'Explore',
    path: /^\/explore(\/|$)/i, dnr: ['||x.com/explore', '||twitter.com/explore']
  },
  'x:notifications': {
    service: 'x.com', label: 'Notifications',
    path: /^\/notifications(\/|$)/i, dnr: ['||x.com/notifications']
  },
  'x:profile': {
    service: 'x.com', param: 'handle', pickerLabel: 'Account',
    argRe: /^[a-z0-9_]{1,15}$/i,
    label: (arg) => `@${arg}`,
    path: (arg) => new RegExp(`^/${escapePartArg(arg)}(/|$)`, 'i')
  },

  // ---- TikTok -----------------------------------------------------------
  // For You is the bare host as well as /foryou, which is why this one regex
  // carries an alternation where the others do not.
  'tiktok:foryou': {
    service: 'tiktok.com', label: 'For You',
    path: /^\/(?:foryou\/?)?$/i
  },
  'tiktok:following': {
    service: 'tiktok.com', label: 'Following',
    path: /^\/following(\/|$)/i, dnr: ['||tiktok.com/following']
  },
  'tiktok:dms': {
    service: 'tiktok.com', label: 'Direct messages',
    path: /^\/messages(\/|$)/i, dnr: ['||tiktok.com/messages']
  },
  'tiktok:explore': {
    service: 'tiktok.com', label: 'Explore',
    path: /^\/explore(\/|$)/i, dnr: ['||tiktok.com/explore']
  },

  // ---- Facebook ---------------------------------------------------------
  'facebook:reels': {
    service: 'facebook.com', label: 'Reels',
    path: /^\/reels?(\/|$)/i, dnr: ['||facebook.com/reel']
  },
  'facebook:messages': {
    service: 'facebook.com', label: 'Messages',
    path: /^\/messages(\/|$)/i, dnr: ['||facebook.com/messages']
  },
  'facebook:marketplace': {
    service: 'facebook.com', label: 'Marketplace',
    path: /^\/marketplace(\/|$)/i, dnr: ['||facebook.com/marketplace']
  },
  'facebook:feed': {
    service: 'facebook.com', label: 'Home feed',
    path: /^\/?$/
  },

  // ---- LinkedIn ---------------------------------------------------------
  'linkedin:feed': {
    service: 'linkedin.com', label: 'Feed',
    path: /^\/feed(\/|$)|^\/?$/i, dnr: ['||linkedin.com/feed']
  },
  'linkedin:messaging': {
    service: 'linkedin.com', label: 'Messaging',
    path: /^\/messaging(\/|$)/i, dnr: ['||linkedin.com/messaging']
  },
  'linkedin:jobs': {
    service: 'linkedin.com', label: 'Jobs',
    path: /^\/jobs(\/|$)/i, dnr: ['||linkedin.com/jobs']
  }
};

// Escape a catalogue argument before it is spliced into a RegExp.
//
// PART_ID_RE already limits the argument to `[a-z0-9_.~@-]`, of which only `.`
// and `-` mean anything to a regex engine, so this is belt to that brace: the
// validation and the escaping are two independent reasons the same thing
// cannot happen, and neither is allowed to be the only one.
function escapePartArg(arg) {
  return String(arg == null ? '' : arg).replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&');
}

// Is this a custom address rule rather than a catalogue part?
function isPathPartId(id) {
  return typeof id === 'string' && id.slice(0, 5) === 'path:';
}

// Split a part id into its three pieces, or return null if it is not one.
//
// A custom address rule has no catalogue key — the whole of it after `path:`
// is the argument — so `key` comes back empty for those and `service` is the
// literal 'path'. That is the discriminator every caller uses.
function parsePartId(id) {
  try {
    if (typeof id !== 'string') return null;
    const raw = id.trim();
    if (!raw || raw.length > PART_ID_MAX) return null;
    if (isPathPartId(raw)) {
      const glob = raw.slice(5);
      if (!glob || glob.includes('..') || !PART_GLOB_RE.test(glob)) return null;
      if (glob[0] !== '/' && glob[0] !== '*') return null;
      return { service: 'path', key: '', arg: glob };
    }
    const lower = raw.toLowerCase();
    if (!PART_ID_RE.test(lower)) return null;
    const bits = lower.split(':');
    return { service: bits[0], key: bits[1], arg: bits[2] || '' };
  } catch (e) {
    return null;
  }
}

// The catalogue entry an id names, plus its argument, or null.
//
// "Recognised" means exactly this: this build has a rule that can decide
// whether a URL is inside the part. A syntactically valid id from a newer
// build is NOT recognised here, and resolvePartVerdict treats that case as the
// dangerous one it is.
function partCatalogueEntry(id) {
  const parsed = parsePartId(id);
  if (!parsed || parsed.service === 'path') return null;
  const entry = PART_CATALOGUE[`${parsed.service}:${parsed.key}`];
  if (!entry) return null;
  // A parameterised part without an argument, or a fixed part with one, is a
  // shape this build cannot evaluate — which is not the same as a typo, and is
  // handled the same way as an id from the future.
  if (entry.param && !parsed.arg) return null;
  if (!entry.param && parsed.arg) return null;
  if (entry.param && entry.argRe && !entry.argRe.test(parsed.arg)) return null;
  return { entry, arg: parsed.arg };
}

// Is this id one this build can actually match a URL against?
function partIsRecognised(id) {
  if (isPathPartId(id)) return parsePartId(id) !== null;
  return partCatalogueEntry(id) !== null;
}

// Is this id well-formed, whether or not this build understands it?
//
// The distinction matters on the write path: an id this build does not know
// may still be a real rule the user set on a newer build, and silently
// deleting it on a downgrade would rewrite their settings behind their back.
// sanitizePartRule keeps those; resolvePartVerdict refuses to guess about them.
function isValidPartId(id) {
  return parsePartId(id) !== null;
}

// The human name for a part. 'Reels', 'r/rust', '@veritasium', or
// 'address /reels/*' for a custom rule.
//
// A well-formed id this build does not recognise comes back as itself rather
// than as an empty string: it is charset-limited and short, showing it is
// honest about the state ("there is a rule here I cannot describe"), and an
// empty label would render as a gap the user cannot act on.
function partLabel(id) {
  try {
    const parsed = parsePartId(id);
    if (!parsed) return '';
    if (parsed.service === 'path') return `address ${parsed.arg}`;
    const found = partCatalogueEntry(id);
    if (!found) return String(id).trim().toLowerCase();
    const label = found.entry.label;
    return typeof label === 'function' ? String(label(found.arg)) : String(label);
  } catch (e) {
    return '';
  }
}

// The catalogue parts the picker may offer for one service, in catalogue order.
//
// `label` is the finished name for a fixed part and the picker's prompt for a
// parameterised one, so the caller never has to know which it is holding —
// `param` tells it whether to ask for an argument.
function partsForService(serviceKey) {
  try {
    const key = String(serviceKey == null ? '' : serviceKey).toLowerCase();
    if (!key) return [];
    const out = [];
    for (const [id, entry] of Object.entries(PART_CATALOGUE)) {
      if (entry.service !== key) continue;
      out.push({
        id,
        param: entry.param || null,
        label: entry.param
          ? String(entry.pickerLabel || entry.param)
          : String(entry.label)
      });
    }
    return out;
  } catch (e) {
    return [];
  }
}

// Turn whatever the user typed into a part id, or null.
//
// Accepts the shapes people actually produce: a bare catalogue key ('reels'),
// the site's own notation ('r/rust', '@veritasium'), a pasted URL or URL
// fragment ('reddit.com/r/rust', 'https://reddit.com/r/rust/'), and a raw
// address ('/reels/*'). Anything starting with `/` or `*` is a custom address
// rule and is never guessed at further.
function normalizePartInput(raw, serviceKey) {
  try {
    let text = String(raw == null ? '' : raw).trim();
    if (!text) return null;

    // Already an id.
    if (isValidPartId(text)) return isPathPartId(text) ? text : text.toLowerCase();

    // A custom address. Written by hand, so tolerate a missing leading slash
    // only when a `*` starts it — otherwise a typo'd word would silently
    // become an address rule that matches nothing.
    if (text[0] === '/' || text[0] === '*') {
      const candidate = `path:${text}`;
      return isValidPartId(candidate) ? candidate : null;
    }

    const service = String(serviceKey == null ? '' : serviceKey).toLowerCase();
    if (!service) return null;

    // Strip a pasted URL down to its path. Doing this by hand rather than with
    // `new URL()` because the common paste has no scheme, and prefixing one to
    // find out would accept things that are not URLs at all.
    text = text.replace(/^https?:\/\//i, '');
    const slash = text.indexOf('/');
    if (text.includes('.') && slash > 0) text = text.slice(slash);

    const candidates = partsForService(service);
    for (const option of candidates) {
      const entry = PART_CATALOGUE[option.id];
      if (!option.param) {
        // 'reels', 'Reels', '/reels', '/reels/'
        const bare = text.replace(/^\/+|\/+$/g, '').toLowerCase();
        if (bare === option.id.split(':')[1]) return option.id;
        if (bare && String(entry.label).toLowerCase() === bare) return option.id;
        continue;
      }
      // 'r/rust', '/r/rust', '@veritasium', or the bare name once the site's
      // own notation has been stripped.
      const arg = normalizePartArg(text, option.id);
      if (arg && entry.argRe && entry.argRe.test(arg)) {
        const id = `${option.id}:${arg.toLowerCase()}`;
        if (isValidPartId(id)) return id;
      }
    }
    return null;
  } catch (e) {
    return null;
  }
}

// Pull the argument out of the notation each parameterised part is written in.
// Kept beside normalizePartInput rather than in the catalogue because it is
// about what a person types, not about what the site's URLs look like.
function normalizePartArg(text, optionId) {
  const trimmed = String(text).replace(/^\/+|\/+$/g, '');
  if (optionId === 'reddit:sub') {
    const m = trimmed.match(/^r\/([^/]+)$/i);
    return m ? m[1] : (trimmed.includes('/') ? '' : trimmed);
  }
  if (optionId === 'reddit:user') {
    const m = trimmed.match(/^u(?:ser)?\/([^/]+)$/i);
    return m ? m[1] : '';
  }
  if (optionId === 'youtube:channel' || optionId === 'x:profile') {
    const m = trimmed.match(/^@([^/]+)$/);
    return m ? m[1] : '';
  }
  return '';
}

// Wildcard matching for a custom address rule.
//
// Written as a two-pointer scan rather than by compiling the glob into a
// RegExp on purpose. `/**/**/**/x` compiled naively becomes `.*.*.*.*.*.*x`,
// which is exponential on a non-matching subject — the textbook catastrophic
// backtracking case, reachable here by a user typing asterisks into a settings
// field, and evaluated on every navigation of a gated page. This loop is
// O(pattern x subject) with no recursion and no engine backtracking at all.
function globMatchesPath(glob, subject) {
  let g = 0;
  let s = 0;
  let star = -1;
  let mark = 0;
  while (s < subject.length) {
    if (g < glob.length && (glob[g] === subject[s])) {
      g++; s++;
    } else if (g < glob.length && glob[g] === '*') {
      star = g++;
      mark = s;
    } else if (star >= 0) {
      g = star + 1;
      s = ++mark;
    } else {
      return false;
    }
  }
  while (g < glob.length && glob[g] === '*') g++;
  return g === glob.length;
}

// Split a URL into the two lowercased pieces a part rule is matched against,
// or null if there is nothing here worth matching.
//
// The protocol check is what rejects `javascript:`, `data:` and `about:`.
// `new URL()` parses all three happily, so "it parsed" is not the question —
// "is this a page a part rule could describe" is, and the answer for anything
// that is not http(s) is no. Returning null puts the caller on the fail-closed
// path, which is where an unrecognisable destination belongs.
function partUrlParts(url) {
  try {
    if (!url || typeof url !== 'string') return null;
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return {
      pathname: String(parsed.pathname || '/').toLowerCase(),
      search: String(parsed.search || '').toLowerCase()
    };
  } catch (e) {
    return null;
  }
}

// Does one part id cover this URL? `parsed` is what partUrlParts returned.
//
// A custom address rule is matched against pathname + search together, because
// that is what "everything after the domain" means to the person who typed it.
// A catalogue part is matched against the pathname alone: every catalogue
// entry is a section of a site, and no site puts its sections in the query.
function partMatchesUrl(id, parsed) {
  try {
    if (!parsed || typeof parsed.pathname !== 'string') return false;
    if (isPathPartId(id)) {
      const glob = parsePartId(id);
      if (!glob) return false;
      return globMatchesPath(glob.arg.toLowerCase(), `${parsed.pathname}${parsed.search || ''}`);
    }
    const found = partCatalogueEntry(id);
    if (!found) return false;
    const path = found.entry.path;
    const re = typeof path === 'function' ? path(found.arg) : path;
    return re instanceof RegExp ? re.test(parsed.pathname) : false;
  } catch (e) {
    return false;
  }
}

// Does this limits entry carry a part rule that actually decides anything?
//
// An 'only' or 'except' scope with an empty list decides nothing, so it is not
// a rule — and that matters beyond tidiness: background.js drops a host's
// declarativeNetRequest redirect when the host has a part rule, on the grounds
// that the overlay will do the gating instead. Answering true for a rule that
// gates nothing would take the redirect away and put nothing in its place.
function hasPartRule(entry) {
  try {
    const rule = sanitizePartRule(entry);
    return rule.scope !== 'all' && rule.parts.length > 0;
  } catch (e) {
    return false;
  }
}

// Normalise a stored scope. Anything that is not exactly 'only' or 'except'
// is 'all' — including 'all' itself, which is never written but is cheap to
// tolerate on the read path.
function normalizeScopeValue(value) {
  return value === 'only' || value === 'except' ? value : 'all';
}

// Clean a part rule on its way to storage. Every write path goes through this.
//
// It keeps well-formed ids it does not recognise (see isValidPartId) and drops
// only the ones that are not ids at all. An empty list collapses the scope to
// 'all', which is how the caller knows to delete both keys rather than write
// them: an untouched entry must stay byte-identical to what shipped before
// this feature existed, so there is no migration and nothing to undo.
function sanitizePartRule(raw) {
  try {
    const scope = normalizeScopeValue(raw && raw.scope);
    const list = raw && Array.isArray(raw.parts) ? raw.parts : [];
    const parts = [];
    for (const candidate of list) {
      if (parts.length >= PART_LIST_MAX) break;
      if (typeof candidate !== 'string') continue;
      const id = candidate.trim();
      if (id.length > PART_ID_MAX || !isValidPartId(id)) continue;
      const normalized = isPathPartId(id) ? id : id.toLowerCase();
      if (!parts.includes(normalized)) parts.push(normalized);
    }
    if (scope === 'all' || parts.length === 0) return { scope: 'all', parts: [] };
    return { scope, parts };
  } catch (e) {
    return { scope: 'all', parts: [] };
  }
}

// THE matcher: should the coach appear on this URL, given this target's rule?
//
// Returns { gated, partId, scope }. `gated` is the answer; `partId` is the
// part the URL landed in, when there is one, so the gate can say which; and
// `scope` is the rule that was applied, degraded to 'all' whenever this build
// could not apply the stored one.
//
// It fails CLOSED, end to end. The whole body is wrapped, and every wrapper
// and every early return produces { gated: true, partId: null, scope: 'all' }
// — the pre-feature behaviour, which is a site that is blocked. This is not
// defensive tidiness: this function is called from the content script's
// storage-only fail-safe path, the one that runs when the background worker is
// dead, and a throw there is not an error anybody sees. It is the blocked site
// quietly opening, at the exact moment the product exists to prevent.
//
// The asymmetry between the two scopes is the same reasoning applied to a
// stored id this build cannot evaluate — one from a newer version, or one
// whose catalogue entry has since been dropped:
//
//   * 'only' means "block just these". An id we cannot match can only fail to
//     match, so an unrecognised id in an 'only' list would silently unblock
//     the part the user most wanted blocked. One is enough to void the whole
//     rule, and the entry falls back to gating everything.
//   * 'except' means "block everything but these". There, an id we cannot
//     match can only fail to let something through, which leaves more of the
//     site blocked, not less. Those ids are simply dropped.
//
// A parts value that is not an array, a parts entry that is not a string, an
// entry whose prototype has been tampered with, a URL new URL() rejects, a
// javascript: URL — all of them land on the same fail-closed answer.
//
// ALLOWED ACCOUNTS are applied last, and only ever in one direction: a URL the
// rule gates may still be opened because it belongs to an account the user
// always allows (see the ALLOWED ACCOUNTS section below). They can never gate
// something the part rule leaves open, and every way that half can fail —
// a hostile list, an address with no author in it, a lookup that did not
// come back — leaves the part verdict exactly as it was.
//
// `verified` is optional and is only ever the result of a lookup the caller
// made for THIS url (background.js's resolvePageVerdict): { key, account }.
// It is accepted only when its key is the key accountLookupFor mints from the
// same address, so an author fetched for one video can never open another.
function resolvePartVerdict(entry, url, verified) {
  const verdict = partRuleVerdict(entry, url);
  if (!verdict.gated) return verdict;
  try {
    const account = allowedAccountForUrl(entry, url, verified);
    return account ? { gated: false, partId: null, scope: verdict.scope, account } : verdict;
  } catch (e) {
    return verdict;
  }
}

// The part-rule half of resolvePartVerdict, on its own.
function partRuleVerdict(entry, url) {
  const closed = { gated: true, partId: null, scope: 'all' };
  try {
    const scope = normalizeScopeValue(entry && entry.scope);
    if (scope === 'all') return closed;

    const list = entry && Array.isArray(entry.parts) ? entry.parts : [];
    if (list.length === 0) return closed;
    // Every write goes through sanitizePartRule, which caps the list, so a
    // longer one did not come from this extension. Truncating it would be the
    // wrong repair — for an 'only' rule the dropped ids are precisely the
    // parts that would then stop being blocked — so an implausible list is
    // refused whole, like any other thing this build cannot evaluate. It also
    // keeps the per-navigation cost of this function bounded by a constant.
    if (list.length > PART_LIST_MAX) return closed;

    const usable = [];
    for (const candidate of list) {
      if (partIsRecognised(candidate)) {
        usable.push(candidate);
      } else if (scope === 'only') {
        return closed;
      }
    }
    if (usable.length === 0) return closed;

    const parsed = partUrlParts(url);
    if (!parsed) return closed;

    let matched = null;
    for (const id of usable) {
      if (partMatchesUrl(id, parsed)) { matched = id; break; }
    }

    return {
      gated: scope === 'only' ? !!matched : !matched,
      partId: matched || null,
      scope
    };
  } catch (e) {
    return closed;
  }
}

// "all of instagram.com" / "only Reels and Explore on instagram.com" /
// "all of reddit.com except r/rust, r/kotlin".
//
// The coach is handed these, and so is the settings gate that asks whether a
// narrowing may go ahead, so both halves of that conversation describe the
// rule with the same words the user reads in Settings.
function describeScopeForHuman(rule, siteLabel) {
  try {
    const label = String(siteLabel == null ? '' : siteLabel).trim() || 'this site';
    const clean = sanitizePartRule(rule);
    if (clean.scope === 'all') return `all of ${label}`;
    const names = clean.parts.map(partLabel).filter(Boolean);
    if (names.length === 0) return `all of ${label}`;
    if (clean.scope === 'only') return `only ${joinWithAnd(names)} on ${label}`;
    return `all of ${label} except ${names.join(', ')}`;
  } catch (e) {
    return 'this site';
  }
}

// "a", "a and b", "a, b and c".
function joinWithAnd(items) {
  if (items.length <= 1) return items[0] || '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

// Does this edit leave LESS of the site blocked than before?
//
// One sentence covers the whole table: any edit that leaves less of the site
// blocked goes through the coach, and every other edit saves directly. That
// asymmetry is the point of the product — tightening a rule is a decision the
// user is allowed to make alone, loosening one is the decision the coach
// exists for — so this answers conservatively wherever it cannot prove the
// direction, and it fails to `true` (talk to the coach) rather than to false.
function partEditIsLoosening(before, after) {
  try {
    const a = sanitizePartRule(before);
    const b = sanitizePartRule(after);
    // Going from "block all of it" to any carve-out always leaves less blocked.
    if (a.scope === 'all') return b.scope !== 'all';
    // Going back to "block all of it" never does.
    if (b.scope === 'all') return false;
    // 'only' <-> 'except' cannot be compared by list membership: the same two
    // ids mean opposite things on either side of the switch, and which of the
    // two covers more of the site depends on the site. Unprovable means yes.
    if (a.scope !== b.scope) return true;
    if (a.scope === 'only') return a.parts.some(id => !b.parts.includes(id));
    return b.parts.some(id => !a.parts.includes(id));
  } catch (e) {
    return true;
  }
}

// ===========================================================================
// ALLOWED ACCOUNTS — people whose pages stay open on a blocked site
// ===========================================================================
//
// "Block Instagram, but never stop me looking at @natgeo." A part rule cannot
// say that: a part is a SECTION of a site, and an account is a person whose
// profile and posts are scattered across every section of it. So this is a
// second, independent list on the limits entry — `allowedAccounts`, bare
// lowercase handles — applied after the part rule, and only ever to open.
//
// What it can prove, and so what it does, is decided by the address:
//
//   instagram.com  /natgeo/…, /natgeo/p/<code>/, /natgeo/reel/<code>/ and
//                  /stories/natgeo/…. A bare /p/<code>/ or /reel/<code>/ —
//                  what the home feed and a shared link use — names no author,
//                  and stays gated. Instagram's oEmbed needs a Meta app token,
//                  and reading the author off the page would mean deciding
//                  after the page had rendered, from markup a single-page app
//                  does not keep in step with its address.
//   x.com          /natgeo and everything under it, /natgeo/status/<id>
//   twitter.com    included. /i/web/status/<id> names no author: gated.
//   tiktok.com     /@natgeo and everything under it, /@natgeo/video/<id>
//                  included.
//   youtube.com    /@natgeo and everything under it. A video (/watch?v=,
//                  /shorts/<id>, /live/<id>) names no channel, so it is the one
//                  case answered by a LOOKUP: accountLookupFor mints the
//                  request, background.js makes it, and resolvePartVerdict
//                  accepts the answer only for the video it was made for.
//
// Everything not proven stays gated. That includes the known hole, stated
// rather than hidden: the handle in an X, TikTok or Instagram address is
// trusted as the author, so a hand-edited address can open a post by someone
// else. That is a person working around a rule they set — which the coach
// exists for and this file cannot prevent — and it is the same trust the
// custom `path:` rules above already extend to an address.
//
// Handles that are also a route on the site ('explore', 'reels', 'home', 'i')
// never match, so allowing an "account" called reels can never open Reels.

// A generic shape every service's handles fit inside. Each service narrows it
// again at match time; a stored handle that fits here but not there simply
// never matches.
const ACCOUNT_HANDLE_RE = /^[a-z0-9_.-]{1,30}$/;

// Same cap, same reasoning, as PART_LIST_MAX.
const ACCOUNT_LIST_MAX = 20;

// First path segments that are a page of the site rather than an account, for
// the two services whose profiles live at the bare /<handle>. It does not need
// to be exhaustive — none of these can be registered as a handle — only to
// hold the names a person might type to get at a section.
const INSTAGRAM_ROUTES = new Set([
  'about', 'accounts', 'api', 'archive', 'challenge', 'create', 'developer',
  'direct', 'directory', 'emails', 'explore', 'graphql', 'highlights', 'legal',
  'lite', 'locations', 'nametag', 'notifications', 'p', 'privacy', 'qr',
  'reel', 'reels', 'session', 'stories', 'terms', 'topics', 'tv', 'web',
  'your_activity'
]);
const X_ROUTES = new Set([
  'account', 'bookmarks', 'communities', 'compose', 'explore', 'grok',
  'hashtag', 'home', 'i', 'intent', 'jobs', 'lists', 'login', 'logout',
  'messages', 'notifications', 'premium', 'privacy', 'search', 'settings',
  'share', 'signup', 'tos', 'topics'
]);

const YOUTUBE_VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;

// The services an allowlist means something on. `account(segments)` reads the
// author off the lowercased path segments, or answers null; `lookup(parsed)`
// is present only where the author has to be asked for.
const ACCOUNT_SERVICES = [
  {
    key: 'instagram',
    hosts: ['instagram.com'],
    handleRe: /^[a-z0-9_](?:[a-z0-9_.]{0,28}[a-z0-9_])?$/,
    routes: INSTAGRAM_ROUTES,
    account(segments) {
      if (segments[0] === 'stories') return segments[1] || null;
      return segments[0] || null;
    }
  },
  {
    key: 'x',
    hosts: ['x.com', 'twitter.com'],
    handleRe: /^[a-z0-9_]{1,15}$/,
    routes: X_ROUTES,
    account(segments) {
      return segments[0] || null;
    }
  },
  {
    key: 'tiktok',
    hosts: ['tiktok.com'],
    handleRe: /^[a-z0-9_][a-z0-9_.]{1,23}$/,
    routes: null,
    account(segments) {
      const first = segments[0] || '';
      return first.charAt(0) === '@' ? first.slice(1) : null;
    }
  },
  {
    key: 'youtube',
    hosts: ['youtube.com'],
    handleRe: /^[a-z0-9_][a-z0-9_.-]{2,29}$/,
    routes: null,
    account(segments) {
      const first = segments[0] || '';
      return first.charAt(0) === '@' ? first.slice(1) : null;
    },
    // Only a real 11-character id is looked up. The request goes to the site
    // the user is already on, at the same public oEmbed endpoint
    // page_context.js already asks for the video's title. The id is read from
    // the address as written: video ids are case-sensitive.
    lookup(parsed) {
      const segments = parsed.pathname.split('/').filter(Boolean);
      const first = (segments[0] || '').toLowerCase();
      let id = '';
      if (first === 'watch' && segments.length === 1) {
        id = parsed.searchParams.get('v') || '';
      } else if ((first === 'shorts' || first === 'live') && segments.length === 2) {
        id = segments[1];
      }
      if (!YOUTUBE_VIDEO_ID_RE.test(id)) return null;
      const watchUrl = `https://www.youtube.com/watch?v=${id}`;
      return {
        key: `youtube:${id}`,
        fetchUrl: `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(watchUrl)}`
      };
    }
  }
];

function hostIsOneOf(host, hosts) {
  const h = String(host || '').toLowerCase().replace(/\.$/, '');
  return hosts.some(d => h === d || h.endsWith(`.${d}`));
}

// The service a blocked target (a domain) or a page host belongs to, or null.
function accountServiceForHost(host) {
  return ACCOUNT_SERVICES.find(service => hostIsOneOf(host, service.hosts)) || null;
}

function accountHandleUsable(service, handle) {
  return !!service && typeof handle === 'string' && service.handleRe.test(handle) &&
    !(service.routes && service.routes.has(handle));
}

// Whether a blocked site can carry an allowlist at all. The options row asks
// this before it offers the field.
function accountsSupportedFor(target) {
  try {
    return !!accountServiceForHost(target);
  } catch (e) {
    return false;
  }
}

// Clean an allowlist on its way to storage, or on its way into a verdict.
// Keeps well-formed handles, lowercased and without the @, in order, deduped,
// capped. Anything else is dropped — which on this list can only ever mean
// fewer pages open.
function sanitizeAllowedAccounts(raw) {
  try {
    if (!Array.isArray(raw)) return [];
    const out = [];
    for (const candidate of raw) {
      if (out.length >= ACCOUNT_LIST_MAX) break;
      if (typeof candidate !== 'string') continue;
      const handle = candidate.trim().replace(/^@/, '').toLowerCase();
      if (!ACCOUNT_HANDLE_RE.test(handle) || out.includes(handle)) continue;
      out.push(handle);
    }
    return out;
  } catch (e) {
    return [];
  }
}

// The allowlist on a stored entry. An own property only: storage is JSON, and
// a list reached through a prototype did not come from it.
function allowedAccountsOf(entry) {
  if (!entry || typeof entry !== 'object') return [];
  if (!Object.prototype.hasOwnProperty.call(entry, 'allowedAccounts')) return [];
  return sanitizeAllowedAccounts(entry.allowedAccounts);
}

// What the user typed into the row's box, as a handle, or null.
//
// Accepts the handle alone ('natgeo', '@natgeo') and a pasted profile address
// ('https://www.instagram.com/natgeo/', 'youtube.com/@natgeo'), because both
// are what people have in hand. A handle the service could never have — or
// one that is really a section of the site — is refused here, so the row never
// offers to save something that would silently never match.
function normalizeAccountInput(raw, target) {
  try {
    const service = accountServiceForHost(target);
    if (!service) return null;
    const text = String(raw == null ? '' : raw).trim();
    if (!text || text.length > 200) return null;
    let handle = null;
    if (text.includes('/') || hostIsOneOf(text, service.hosts)) {
      const parsed = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
      if (!hostIsOneOf(parsed.hostname, service.hosts)) return null;
      const segments = parsed.pathname.toLowerCase().split('/').filter(Boolean);
      if (segments[0] === 'stories') return null;
      handle = service.account(segments);
    } else {
      handle = text.replace(/^@/, '').toLowerCase();
    }
    return accountHandleUsable(service, handle) ? handle : null;
  } catch (e) {
    return null;
  }
}

// The allowed account this URL belongs to, or null. See the section header
// for what each service can prove; `verified` is the lookup answer, if any.
function allowedAccountForUrl(entry, url, verified) {
  try {
    const allowed = allowedAccountsOf(entry);
    if (allowed.length === 0 || typeof url !== 'string') return null;
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    const service = accountServiceForHost(parsed.hostname);
    if (!service) return null;
    let handle = service.account(parsed.pathname.toLowerCase().split('/').filter(Boolean));
    if (!handle && service.lookup && verified && typeof verified === 'object') {
      const lookup = service.lookup(parsed);
      if (lookup && verified.key === lookup.key) handle = verified.account;
    }
    if (!accountHandleUsable(service, handle)) return null;
    return allowed.includes(handle) ? handle : null;
  } catch (e) {
    return null;
  }
}

// The request that would name this URL's author, when the address does not
// and the entry has someone to compare the answer with: { key, fetchUrl }, or
// null. background.js makes the request; this file only mints it, because it
// has to stay free of anything asynchronous.
function accountLookupFor(entry, url) {
  try {
    if (allowedAccountsOf(entry).length === 0 || typeof url !== 'string') return null;
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
    const service = accountServiceForHost(parsed.hostname);
    if (!service || !service.lookup) return null;
    if (service.account(parsed.pathname.toLowerCase().split('/').filter(Boolean))) return null;
    return service.lookup(parsed);
  } catch (e) {
    return null;
  }
}

// The author's handle out of a lookup's JSON answer, or null. Only the exact
// shape a channel-handle URL takes is accepted — a legacy /channel/UC… or
// /user/… author has no handle to compare, and its videos stay gated.
function accountFromLookupResponse(data) {
  try {
    if (!data || typeof data.author_url !== 'string') return null;
    const parsed = new URL(data.author_url);
    if (parsed.protocol !== 'https:' || !hostIsOneOf(parsed.hostname, ['youtube.com'])) return null;
    const match = /^\/@([^/]+)\/?$/.exec(parsed.pathname);
    if (!match) return null;
    const handle = match[1].toLowerCase();
    const youtube = ACCOUNT_SERVICES.find(service => service.key === 'youtube');
    return accountHandleUsable(youtube, handle) ? handle : null;
  } catch (e) {
    return null;
  }
}

// Does this entry carry anything that can leave an address on a blocked host
// open? A part rule, or an allowlist. background.js drops a host's redirect
// for exactly these and the content script watches the address on exactly
// these — the reasoning on hasPartRule, extended to the second list.
function hasPageRule(entry) {
  try {
    return hasPartRule(entry) || allowedAccountsOf(entry).length > 0;
  } catch (e) {
    return false;
  }
}

// The rule a page keeps to judge its own address changes with: the sanitised
// part rule, plus the allowlist when there is one. The key is absent when
// there is not, so the rule for a pre-feature entry is unchanged.
function pageRuleFor(entry) {
  const rule = sanitizePartRule(entry);
  const allowed = allowedAccountsOf(entry);
  if (allowed.length) rule.allowedAccounts = allowed;
  return rule;
}

// Does this edit to an allowlist open anything that was not open before?
// Adding a handle does; removing one never does. Unprovable means yes.
function allowedAccountsEditIsLoosening(before, after) {
  try {
    const a = sanitizeAllowedAccounts(before);
    return sanitizeAllowedAccounts(after).some(handle => !a.includes(handle));
  } catch (e) {
    return true;
  }
}

// "@natgeo and @nasa are always allowed on instagram.com" — for the coach, and
// for the settings sentence that asks whether to add one.
function describeAllowedAccountsForHuman(list, siteLabel) {
  try {
    const label = String(siteLabel == null ? '' : siteLabel).trim() || 'this site';
    const handles = sanitizeAllowedAccounts(list).map(h => `@${h}`);
    if (handles.length === 0) return `no accounts are always allowed on ${label}`;
    return `${joinWithAnd(handles)} ${handles.length === 1 ? 'is' : 'are'} always allowed on ${label}`;
  } catch (e) {
    return 'this site';
  }
}

// ===========================================================================
// PAGE SCOPE — which single page one granted pass was for
// ===========================================================================

// How specific a destination is, keyed by the contentType strings
// page_context.js already mints. Deliberately a lookup table over that
// existing vocabulary rather than a second classifier: page_context.js decides
// what a page IS, and there must not be two answers to that.
//
// It lives here rather than beside the classifier because it is a pure map
// lookup on a string, and because the Android background WebView loads this
// file and not page_context.js. Putting it there would mean the worker could
// not ask the question on the one platform where the worker is a WebView.
//
//   item     one thing with an end: a video, a post, a thread, an issue. The
//            only shape a page-scoped pass makes sense for.
//   surface  a place with things on it that is still somewhere in particular:
//            a channel, a profile, a search, a repository.
//   feed     an endless middle. There is no "finishing" one, which is exactly
//            why a pass can never be pinned to it.
const DESTINATION_SPECIFICITY = {
  'YouTube Video': 'item',
  'YouTube Short': 'item',
  'Instagram Post': 'item',
  'Instagram Reel': 'item',
  'Instagram Story': 'item',
  'TikTok Video': 'item',
  'Reddit Post': 'item',
  'Tweet / X Post': 'item',
  'GitHub Issue': 'item',
  'GitHub Pull Request': 'item',

  'YouTube Channel': 'surface',
  'Instagram Profile': 'surface',
  'Instagram DMs': 'surface',
  'TikTok Profile': 'surface',
  'TikTok Search': 'surface',
  'Twitter / X Profile': 'surface',
  'Twitch Stream': 'surface',
  'GitHub Repository': 'surface',

  'Instagram Home Feed': 'feed',
  'Instagram Explore Feed': 'feed',
  'Instagram Hashtag Feed': 'feed',
  'TikTok For You Feed': 'feed',
  'TikTok Hashtag Feed': 'feed',
  'Subreddit Feed': 'feed',
  'Reddit Page': 'feed',
  'YouTube Page': 'feed'
};

// 'item' | 'surface' | 'feed' | 'unknown' for one page context.
//
// The generic fallback is the interesting half, because most of the web is not
// in the table above. A URL with at least one path segment AND a title that is
// not just the URL echoed back is an article or a document — an item. A bare
// host is a front door — a feed. Anything else is unknown, and unknown is
// treated exactly as a feed is by pageScopeFor: no scoped pass.
function destinationSpecificity(pageCtx) {
  try {
    if (!pageCtx || typeof pageCtx !== 'object') return 'unknown';
    const contentType = typeof pageCtx.contentType === 'string' ? pageCtx.contentType : '';
    // markSearch() suffixes a type it has already classified, so the suffix is
    // the more specific fact: a search result page is a surface, whatever the
    // underlying type was.
    if (/ \(search\)$/.test(contentType)) return 'surface';
    const known = Object.prototype.hasOwnProperty.call(DESTINATION_SPECIFICITY, contentType)
      ? DESTINATION_SPECIFICITY[contentType]
      : null;
    if (known) return known;

    const url = typeof pageCtx.url === 'string' ? pageCtx.url : '';
    let parsed;
    try { parsed = new URL(url); } catch (e) { return 'unknown'; }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return 'unknown';
    const segments = String(parsed.pathname || '/').split('/').filter(Boolean);
    if (segments.length === 0) return 'feed';
    const title = typeof pageCtx.title === 'string' ? pageCtx.title.trim() : '';
    const titleIsReal = !!title && title !== url && !/^https?:\/\//i.test(title);
    return titleIsReal ? 'item' : 'unknown';
  } catch (e) {
    return 'unknown';
  }
}

// Hosts where "does the address change when you move to the next thing?" has
// actually been checked, and the answer was yes.
//
// That question is the entire criterion, and the whole feature rests on it: a
// page-scoped pass is enforced by noticing that location.href stopped matching
// the key it was granted for. On a host where swiping to the next item leaves
// the address alone, a pass "for one reel" is silently a pass for the whole
// feed — the exact failure the feature exists to prevent, delivered with a
// badge saying THIS PAGE ONLY.
//
// A host that is not named in either list is covered by the generic `url:`
// fallback, which is safe by construction: an ordinary site changes its
// address when you navigate, and if it does not it is a single-page app whose
// key simply never stops matching, which is the pre-existing behaviour.
const SCOPE_SUPPORTED_HOSTS = [
  'youtube.com', 'youtu.be', 'reddit.com', 'x.com', 'twitter.com', 'github.com'
];

// Hosts where it has NOT been checked, and which are therefore inert: present,
// named, and refused. Instagram and TikTok are the two destinations people most
// want to scope ("just this one reel someone sent me") and the two nobody has
// been able to verify without a device — swiping to the next reel may or may
// not rewrite the address. Moving one of these into the list above, once
// somebody has watched it happen on a phone, is the whole of the change.
const SCOPE_HOSTS_TO_VERIFY = ['instagram.com', 'tiktok.com'];

// Host-suffix match. `x.com` covers `www.x.com` and `mobile.x.com` but not
// `notx.com`, which is the same rule the blocklist itself uses.
function scopeHostMatches(host, list) {
  const clean = String(host == null ? '' : host).toLowerCase();
  return list.some(entry => clean === entry || clean.endsWith(`.${entry}`));
}

// Query parameters that are never part of a page's identity: they record where
// the reader came from, not what they are looking at. Stripping them is what
// lets a link out of a newsletter, a share sheet and an ad all land on the same
// key as the plain address, so a pass survives being re-shared.
//
// What is deliberately NOT in this list is the more important half. `t`, `list`,
// `id`, `p` and `page` all read like noise and every one of them is identity
// somewhere real: `t` is the topic on every phpBB forum, `p` the post on a
// WordPress blog, `id` the item on Hacker News. Nothing about the name alone
// tells you which it is, so this list holds only the analytics and click-id
// parameters that no site has ever routed on, and everything else is kept.
//
// That asymmetry is the whole shape of the generic key. Keeping a parameter
// that turns out to be noise costs one re-gate on a re-shared link: the coach
// appears again, which is annoying, visible, and precisely the state the user
// chose when they blocked the site. Dropping one that turns out to be identity
// hands out a pass for every page on the host that differs only in that
// parameter, silently, for the length of the pass. The first is recoverable in
// twelve seconds; the second is the failure this feature exists to prevent.
//
// The YouTube-style resume parameters (`t`, `list`, `index`) are still
// collapsed where they are known to be resume parameters — YouTube's own branch
// below reads `v` and ignores the rest of the query outright. They are kept
// here, on hosts nobody has classified, because on those hosts the same few
// letters mean something else.
const SCOPE_NOISE_PARAMS = new Set([
  'fbclid', 'gclid', 'dclid', 'gbraid', 'wbraid', 'msclkid', 'yclid',
  'twclid', 'ttclid', 'igshid', 'igsh', 'mc_cid', 'mc_eid', 'mkt_tok',
  '_ga', '_gl', 'ref', 'ref_src', 'ref_url', 'referrer', 'si'
]);

// The identifying half of a query string, canonically ordered, or ''.
//
// The order has to be canonical because `?a=1&b=2` and `?b=2&a=1` are the same
// page, and a user who reopens one from a bookmark must not be told they
// drifted. The re-encoding has to happen because URLSearchParams hands the
// values back decoded: a value containing a literal `&` or `=` would otherwise
// be indistinguishable from a parameter boundary, which is a way to forge one
// page's key out of a different page's address.
function scopeQuerySignature(parsed) {
  const pairs = [];
  parsed.searchParams.forEach((value, name) => {
    const lower = String(name).toLowerCase();
    if (lower.slice(0, 4) === 'utm_') return;
    if (SCOPE_NOISE_PARAMS.has(lower)) return;
    pairs.push(`${encodeURIComponent(name)}=${encodeURIComponent(value)}`);
  });
  if (!pairs.length) return '';
  pairs.sort();
  return `?${pairs.join('&')}`;
}

// The identifying half of a fragment, or ''.
//
// A fragment is two different things wearing one syntax. `#top`, `#comments`
// and `#cite_note-3` are anchors INTO the page that is already open; keeping
// them would fire the drift screen every time a reader followed a footnote on a
// page the pass plainly covers. `#/feed`, `#!/video/9` and `#/inbox?tab=2` are
// the address bar of a hash-routed single-page app, where the fragment is the
// only part of the URL that changes as you move from one page to the next —
// dropping those turns a pass for one page into a pass for the whole app, and
// makes content.js's hashchange listener incapable of ever changing a verdict.
//
// They are told apart by shape, which is the only signal there is: a route
// starts at a root (`/` or `!`) or carries a path or query of its own; a bare
// word is read as an anchor. That leaves one gap on purpose — a router whose
// routes are bare words (`#feed`, `#video9`) still collapses — and it is the
// cheapest gap available: such routers are rare, the path and query still
// narrow the key, and closing it would re-gate every anchor click on the web.
function scopeHashSignature(parsed) {
  const raw = String(parsed.hash || '');
  const hash = raw.charAt(0) === '#' ? raw.slice(1) : raw;
  if (!hash) return '';
  const first = hash.charAt(0);
  if (first === '/' || first === '!' || /[/?&]/.test(hash)) return `#${hash}`;
  return '';
}

// What an id read out of a path or a query is allowed to look like. Every
// catalogue key below is a host's own id for one item, and every one of them is
// alphanumerics, `_` and `-`; anything else is not an id this build recognises,
// and a key minted from something nobody recognises is a key nobody can reason
// about. Failing the test yields '' — no scoped pass, or a re-gate — which is
// the direction everything in this file fails in.
const SCOPE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

// A canonical, query-noise-immune identity for one page, or ''.
//
// Two URLs that are the same page must produce the same key, or a pass ends the
// moment someone reloads it. That is why YouTube reads the `v` parameter and
// nothing else: `&t=90` (a timestamped re-share), `&list=PL...` (opened from a
// playlist) and `?utm_source=` (opened from anywhere at all) are all the same
// video, and a scoped pass that dies on a re-share is a bug the user
// experiences as the feature being broken.
//
// THE OTHER HALF OF EVERY BRANCH BELOW IS WHERE THE KEY MAY BE READ FROM, and
// it is the half that has teeth. A key is the entire enforcement mechanism of a
// page-scoped pass: sessionCoversUrl grants everything that mints the same
// string. So a branch that will mint an item's key from an address that is not
// that item does not merely mis-identify a page — it opens every page that
// address can reach, for the length of the pass, to anyone who edits the
// address bar. That is not a theoretical attacker here; this is a self-control
// product, and the person it protects is the person motivated to defeat it.
//
// So every branch is anchored to the position the host actually serves that
// item at, and reads a parameter only on a path where that parameter means what
// its name says. `/results?search_query=cats&v=<id>` is a search page, not
// video `<id>`, however much its query looks like one.
//
// The generic fallback keeps the identifying half of the query and the fragment
// (see SCOPE_NOISE_PARAMS and scopeHashSignature) rather than dropping both. It
// used to drop them, on the reasoning that an unknown host gives you no way to
// tell a tracking parameter from an identifying one and that over-collapsing
// was the smaller, rarer failure. It is neither. Hacker News is `item?id=`, and
// it is in COMMON_SITES; MediaWiki is `index.php?title=`, phpBB is
// `viewtopic.php?t=`, a great many blogs are `?p=`, and a hash-routed app is
// nothing but fragment. On every one of those, dropping the query meant one
// "this page only" pass covered the whole site and the drift screen could never
// fire at all.
function pageScopeKeyFor(urlStr) {
  try {
    if (!urlStr || typeof urlStr !== 'string') return '';
    let parsed;
    try { parsed = new URL(urlStr); } catch (e) { return ''; }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';

    const host = String(parsed.hostname || '').toLowerCase();
    const path = String(parsed.pathname || '/');

    if (scopeHostMatches(host, ['youtu.be'])) {
      // A youtu.be address is a video id and nothing else. A second segment
      // means it is some other kind of link, and a link this build cannot
      // identify must not be handed the key of a video.
      const segments = path.split('/').filter(Boolean);
      const id = segments.length === 1 ? segments[0] : '';
      return SCOPE_ID_RE.test(id) ? `yt:video:${id}` : '';
    }
    if (scopeHostMatches(host, ['youtube.com'])) {
      const shorts = path.match(/^\/shorts\/([^/]+)/);
      if (shorts) return SCOPE_ID_RE.test(shorts[1]) ? `yt:video:${shorts[1]}` : '';
      const live = path.match(/^\/live\/([^/]+)/);
      if (live) return SCOPE_ID_RE.test(live[1]) ? `yt:video:${live[1]}` : '';
      // `v` IS ONLY A VIDEO ID ON A WATCH PAGE. YouTube ignores a query
      // parameter it does not use, so `/feed/subscriptions?v=<id>` renders the
      // subscription feed, `/results?search_query=cats&v=<id>` renders search,
      // and `/@channel?v=<id>` renders the channel — while all three, before
      // this gate, minted the video's key. One scoped pass plus one pasted
      // parameter was therefore a pass for search, subscriptions and every
      // channel page on the flagship host, entirely inside the SPA where no
      // network rule ever sees it. Reading `v` only where the path says "this
      // is a video page" is the whole fix.
      if (!/^\/watch\/?$/.test(path)) return '';
      const v = parsed.searchParams.get('v') || '';
      return SCOPE_ID_RE.test(v) ? `yt:video:${v}` : '';
    }
    if (scopeHostMatches(host, ['reddit.com'])) {
      // The slug after the id is decorative and Reddit itself will serve the
      // post without it, so it is left out of the identity. Where `/comments/`
      // sits is not decorative: the match used to float anywhere in the path,
      // so any address carrying `/comments/<id>` anywhere in it minted that
      // post's key. These are the shapes Reddit serves a post at, anchored.
      const post = path.match(/^\/(?:(?:r|u|user)\/[^/]+\/)?comments\/([a-z0-9]{1,20})(?:\/|$)/i);
      return post ? `reddit:post:${post[1].toLowerCase()}` : '';
    }
    if (scopeHostMatches(host, ['x.com', 'twitter.com'])) {
      // `/<handle>/status/<id>` and `/i/web/status/<id>` are the two addresses,
      // plus whatever the tweet's own subpages append (`/photo/1`, `/likes`),
      // all of which are still that tweet. The handle is decorative — X serves
      // the tweet under any handle — so the id alone is the identity. Anchoring
      // is what stops a deeper address that merely contains `/status/<id>`
      // (`/i/lists/status/<id>` and anything else X may add) minting it too.
      const web = path.match(/^\/i\/(?:web\/)?status\/(\d{1,25})(?:\/|$)/);
      if (web) return `x:status:${web[1]}`;
      const status = path.match(/^\/[^/]+\/status\/(\d{1,25})(?:\/|$)/);
      return status ? `x:status:${status[1]}` : '';
    }
    if (scopeHostMatches(host, ['instagram.com'])) {
      // Anchored already, but two of these were still reading a segment that is
      // not the item they name. `/reels/<code>` also matched `/reels/audio/<id>`
      // — the feed of every reel using one sound — and minted `ig:reel:audio`
      // for every such feed, so the reel branch now has to be the whole path.
      // `/stories/<user>` was the entire key, so a pass for one story covered
      // every story that account posts, and `/stories/highlights/<id>` collapsed
      // every highlight reel on the site into `ig:story:highlights`; the second
      // segment is part of the identity now.
      //
      // `ig:direct:inbox` still covers the whole of `/direct` that is not a
      // named thread, and that is intended: DMs are one surface, not a list of
      // items, and the inbox and the request list are two views of it.
      const post = path.match(/^\/p\/([A-Za-z0-9_-]{1,64})(?:\/|$)/);
      if (post) return `ig:p:${post[1]}`;
      const reel = path.match(/^\/reels?\/([A-Za-z0-9_-]{1,64})\/?$/);
      if (reel) return `ig:reel:${reel[1]}`;
      const story = path.match(/^\/stories\/([A-Za-z0-9._-]{1,64})(?:\/([A-Za-z0-9._-]{1,64}))?(?:\/|$)/);
      if (story) {
        return story[2]
          ? `ig:story:${story[1].toLowerCase()}/${story[2]}`
          : `ig:story:${story[1].toLowerCase()}`;
      }
      const direct = path.match(/^\/direct\/t\/([A-Za-z0-9_-]{1,64})(?:\/|$)/);
      if (direct) return `ig:direct:${direct[1]}`;
      if (/^\/direct(\/|$)/.test(path)) return 'ig:direct:inbox';
      return '';
    }
    if (scopeHostMatches(host, ['tiktok.com'])) {
      // `/@<handle>/video/<id>` is the address TikTok serves a video at. The
      // match used to float, so `/foryou/video/<id>` — or any other path with
      // those two segments buried in it — minted the video's key as well.
      const video = path.match(/^\/@[^/]+\/video\/(\d{1,25})(?:\/|$)/);
      return video ? `tt:video:${video[1]}` : '';
    }
    if (scopeHostMatches(host, ['github.com'])) {
      // This one was already right, and the audit is worth recording: every
      // segment of the key is read from a fixed position from the start of the
      // path, so no other address GitHub serves can produce another page's key.
      // The trailing `(?:\/|$)` keeps `/pull/42/files` and `/pull/42/commits`
      // on the pull request they belong to; the bound on the number is only so
      // that a pathological path cannot mint a pathological key.
      const issue = path.match(/^\/([^/]+)\/([^/]+)\/(issues|pull)\/(\d{1,12})(?:\/|$)/);
      return issue ? `gh:${issue[1].toLowerCase()}/${issue[2].toLowerCase()}/${issue[3]}/${issue[4]}` : '';
    }

    // Generic: origin + path + the identifying half of the query and fragment,
    // with a trailing slash normalised away so `/a` and `/a/` are one page.
    const trimmed = path.length > 1 ? path.replace(/\/+$/, '') : path;
    return `url:${parsed.origin}${trimmed}${scopeQuerySignature(parsed)}${scopeHashSignature(parsed)}`;
  } catch (e) {
    return '';
  }
}

// Titles page_context.js mints when it knows there is a video but not what it
// is called. Re-stated here rather than imported because this file must not
// depend on page_context.js — see the header. A scope label reading
// "YouTube Video (dQw4w9WgXcQ)" is worse than none: the badge and the drift
// screen both quote it back to the user as the thing they said they wanted.
const SCOPE_PLACEHOLDER_TITLE = /^(?:YouTube Video|YouTube Short) \(/;

// A label the badge and the drift screen can quote. Long enough to be
// recognisable, short enough not to wrap the badge onto three lines.
const SCOPE_LABEL_MAX = 60;

function clampScopeLabel(value) {
  const flat = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  if (!flat) return '';
  return flat.length > SCOPE_LABEL_MAX ? `${flat.slice(0, SCOPE_LABEL_MAX - 1)}\u2026` : flat;
}

// What to call a destination that has no title of its own.
const SCOPE_FALLBACK_LABELS = {
  'Instagram Post': 'this Instagram post',
  'Instagram Reel': 'this reel',
  'Instagram Story': 'this story',
  'Instagram DMs': 'your DMs',
  'TikTok Video': 'this video',
  'Reddit Post': 'this post',
  'Tweet / X Post': 'this post',
  'YouTube Video': 'this video',
  'YouTube Short': 'this short',
  'GitHub Issue': 'this issue',
  'GitHub Pull Request': 'this pull request'
};

// Verbs the badge reads with: "Watching X", "Reading Y", "On Z".
const SCOPE_VERBS = {
  'YouTube Video': 'Watching',
  'YouTube Short': 'Watching',
  'TikTok Video': 'Watching',
  'Instagram Reel': 'Watching',
  'Twitch Stream': 'Watching',
  'Reddit Post': 'Reading',
  'Tweet / X Post': 'Reading',
  'GitHub Issue': 'Reading',
  'GitHub Pull Request': 'Reading',
  'Instagram Post': 'Reading'
};

// The scope object a page-scoped pass carries, or null when this destination
// cannot carry one.
//
// Null is not a failure; it is the ordinary answer for most of the web, and
// every caller must treat it as "grant a normal site pass". There are four
// ways to get it, and they are all the same statement: there is no single
// page here to pin a pass to.
//
//   * the destination is a feed, or unclassifiable — nothing to finish;
//   * the host is one where nobody has verified that moving on changes the
//     address, so a scoped pass could not be enforced;
//   * no canonical key could be derived;
//   * the URL is not a page at all.
function pageScopeFor(urlStr, pageCtx) {
  try {
    const specificity = destinationSpecificity(pageCtx);
    if (specificity !== 'item' && specificity !== 'surface') return null;

    let parsed;
    try { parsed = new URL(urlStr); } catch (e) { return null; }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    if (scopeHostMatches(parsed.hostname, SCOPE_HOSTS_TO_VERIFY)) return null;

    const key = pageScopeKeyFor(urlStr);
    if (!key) return null;
    // A site-specific key is only trusted for a host somebody actually
    // checked. The generic `url:` key needs no such permission — it is derived
    // from the address itself and makes no claim about the site's behaviour —
    // but `yt:video:`, `ig:p:` and the rest each encode an assumption about
    // what that site does when you move on, and an assumption nobody has
    // verified must not quietly become a pass.
    if (key.slice(0, 4) !== 'url:' && !scopeHostMatches(parsed.hostname, SCOPE_SUPPORTED_HOSTS)) {
      return null;
    }

    const ctx = pageCtx && typeof pageCtx === 'object' ? pageCtx : {};
    const contentType = typeof ctx.contentType === 'string' ? ctx.contentType : '';
    // Only a real title may be quoted back. A field that is not a string, the
    // URL echoed into the title slot, and page_context.js's "I know there is a
    // video but not its name" placeholder are all the same thing here: no
    // title. The badge and the drift screen both read this line aloud to the
    // user as the thing they said they wanted, so "YouTube Video (dQw4w9WgXcQ)"
    // there is worse than the honest fallback below it.
    const named = [ctx.videoTitle, ctx.threadTitle, ctx.searchQuery, ctx.title]
      .filter(value => typeof value === 'string')
      .map(value => value.trim())
      .filter(value => value && value !== urlStr && !SCOPE_PLACEHOLDER_TITLE.test(value));
    const label = clampScopeLabel(
      named[0] || SCOPE_FALLBACK_LABELS[contentType] || 'this page'
    );

    // The fragment is dropped unless it is doing routing work, in which case it
    // is part of the key — and stripping it here would point the drift screen's
    // "back to your page" link at an address that no longer mints the key the
    // pass was granted for, so the one link out of the screen would land the
    // user straight back on it.
    parsed.hash = scopeHashSignature(parsed);
    return {
      kind: 'page',
      key,
      url: parsed.href,
      label,
      verb: SCOPE_VERBS[contentType] || 'On'
    };
  } catch (e) {
    return null;
  }
}

// Does a granted pass still apply to this URL?
//
// THE FIRST LINE IS THE ENTIRE BACKWARD-COMPATIBILITY STORY. A session with no
// `scope` covers every URL on its target, unconditionally — which is every
// pass ever granted before this feature existed, every site pass granted after
// it, and every simple-mode grant. If that line ever stops returning true,
// every pass in flight across an upgrade turns into a gate the user did not
// ask for, on a site they already paid a conversation for.
//
// The other direction is deliberately asymmetric: a URL whose key cannot be
// computed returns false, so the pass does not cover it and the coach appears.
// Re-gating is never a safety failure — it is the state the user was in ten
// seconds ago, and the state they chose when they blocked the site.
function sessionCoversUrl(session, urlStr) {
  try {
    if (!session || !session.scope || !session.scope.key) return true;
    const key = pageScopeKeyFor(urlStr);
    if (!key) return false;
    return key === session.scope.key;
  } catch (e) {
    return false;
  }
}

// A declarativeNetRequest urlFilter that matches exactly this page, or ''.
//
// urlFilter is not a regex and not a glob: `*` is a wildcard, `^` a separator,
// and a leading or trailing `|` anchors the match. A URL containing any of
// those characters would be read as pattern syntax rather than as itself, and
// the resulting rule would match more than the page it was built for — which,
// for a rule that ALLOWS traffic past a block, is the failure that matters.
// The same goes for a non-ASCII byte, which Chrome rejects outright and takes
// the whole rule set down with.
//
// BOTH ANCHORS OR THE RULE IS A PREFIX. `|` at the front alone says "the URL
// starts like this", so a pass scoped to https://example.com/a emitted a rule
// that allowed https://example.com/about, https://example.com/archive/2024 and
// https://example.com/a?anything past the block. That is the disagreement in
// the worst possible direction: those URLs do not match the scoped session's
// key either, so the domain redirect that is deliberately kept for a scoped
// pass never fires on them, the page loads fully live — video playing, feed
// scrolling — and the only thing left is the content script's drift screen a
// round trip later. The trailing `|` makes the rule mean the page it was built
// for and nothing else.
//
// What that costs on a URL that legitimately carries a query is worth stating,
// because it is the direction this now fails in. The filter is the exact
// address, query and all, so the same page reached with one more parameter
// (`&t=90` from a timestamped share, `&list=` from a playlist) no longer
// matches the allow rule, the domain redirect fires, and the user is bounced to
// the block screen on a page their pass does cover — pageScopeKeyFor collapses
// exactly those parameters, so the overlay would have let them through. A
// spurious block screen is annoying, visible and one conversation away from
// recoverable; the prefix rule it replaces silently opened the site. No
// wildcard fixes this: `|origin/path?*v=abc` would match `v=abcdef` too, and
// `|origin/path?` would allow every video on the host.
//
// THE CONTRACT, and the one invariant every branch below owes the caller:
// whatever comes back is either '' or a filter that MATCHES THE ADDRESS IT WAS
// BUILT FROM. There is no third answer. A filter that cannot match its own URL
// is worse than no filter at all, because registerSessionRule reads a non-empty
// string as "the narrow rule worked" and never falls back — while
// domainsNeedingRedirect deliberately keeps the priority-1 domain redirect
// alive for a scoped pass. The allow rule never fires, the redirect always
// does, and coaching.js sending the user to grantedSession.scope.url lands them
// back on coaching.html, on a live pass, with no way onto the page it was
// granted for. That is the trap; '' is the way out of it.
//
// That is why an unsafe query gives up outright instead of dropping the query
// and anchoring what is left. `|origin/path|` is anchored at BOTH ends, so it
// cannot match a URL that has a query — and a query is the only reason that
// branch would ever be reached. It was a rule that could never fire.
//
// So: try origin + path + query; if that is not expressible, give up.
// '' is a supported answer, not an error — registerSessionRule falls back to
// the whole-domain filter for that ONE TAB, and the scope is then enforced by
// the content script (sessionCoversUrl, the drift screen), which is where it
// happens on Safari anyway. Note what that fallback does and does not cost: it
// is not "the content script picks up what the rule misses" in general, because
// a DNR redirect diverts a navigation BEFORE any content script runs on that
// origin — nothing of ours would be there to pick it up. It works only because
// '' makes registerSessionRule allow the whole domain IN THAT TAB, so the
// redirect is out of the way and the content script does get to run and decide.
function dnrUrlFilterFor(urlStr) {
  try {
    if (!urlStr || typeof urlStr !== 'string') return '';
    let parsed;
    try { parsed = new URL(urlStr); } catch (e) { return ''; }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
    const base = `${parsed.origin}${parsed.pathname}`;
    // The three DNR pattern characters, raw AND percent-encoded.
    //
    // Which of them `new URL()` leaves alone is not ours to decide and is not
    // stable: `^` joined the WHATWG path percent-encode set, so a caret in a
    // path survives as `^` on one Node and arrives as `%5E` on the next. Test
    // the raw forms only and the guard silently stops firing the moment the
    // engine starts encoding -- which is worse than it sounds, because the
    // filter that then gets emitted carries `%5E` while the URL Chrome
    // actually matches against carries `^`, so the rule never fires and the
    // page is not blocked at all. Giving up widens to the domain and fails
    // closed; a filter that cannot match fails open.
    //
    // Deliberately not `[^\x20-\x7e]`-style broad: `%C3%A9` from a non-ASCII
    // path is fine and must still produce a filter.
    const unsafe = /[*^|]|%(?:2[aA]|5[eE]|7[cC])|[^\x20-\x7e]/;
    const withQuery = `${base}${parsed.search || ''}`;
    if (!unsafe.test(withQuery)) return `|${withQuery}|`;
    // The query held pattern syntax. Anchoring `base` alone would emit
    // `|origin/path|`, which cannot match a URL that HAS a query — and this
    // line is only ever reached for a URL that has one. Give up instead, so
    // the caller widens to the domain for this tab and the content script
    // enforces the scope. See the contract above.
    return '';
  } catch (e) {
    return '';
  }
}
