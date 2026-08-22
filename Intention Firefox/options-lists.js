// options-lists.js - choosing what to block.
//
// The recommendation grids, the app search, and the wizard's own site and app
// lists. All of them build the same cards from the same catalogue in sites.js;
// what differs is where a pick goes - the wizard writes to its draft, the
// settings lists write through the coach gate.

function buildRecommendCard(meta, label, title, onAdd) {
  const card = document.createElement('button');
  card.type = 'button';
  card.className = 'recommend-card';
  card.title = title;
  // A catalogue entry can name something Simple Icons has no mark for (Daily
  // Mail, Prime Video); those chips are text-only rather than absent.
  if (meta && meta.icon) {
    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('class', 'chip-icon');
    // A monochrome mark (color: null) inherits the chip's text colour, so it
    // flips with the theme instead of staying the near-white it was published
    // as. See SITE_META.
    svg.setAttribute('fill', meta.color || 'currentColor');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS(svgNS, 'path');
    path.setAttribute('d', meta.icon);
    svg.appendChild(path);
    card.appendChild(svg);
  }
  const name = document.createElement('span');
  name.className = 'recommend-card-name';
  name.textContent = label;
  card.appendChild(name);
  const addIcon = document.createElement('span');
  addIcon.className = 'recommend-card-add';
  addIcon.textContent = '+';
  addIcon.setAttribute('aria-hidden', 'true');
  card.appendChild(addIcon);
  card.addEventListener('click', onAdd);
  return card;
}

// How many suggestions sit above the fold. Detected sites are never folded
// away — they are the whole point of detecting them — so this is a floor on
// what shows, not a ceiling.
const RECOMMEND_VISIBLE = 6;

// Expanded state is per grid, so opening the sites list doesn't also open the
// apps one, and it survives the re-render that adding a suggestion triggers.
const recommendExpanded = {};

// Both grids want the same tally, and the setup wizard re-renders on every
// add, so ask the worker once per page load. A visit banked while the page is
// open can wait for the next one.
let siteVisitsPromise = null;
function getSiteVisits() {
  if (!siteVisitsPromise) {
    siteVisitsPromise = sendBg({ action: 'getSiteVisits' }).then(r => r || {}, () => ({}));
  }
  return siteVisitsPromise;
}

// Shared tail of both grids: lay out `ordered`, fold everything past the cap
// behind the "show more" button, and label the detected run at the front.
// `seenCount` is how many leading entries came from the visit tally.
function renderRecommendGrid(container, more, ordered, seenCount, buildCard, rerender) {
  const expanded = !!recommendExpanded[container.id];
  const cap = Math.max(seenCount, RECOMMEND_VISIBLE);
  const shown = expanded ? ordered : ordered.slice(0, cap);

  container.innerHTML = '';
  // The labels are grid items themselves (the row is a wrapping flex line, and
  // a full-width item breaks it), so an unvisited chip can't be mistaken for
  // one the person actually opens.
  const addLabel = (text) => {
    const label = document.createElement('p');
    label.className = 'recommend-label';
    label.textContent = text;
    container.appendChild(label);
  };
  if (seenCount > 0) addLabel("You've been on these");
  shown.forEach((item, i) => {
    if (seenCount > 0 && i === seenCount) addLabel('Commonly blocked');
    container.appendChild(buildCard(item));
  });
  container.hidden = ordered.length === 0;

  const folded = ordered.length - shown.length;
  more.hidden = ordered.length === 0 || (!expanded && folded === 0);
  more.textContent = expanded ? 'Show fewer' : `Show ${folded} more`;
  more.onclick = () => {
    recommendExpanded[container.id] = !expanded;
    rerender();
  };
}

// The daily limit a tapped suggestion should use. The chips lived in the
// Blocked sites card until they moved into the Add-website dialog, where there
// was no minutes field within reach and 10 was hard-coded; now they sit beside
// one, so a chip and the Add button agree on the number that was just typed.
// The wizard's own chip grid is still inline in its step and reads the same
// (untouched, so 10) field — one number for both, wherever you tap.
function currentAddSiteLimit() {
  const el = document.getElementById('domain-limit-input');
  const val = parseInt(el ? el.value : '', 10);
  return !isNaN(val) && val > 0 ? val : DEFAULT_DAILY_MAX_MINUTES;
}

async function renderSiteRecommendations(containerId, moreId, blockedDomains) {
  const container = document.getElementById(containerId);
  const more = document.getElementById(moreId);
  const pool = COMMON_SITES.filter(s => !blockedDomains.includes(s) && !RECOMMEND_IGNORE_SITES.includes(s));
  const visits = await getSiteVisits();
  // Visited candidates lead, most-visited first; the rest keep the
  // catalogue's own order. With an empty tally this is just that order.
  const seen = pool
    .filter(s => visits[s] && visits[s].count > 0)
    .sort((a, b) => visits[b].count - visits[a].count);
  const seenSet = new Set(seen);
  const ordered = [...seen, ...pool.filter(s => !seenSet.has(s))];
  renderRecommendGrid(
    container, more, ordered, seen.length,
    (site) => {
      const meta = SITE_META[site];
      return buildRecommendCard(meta, meta ? meta.name : site, site, () => addDomainToBlocklist(site, currentAddSiteLimit()));
    },
    () => renderSiteRecommendations(containerId, moreId, blockedDomains)
  );
}

function renderAppRecommendations(containerId, moreId, blockedApps) {
  const container = document.getElementById(containerId);
  const more = document.getElementById(moreId);
  container.innerHTML = '';
  if (!HAS_APP_BLOCKING) {
    container.hidden = true;
    more.hidden = true;
    return;
  }
  getInstalledApps().then(installed => {
    const installedPkgs = new Set(installed.map(a => a.packageName));
    // Apps have no equivalent of the visit tally — Android blocks natively, so
    // nothing on this device sees app launches until one is already blocked —
    // but "is it even installed" is the same kind of signal, and it does most
    // of the same narrowing.
    const pool = COMMON_APPS.filter(a =>
      installedPkgs.has(a.packageName) &&
      !blockedApps.includes(a.packageName) &&
      !RECOMMEND_IGNORE_APPS.includes(a.packageName)
    );
    renderRecommendGrid(
      container, more, pool, 0,
      (app) => {
        const meta = SITE_META[APP_ICON_SITE[app.packageName]];
        return buildRecommendCard(meta, app.label, app.packageName, () => addApp(app));
      },
      () => renderAppRecommendations(containerId, moreId, blockedApps)
    );
  });
}

// Wires a search input to the installed-apps list from the native bridge.
// isSelected hides already-blocked apps; onAdd is called with {packageName, label}.
function wireAppSearch(inputId, resultsId, isSelected, onAdd) {
  const input = document.getElementById(inputId);
  const results = document.getElementById(resultsId);
  // Detach the results list to <body> so it renders as a floating popup,
  // fixed-positioned under the input, instead of being trapped inside the
  // stacking context of ancestors like .card (which use backdrop-filter).
  document.body.appendChild(results);
  const positionResults = () => {
    const rect = input.getBoundingClientRect();
    results.style.left = rect.left + 'px';
    results.style.top = (rect.bottom + 6) + 'px';
    results.style.width = rect.width + 'px';
  };
  window.addEventListener('scroll', () => {
    if (!results.hidden) positionResults();
  }, true);
  window.addEventListener('resize', () => {
    if (!results.hidden) positionResults();
  });
  const render = async () => {
    const q = input.value.trim().toLowerCase();
    results.innerHTML = '';
    if (!q) {
      results.hidden = true;
      return;
    }
    positionResults();
    const apps = await getInstalledApps();
    const matches = apps.filter(a =>
      !isSelected(a.packageName) &&
      (a.label.toLowerCase().includes(q) || a.packageName.toLowerCase().includes(q))
    ).slice(0, 8);
    results.hidden = matches.length === 0;
    for (const app of matches) {
      const li = document.createElement('li');

      if (app.icon) {
        const icon = document.createElement('img');
        icon.className = 'app-icon';
        icon.src = app.icon;
        icon.alt = '';
        li.appendChild(icon);
      }

      const infoContainer = document.createElement('div');
      infoContainer.className = 'domain-info';
      const span = document.createElement('span');
      span.textContent = app.label;
      span.className = 'domain-name';
      infoContainer.appendChild(span);
      const pkgSpan = document.createElement('span');
      pkgSpan.textContent = app.packageName;
      pkgSpan.className = 'app-pkg';
      infoContainer.appendChild(pkgSpan);
      li.appendChild(infoContainer);

      const btn = document.createElement('button');
      btn.textContent = 'Block';
      btn.className = 'secondary';
      btn.addEventListener('click', () => {
        onAdd(app);
        input.value = '';
        results.innerHTML = '';
        results.hidden = true;
      });
      li.appendChild(btn);
      results.appendChild(li);
    }
  };
  input.addEventListener('input', render);
  input.addEventListener('focus', () => {
    if (input.value.trim()) render();
  });
  document.addEventListener('click', (e) => {
    if (!results.hidden && e.target !== input && !results.contains(e.target)) {
      results.hidden = true;
    }
  });
}

function renderSetupDomains() {
  renderSiteRecommendations('setup-sites-recommend-grid', 'setup-sites-recommend-more', setupBlockedDomains);
  refreshSetupNav();
  saveSetupDraft();
  const list = document.getElementById('setup-websites-list');
  list.innerHTML = '';
  for (const d of setupBlockedDomains) {
    const limitInfo = setupDomainLimits[d] || { maxGrants: 3, maxMinutes: DEFAULT_DAILY_MAX_MINUTES };

    // No badge: the wizard hasn't asked about blocking mode yet at this step,
    // so there is nothing true to put there.
    const { li, fields } = buildBlockedRow({
      target: d,
      label: d,
      inlineFields: true,
      onRemove: () => {
        setupBlockedDomains = setupBlockedDomains.filter(x => x !== d);
        delete setupDomainLimits[d];
        renderSetupDomains();
      }
    });

    fields.appendChild(buildDailyLimitField(limitInfo.maxMinutes, d, (e) => {
      const val = parseInt(e.target.value, 10);
      if (!isNaN(val) && val > 0) {
        entryFor(setupDomainLimits, d).maxMinutes = val;
        // The lenient window is measured against the daily max, so the slider's
        // track just changed length under it. Repaint rather than leave a split
        // sitting at a position that now means something else.
        renderSetupDomains();
      }
    }));

    // Coach-only, matching the settings row: a simple-mode target never turns
    // strict, so a lenient/strict split has nothing to say there.
    if (setupBlockingMode !== 'simple') {
      li.appendChild(buildSetupTimelineField(d, limitInfo.maxMinutes, limitInfo.looseUntilMinutes, (value) => {
        entryFor(setupDomainLimits, d).looseUntilMinutes = value;
        saveSetupDraft();
      }));
    }

    list.appendChild(li);
  }
}

// The limits entry for a target in a draft map, created if this is the first
// thing written about it. Both setup lists grew the same four lines inline.
function entryFor(limits, target) {
  if (!limits[target]) limits[target] = { maxGrants: 3, maxMinutes: DEFAULT_DAILY_MAX_MINUTES };
  return limits[target];
}

function addSetupApp(app) {
  if (setupBlockedApps.includes(app.packageName)) return;
  setupBlockedApps.push(app.packageName);
  setupAppLimits[app.packageName] = { maxGrants: 3, maxMinutes: DEFAULT_DAILY_MAX_MINUTES };
  setupAppLabels[app.packageName] = app.label;
  renderSetupApps();
}

function renderSetupApps() {
  renderAppRecommendations('setup-apps-recommend-grid', 'setup-apps-recommend-more', setupBlockedApps);
  refreshSetupNav();
  saveSetupDraft();
  const list = document.getElementById('setup-apps-list');
  list.innerHTML = '';
  for (const pkg of setupBlockedApps) {
    const name = setupAppLabels[pkg] || pkg;
    const limitInfo = setupAppLimits[pkg] || { maxGrants: 3, maxMinutes: DEFAULT_DAILY_MAX_MINUTES };

    const { li, fields } = buildBlockedRow({
      target: pkg,
      label: name,
      inlineFields: true,
      onRemove: () => {
        setupBlockedApps = setupBlockedApps.filter(x => x !== pkg);
        delete setupAppLimits[pkg];
        delete setupAppLabels[pkg];
        renderSetupApps();
      }
    });

    fields.appendChild(buildDailyLimitField(limitInfo.maxMinutes, name, (e) => {
      const val = parseInt(e.target.value, 10);
      if (!isNaN(val) && val > 0) {
        entryFor(setupAppLimits, pkg).maxMinutes = val;
        renderSetupApps();
      }
    }));

    if (setupBlockingMode !== 'simple') {
      li.appendChild(buildSetupTimelineField(name, limitInfo.maxMinutes, limitInfo.looseUntilMinutes, (value) => {
        entryFor(setupAppLimits, pkg).looseUntilMinutes = value;
        saveSetupDraft();
      }));
    }

    list.appendChild(li);
  }
}

// iOS app blocking is opaque (Screen Time's FamilyActivitySelection, not a
// package list) — Apple's picker can't be pre-filtered to a specific app, so
// per-app tiles would all just open the same blank picker. Instead: name
// popular picks as plain text and drive everything through the one real
// "Choose apps to block" button, mirroring wireIOSAppsCard.
function renderSetupIOSApps() {
  document.getElementById('setup-apps-title').textContent = 'Block distracting apps';
  document.getElementById('setup-apps-subtitle').textContent =
    `Apps are blocked through Apple's Screen Time, so the picker below is Apple's own. Intention never learns which apps are on your phone, only how many you chose. Most people start with ${COMMON_APPS.slice(0, 4).map(a => a.label).join(', ')}. You can skip this and add apps later.`;
  document.getElementById('setup-open-add-app-btn').textContent = 'Choose apps to block';
  document.getElementById('setup-apps-recommend-grid').hidden = true;
  document.getElementById('setup-apps-recommend-grid').innerHTML = '';
  document.getElementById('setup-apps-recommend-more').hidden = true;
  document.getElementById('setup-apps-list').hidden = true;
  document.getElementById('setup-ios-apps-status').hidden = false;
  refreshSetupIOSApps();
}

async function refreshSetupIOSApps() {
  const statusEl = document.getElementById('setup-ios-apps-status');
  const authorizeBtn = document.getElementById('setup-ios-authorize-btn');
  const st = await iosScreenTimeStatus();

  if (!st || !st.available) {
    statusEl.textContent = 'App blocking needs iOS 16 or later. Website blocking still works.';
    statusEl.className = 'setup-check';
    authorizeBtn.hidden = true;
    return;
  }
  if (!st.authorized) {
    statusEl.textContent = iosAuthGuidance(st);
    statusEl.className = 'setup-check';
    authorizeBtn.hidden = false;
    return;
  }
  authorizeBtn.hidden = true;
  const n = st.selectionCount || 0;
  // Apple's picker is opaque — a count is all the web layer ever learns — so
  // this is also the only way the finish guard can tell whether an iOS user
  // has actually chosen anything.
  setupIOSSelectionCount = n;
  refreshSetupNav();
  statusEl.className = n === 0 ? 'setup-check' : 'setup-check ok';
  statusEl.textContent = n === 0
    ? 'Screen Time access granted. No apps chosen yet, so tap "Choose apps to block" above.'
    : `${n} app${n === 1 ? '' : 's or categories'} chosen.`;
}

// Unauthorized states need different guidance: before the first prompt it's a
// simple ask, but after a decline iOS may stop re-prompting, so point at the
// Screen Time settings page where access can be turned back on.
function iosAuthGuidance(st) {
  if (st.authorizationStatus === 'denied') {
    return 'Screen Time access was declined, so Apple\'s app picker can\'t load. Tap "Allow Screen Time" to try again; if no prompt appears, iOS has stopped asking, so open Settings → Screen Time → Apps with Screen Time Access and turn on Intention.';
  }
  return 'iOS will ask you to allow Screen Time access the first time you choose apps. Say yes: without it, Intention has no way to shield an app.';
}
