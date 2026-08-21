// options-rows.js - the blocked-site / blocked-app row.
//
// One row is a small card that reads top to bottom as a single decision
// getting more specific: WHICH site, HOW it is blocked, HOW MUCH at most, WHEN
// the coach stops being lenient, and WHY you set it up. Every control on it
// obeys one rule - tightening saves itself, loosening has to be argued with the
// coach first (applyOrGate in options.js) - which is why they are built here
// together rather than wherever each happens to be rendered.

// ---- The blocked-site / blocked-app row ------------------------------------
//
// A row is a small card, and it reads top to bottom as one decision getting
// more specific: WHICH site, HOW it's blocked, HOW MUCH at most, WHEN the
// coach stops being lenient, and WHY you set it up in the first place.
//
// The head is identity and the one switch that changes everything under it —
// a brand mark, the name, the Coach/Simple toggle, Remove. Everything below
// the hairline is that mode's settings. Hierarchy comes from surface and
// position: every field names itself with the 10px micro-label rather than
// with a bigger font, and the controls all sit at one size.
//
// What was here before had six controls and no order: a badge that only
// reported the blocking mode, a "Blocking mode" select two inches under it
// saying the same thing, a limit called "Daily limit" as if it were an
// allowance, and the two answers the coach actually argues from folded away
// inside a collapsed disclosure at the bottom.

function microLabel(text) {
  const el = document.createElement('span');
  el.className = 'micro-label';
  el.textContent = text;
  return el;
}

// A labelled control in the settings strip: a micro-label caption over one or
// more controls that sit on a line together. Every control in a row is named
// this way rather than by a title attribute a screen reader may never announce.
function buildRowField(labelEl, ...controls) {
  const field = document.createElement('div');
  field.className = 'row-field';
  field.appendChild(labelEl);
  const control = document.createElement('div');
  control.className = 'row-field-control';
  control.append(...controls);
  field.appendChild(control);
  return field;
}

// What the row does, and the control that changes it — one thing, in the head,
// where you read it.
//
// This replaces a pair that said the same thing twice: a "COACH" badge in the
// head and a "Blocking mode" select in the strip below it. A badge that only
// reports a setting sitting two inches above the setting is a label pretending
// to be information.
//
// Two buttons where storage has three states. The third — `mode` absent,
// meaning "follow the global default" — is not dropped, it is just no longer
// something to choose: the toggle shows the mode that is EFFECTIVE, and
// picking the one that already matches the global deletes the override rather
// than writing it. So a row you never touched still follows the global card,
// and a row you set to disagree with it stays set. Same three states, one
// fewer decision.
function buildRowModeToggle(target, label, limitInfo, globalMode, persistKey, onSaved) {
  const group = document.createElement('div');
  group.className = 'row-mode-toggle';
  // A named group, because "Coach" and "Simple" ten times down the page is
  // twenty unattached words to a screen reader without the row named once.
  group.setAttribute('role', 'group');
  group.setAttribute('aria-label', `How ${label} is blocked`);

  const current = effectiveModeFor(limitInfo, globalMode);

  const persist = async (mode) => {
    if (mode === current) return;
    const state = await getConfig();
    const currentLimits = state[persistKey] || {};
    if (!currentLimits[target]) currentLimits[target] = { maxGrants: 3 };
    // Matching the global again means having no opinion again — see above.
    if (mode === (globalMode || 'coach')) delete currentLimits[target].mode;
    else currentLimits[target].mode = mode;
    // The simple-only fields follow the mode they belong to, exactly as they
    // did when the select owned this: a coach row carrying a stale pass length
    // is a setting that does nothing and reappears if you ever switch back.
    if (mode === 'simple') {
      if (!currentLimits[target].behavior) currentLimits[target].behavior = limitInfo.behavior || 'pass';
      if (!currentLimits[target].passMinutes) currentLimits[target].passMinutes = limitInfo.passMinutes || 10;
    } else {
      delete currentLimits[target].behavior;
      delete currentLimits[target].passMinutes;
    }
    await sendBg({ action: 'saveSettings', config: { [persistKey]: currentLimits } });
    await onSaved();
  };

  for (const [mode, text] of [['coach', 'Coach'], ['simple', 'Simple']]) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'row-mode-btn';
    btn.textContent = text;
    // Buttons carrying a .selected class read as nothing at all without this;
    // aria-pressed is what makes the pair announce as a choice.
    btn.setAttribute('aria-pressed', String(mode === current));
    btn.classList.toggle('selected', mode === current);
    btn.addEventListener('click', () => persist(mode));
    group.appendChild(btn);
  }
  return group;
}

// The head and the empty settings strip, shared by all four lists (settings
// and wizard, sites and apps). Returns both, so the caller fills the strip
// with whatever its list actually offers.
//
// `inlineFields` drops the strip and hands back the head instead: the wizard
// rows carry a daily limit and nothing else, and a band of its own for one
// number is a lot of card for very little.
function buildBlockedRow({ target, label, headExtra, onRemove, inlineFields = false }) {
  const li = document.createElement('li');

  const head = document.createElement('div');
  head.className = 'row-head';

  const mark = document.createElement('span');
  mark.className = 'row-mark';
  mark.setAttribute('aria-hidden', 'true');
  applyServiceMark(mark, { key: serviceKeyFor(target), label });
  head.appendChild(mark);

  const name = document.createElement('span');
  name.className = 'domain-name';
  name.textContent = label;
  // The name still truncates on a narrow window; the title is the whole of it.
  name.title = label;
  head.appendChild(name);

  // The settings rows put the Coach/Simple toggle here, between the name and
  // Remove. The wizard rows pass nothing: it hasn't asked about blocking mode
  // yet at that step, so there is nothing true to put there.
  if (headExtra) head.appendChild(headExtra);

  // Placed before the Remove button either way, so the caller can fill it
  // afterwards and still have Remove come last.
  const fields = document.createElement('div');
  fields.className = inlineFields ? 'row-fields-inline' : 'row-fields';
  if (inlineFields) head.appendChild(fields);

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.textContent = 'Remove';
  btn.className = 'delete-btn';
  // Ten buttons all reading "Remove" is one row of the settings page to a
  // screen reader. The visible label stays short; the accessible one doesn't.
  btn.setAttribute('aria-label', `Remove ${label}`);
  btn.addEventListener('click', onRemove);
  head.appendChild(btn);

  li.appendChild(head);
  if (!inlineFields) li.appendChild(fields);

  return { li, fields };
}

// Ids for the info notes below. A page-lifetime counter rather than the target
// name: a domain is not a valid id fragment, and the same service can appear
// in both the sites list and the apps list.
let rowInfoSeq = 0;

// The ⓘ beside the absolute daily max. A disclosure, not a tooltip: a tooltip
// is a hover, and most installs of this page are a phone. `aria-expanded` and
// `aria-controls` are the whole of the semantics, and what it opens is
// ordinary text in the flow rather than a floating layer to keep positioned.
function buildInfoAffordance(labelText, text) {
  const id = `row-info-${++rowInfoSeq}`;

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'row-info-btn';
  btn.textContent = 'i';
  btn.setAttribute('aria-label', labelText);
  btn.setAttribute('aria-expanded', 'false');
  btn.setAttribute('aria-controls', id);

  const note = document.createElement('p');
  note.className = 'row-info-note';
  note.id = id;
  note.textContent = text;
  note.hidden = true;

  btn.addEventListener('click', () => {
    note.hidden = !note.hidden;
    btn.setAttribute('aria-expanded', String(!note.hidden));
  });
  return { btn, note };
}

const MAX_MINUTES_EXPLAINER =
  'The most time you could genuinely need here in one day — a ceiling, not a target. ' +
  'Your coach will never grant past it, however good the reason. Set it to what a bad day should still be allowed to cost you, not to what a normal day looks like.';

// The absolute daily max — the same `maxMinutes` field it has always been,
// under the name it has always had in the coach's own prompts ("absolute max").
// "Daily limit" read like an allowance to be spent; it is a wall.
//
// The four lists disagree about what a change means — the wizard writes to a
// draft, the settings lists gate an increase behind the coach — so the handler
// is the caller's, and only the markup is shared. `info` is settings-only: the
// wizard step explains the number in its own subtitle, and a second
// explanation per row would be three of them on one screen.
function buildDailyLimitField(minutes, ariaName, onChange, { info = false } = {}) {
  const input = document.createElement('input');
  input.type = 'number';
  input.min = '1';
  input.className = 'inline-limit-input';
  input.setAttribute('aria-label', `Absolute daily max in minutes for ${ariaName}`);
  input.value = minutes;
  input.addEventListener('change', onChange);
  const unit = document.createElement('span');
  unit.className = 'row-field-unit';
  unit.textContent = 'min/day';

  if (!info) return buildRowField(microLabel('Absolute daily max'), input, unit);

  const { btn, note } = buildInfoAffordance(
    `What the absolute daily max on ${ariaName} means`,
    MAX_MINUTES_EXPLAINER
  );
  const field = buildRowField(microLabel('Absolute daily max'), input, unit, btn);
  field.appendChild(note);
  return field;
}

// An empty list used to render as nothing at all, which reads the same as a
// list that failed to load. One line saying so, and where to start.
function renderEmptyList(list, text) {
  const li = document.createElement('li');
  li.className = 'list-empty';
  li.textContent = text;
  list.appendChild(li);
}

// The two lists' four disagreements, in one place. Everything below the head
// hairline is otherwise identical between a blocked site and a blocked app,
// and it was already two near-identical copies of the daily-max gate before
// the timeline and the reason boxes were about to make it three.
const ROW_KINDS = {
  domain: {
    persistKey: 'domainLimits',
    increaseLimit: 'increase_limit',
    increaseLoose: 'increase_loose_window',
    isApp: false
  },
  app: {
    persistKey: 'appLimits',
    increaseLimit: 'increase_app_limit',
    increaseLoose: 'increase_app_loose_window',
    isApp: true
  }
};

// ---- The loose -> strict timeline (buildLooseTimelineField) ----------------
//
// One number drawn as the day it describes: `looseUntilMinutes`, how many of
// today's minutes on this site the coach spends being lenient before it turns
// strict. Left of the split a plausible, specific reason earns time; right of
// it only genuine need does, and any pass the coach does grant comes back
// clamped short. Absent means no split at all — the whole day is lenient,
// which is exactly how every row behaved before this control existed — so the
// handle opens at the far right rather than inventing a line the user never
// drew. Dragging it back is the act of drawing one.
//
// The thing that moves is a real <input type="range">, not a div with pointer
// handlers. A range is keyboard-operable out of the box (arrows, Home, End,
// Page keys), announced by screen readers with its own value and bounds, and
// draggable, with no ARIA plumbing to get wrong. The band behind it is
// decoration and is hidden from the accessibility tree outright, because a
// screen reader reading "loose, strict, slider 15" is the same fact three
// times. The number box beside it is the second way in, for anyone who would
// rather type 15 than hunt for it; both write the same field.
//
// The band and the number update on `input` — live, as you drag — but nothing
// is saved until `change`, which for a range fires on release. Otherwise
// dragging left to right would open a coach gate for every pixel on the way.
function buildLooseTimelineField(target, label, limitInfo, kind, maxMinutes, rerender) {
  const stored = looseUntilFor(limitInfo);
  // A max that has since been lowered can leave a split beyond the end of the
  // track. Past the end and absent mean the same thing here — lenient all day.
  const effective = stored == null ? maxMinutes : Math.min(stored, maxMinutes);

  const field = document.createElement('div');
  field.className = 'row-field row-timeline-field';
  field.appendChild(microLabel('Coach goes strict after'));

  const timeline = document.createElement('div');
  timeline.className = 'row-timeline';

  // The band and the range it drives share a positioned box of their own, so
  // the range can be laid over the band without reaching the scale beneath it
  // — on a coarse pointer the range grows to a 44px target and would otherwise
  // sit on top of the number box.
  const track = document.createElement('div');
  track.className = 'row-timeline-track';

  const band = document.createElement('div');
  band.className = 'row-timeline-band';
  band.setAttribute('aria-hidden', 'true');
  const loose = document.createElement('span');
  loose.className = 'row-timeline-phase is-loose';
  loose.textContent = 'loose';
  const strict = document.createElement('span');
  strict.className = 'row-timeline-phase is-strict';
  strict.textContent = 'strict';
  band.append(loose, strict);

  const range = document.createElement('input');
  range.type = 'range';
  range.className = 'row-timeline-range';
  range.min = '0';
  range.max = String(maxMinutes);
  range.step = '1';
  range.setAttribute('aria-label', `Minutes on ${label} before the coach turns strict`);

  const scale = document.createElement('div');
  scale.className = 'row-timeline-scale';
  const zero = document.createElement('span');
  zero.className = 'row-timeline-end';
  zero.textContent = '0';
  const number = document.createElement('input');
  number.type = 'number';
  number.className = 'inline-limit-input row-timeline-number';
  number.min = '0';
  number.max = String(maxMinutes);
  number.setAttribute('aria-label', `Minutes on ${label} before the coach turns strict`);
  const end = document.createElement('span');
  end.className = 'row-timeline-end';
  end.textContent = `${maxMinutes} min`;
  scale.append(zero, number, end);

  const note = document.createElement('p');
  note.className = 'row-timeline-note';

  // Paints, never saves. Called on every drag frame and to revert a change the
  // coach didn't approve.
  const paint = (value) => {
    const pct = maxMinutes > 0 ? Math.round((value / maxMinutes) * 100) : 100;
    loose.style.flexBasis = `${pct}%`;
    strict.style.flexBasis = `${100 - pct}%`;
    range.value = String(value);
    number.value = String(value);
    // aria-valuetext, so the announcement is "15 minutes, then strict" rather
    // than a bare "15" — the number alone doesn't say what it counts.
    range.setAttribute('aria-valuetext',
      value >= maxMinutes
        ? `lenient all day, no strict phase`
        : `${value} of ${maxMinutes} minutes lenient, then strict`);
    note.textContent = value >= maxMinutes
      ? 'Lenient all day — the coach never turns strict here.'
      : `The first ${value} min of your day here are judged gently. After that, genuine need only, and passes are capped short.`;
  };
  paint(effective);

  const persist = async (value) => {
    const state = await getConfig();
    const currentLimits = state[kind.persistKey] || {};
    if (!currentLimits[target]) currentLimits[target] = { maxGrants: 3 };
    currentLimits[target].looseUntilMinutes = value;
    await sendBg({ action: 'saveSettings', config: { [kind.persistKey]: currentLimits } });
  };

  // Direction is the whole of the rule here, exactly as it is for the daily
  // max above: a SHORTER lenient window is a tightening and saves itself, a
  // LONGER one is a loosening and has to be argued for.
  const commit = async (raw) => {
    const parsed = parseInt(raw, 10);
    if (isNaN(parsed)) {
      paint(effective);
      return;
    }
    const value = Math.max(0, Math.min(maxMinutes, parsed));
    if (value === effective) {
      paint(effective);
      return;
    }
    if (value < effective) {
      paint(value);
      await persist(value);
      return;
    }
    paint(effective); // revert until/unless approved
    applyOrGate({
      // Only ever reachable in coach mode — the whole band is coach-only, so
      // there is no simple-mode branch to take here. Passed anyway, and read
      // from the row, so the day this moves it does the right thing.
      isSimple: false,
      isApp: kind.isApp,
      appLabel: kind.isApp ? label : undefined,
      changeType: kind.increaseLoose,
      domain: target,
      currentValue: effective,
      newValue: value,
      title: `Stay lenient for longer on ${label}?`,
      subtitle: `Right now your coach goes strict after ${effective} min a day on ${label}. You're asking for ${value}. Convince your coach.`,
      onApproved: rerender
    });
  };

  range.addEventListener('input', () => paint(parseInt(range.value, 10) || 0));
  range.addEventListener('change', () => commit(range.value));
  number.addEventListener('change', () => commit(number.value));

  track.append(band, range);
  timeline.append(track, scale, note);
  field.appendChild(timeline);
  return field;
}

// ---- The two site-specific answers (buildRowReasonFields) ------------------
//
// Promoted out of the collapsed <details> they used to hide inside. They are
// not a footnote to the row: they are the calm version of you, in writing,
// which the coach quotes back at the version standing in front of the block.
// A disclosure was the right shape when they were optional prose nobody read;
// it is the wrong shape for the thing that decides the argument.
//
// Keyed per SERVICE, not per target (serviceKeyFor folds the X app and x.com
// onto one answer), which is what the "Shared with …" note is telling you.
//
// Editing one now costs a conversation. They feed every gate decision on this
// service, so quietly rewriting "when is it legitimate" is just the block with
// extra steps. The FIRST write of a field is direct, exactly as the coach-
// context card's is — there is no weak moment to guard against before anything
// exists — and every edit after that routes through applyOrGate.
function buildRowReasonFields(target, label, kind, serviceReasons, allBlocked, rerender) {
  const key = serviceKeyFor(target);
  const answers = (serviceReasons || {})[key] || {};

  const wrap = document.createElement('div');
  wrap.className = 'row-reasons';

  // Only worth saying where it is true, and it is the entire explanation for
  // why editing this row also changes another one.
  const shared = (allBlocked || [])
    .filter(t => t.target !== target && serviceKeyFor(t.target) === key)
    .map(t => t.label);
  if (shared.length) {
    const sharedNote = document.createElement('p');
    sharedNote.className = 'row-reason-shared';
    sharedNote.textContent = `Shared with ${shared.join(', ')} — the same service, so this edits both.`;
    wrap.appendChild(sharedNote);
  }

  const fields = [
    {
      field: 'purpose',
      caption: "Why you're blocking it",
      changeType: 'edit_site_purpose',
      placeholder: `e.g. It eats the evening and I never meant to open it.`
    },
    {
      field: 'legitimateUse',
      caption: 'Why you need it',
      changeType: 'edit_site_legitimate',
      placeholder: `e.g. Replying to one specific DM. Never the feed.`
    }
  ];

  for (const { field, caption, changeType, placeholder } of fields) {
    const row = document.createElement('div');
    row.className = 'row-reason';

    const fieldLabel = document.createElement('label');
    fieldLabel.className = 'micro-label row-reason-label';
    fieldLabel.textContent = caption;

    const area = document.createElement('textarea');
    area.rows = 2;
    area.className = 'row-reason-input';
    area.value = answers[field] || '';
    area.placeholder = placeholder;
    area.id = `row-reason-${++rowInfoSeq}`;
    fieldLabel.htmlFor = area.id;
    // The visible caption is two or three words and repeats down the page; the
    // accessible one names the row it belongs to.
    area.setAttribute('aria-label', `${caption} — ${label}`);

    area.addEventListener('change', async () => {
      // Re-read rather than trusting the closure: another row of the same
      // service may have been edited since this one was drawn.
      const state = await getConfig();
      const existing = (state.serviceReasons || {})[key] || {};
      const before = String(existing[field] || '');
      const after = area.value.trim();
      if (after === before) return;

      if (!before) {
        // Nothing there yet, so there is nothing to weaken. Straight in.
        const next = { ...(state.serviceReasons || {}) };
        next[key] = { ...(next[key] || {}), [field]: after, updatedAt: Date.now() };
        await sendBg({ action: 'saveSettings', config: { serviceReasons: next } });
        return;
      }

      area.value = before; // revert until/unless approved
      applyOrGate({
        isSimple: false,
        isApp: kind.isApp,
        appLabel: kind.isApp ? label : undefined,
        changeType,
        domain: target,
        currentValue: before,
        newValue: after,
        title: `Change "${caption.toLowerCase()}" for ${label}?`,
        subtitle: `Your coach reads this at every block on ${label}. Rewriting it changes every future decision, not just today's. Talk it through.`,
        onApproved: rerender
      });
    });

    row.append(fieldLabel, area);
    wrap.appendChild(row);
  }
  return wrap;
}

// The one thing a simple-mode row owns: what happens when you open it, and for
// how long. There is no coach to argue with, so the loose/strict split and the
// two answers written FOR that coach are both dead controls here, and the row
// shows this pair in their place.
function buildSimpleBehaviorField(target, label, limitInfo, kind, onSaved) {
  const behaviorSelect = document.createElement('select');
  behaviorSelect.className = 'row-behavior-select';
  behaviorSelect.setAttribute('aria-label', `What happens when you open ${label}`);
  behaviorSelect.innerHTML = `<option value="pass">Timed pass</option><option value="hard">Hard block</option>`;
  behaviorSelect.value = limitInfo.behavior || 'pass';

  const minutesInput = document.createElement('input');
  minutesInput.type = 'number';
  minutesInput.min = '1';
  minutesInput.max = '180';
  minutesInput.className = 'row-minutes-input inline-limit-input';
  minutesInput.setAttribute('aria-label', `Minutes per pass on ${label}`);
  minutesInput.value = limitInfo.passMinutes || 10;

  const minutesUnit = document.createElement('span');
  minutesUnit.className = 'row-field-unit';
  minutesUnit.textContent = 'min';

  const updateVisibility = () => {
    const showMinutes = behaviorSelect.value === 'pass';
    minutesInput.hidden = !showMinutes;
    minutesUnit.hidden = !showMinutes;
  };
  updateVisibility();

  const persist = async () => {
    const state = await getConfig();
    const currentLimits = state[kind.persistKey] || {};
    if (!currentLimits[target]) currentLimits[target] = { maxGrants: 3 };
    currentLimits[target].behavior = behaviorSelect.value;
    currentLimits[target].passMinutes = parseInt(minutesInput.value, 10) || 10;
    await sendBg({ action: 'saveSettings', config: { [kind.persistKey]: currentLimits } });
    await onSaved();
  };

  behaviorSelect.addEventListener('change', () => { updateVisibility(); persist(); });
  minutesInput.addEventListener('change', persist);

  return buildRowField(microLabel('When you open it'), behaviorSelect, minutesInput, minutesUnit);
}

// Everything under the head hairline, for both lists.
//
// The absolute daily max is here in BOTH modes, because it binds in both —
// simpleGrant checks it just as the coach's grant path does, and a cap that
// still stops you but no longer appears is worse than no cap at all.
// Everything else in the band is about the coach: the loose/strict timeline
// and the two answers written for it are coach-only, and a simple row gets its
// pass controls instead.
function buildRowBody({ li, fields, target, label, limitInfo, globalMode, kind, serviceReasons, rerender }) {
  const isSimple = effectiveModeFor(limitInfo, globalMode) === 'simple';
  const stored = limitInfo.maxMinutes !== undefined
    ? limitInfo.maxMinutes
    : (limitInfo.max_minutes_per_day ?? 10);
  // A non-positive maxMinutes means unlimited; the box still has to show a
  // number you can edit, and 10 is what every other default here is.
  const currentMins = stored > 0 ? stored : 10;

  fields.appendChild(buildDailyLimitField(currentMins, label, async (e) => {
    const val = parseInt(e.target.value, 10);
    if (isNaN(val) || val <= 0) {
      e.target.value = currentMins;
      return;
    }
    const currentlyUnlimited = !(stored > 0);
    const isIncrease = currentlyUnlimited ? true : (val > stored);

    if (!isIncrease) {
      // Decreasing (or unchanged) tightens the rule — apply immediately, free.
      const state = await getConfig();
      const currentLimits = state[kind.persistKey] || {};
      if (!currentLimits[target]) currentLimits[target] = { maxGrants: 3 };
      currentLimits[target].maxMinutes = val;
      await sendBg({ action: 'saveSettings', config: { [kind.persistKey]: currentLimits } });
      await rerender();
      return;
    }

    // Increasing the limit loosens the rule — must be approved by the coach
    // (or applied outright, if this row is in simple mode).
    e.target.value = currentMins; // revert until/unless approved
    applyOrGate({
      isSimple,
      isApp: kind.isApp,
      appLabel: kind.isApp ? label : undefined,
      changeType: kind.increaseLimit,
      domain: target,
      currentValue: currentlyUnlimited ? -1 : stored,
      newValue: val,
      title: `Raise the absolute daily max on ${label}?`,
      subtitle: `Going from ${currentlyUnlimited ? 'unlimited' : stored + 'm/day'} to ${val}m/day gives you more time on ${label}. Convince your coach.`,
      onApproved: rerender
    });
  }, { info: true }));

  if (isSimple) {
    fields.appendChild(buildSimpleBehaviorField(target, label, limitInfo, kind, rerender));
    return;
  }

  // Coach-only from here down.
  li.appendChild(buildLooseTimelineField(target, label, limitInfo, kind, currentMins, rerender));
  li.appendChild(buildRowReasonFields(target, label, kind, serviceReasons, allBlockedTargets(), rerender));
}

function renderDomains(domains, limits = {}, globalMode = 'coach', serviceReasons = {}) {
  renderSiteRecommendations('sites-recommend-grid', 'sites-recommend-more', domains);
  const list = document.getElementById('domain-list');
  list.innerHTML = '';
  if (!domains.length) {
    renderEmptyList(list, 'No websites blocked yet. Tap "+ Add website" — it suggests a few.');
    return;
  }
  const rerender = async () => {
    const state = await getConfig();
    renderDomains(state.blockedDomains || [], state.domainLimits || {}, state.blockingMode, state.serviceReasons || {});
  };
  for (const d of domains) {
    const limitInfo = limits[d] || { maxGrants: 3, maxMinutes: 10 };

    const { li, fields } = buildBlockedRow({
      target: d,
      label: d,
      headExtra: buildRowModeToggle(d, d, limitInfo, globalMode, 'domainLimits', rerender),
      onRemove: () => removeDomain(d, effectiveModeFor(limitInfo, globalMode) === 'simple')
    });

    buildRowBody({
      li, fields, target: d, label: d, limitInfo, globalMode,
      kind: ROW_KINDS.domain, serviceReasons, rerender
    });
    list.appendChild(li);
  }
}
