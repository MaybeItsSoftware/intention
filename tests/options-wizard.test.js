// Guard for the setup wizard's weakest seam: the settings page reaches into
// options.html purely by string id, so a section that gets renamed or dropped
// in the markup fails at runtime, not at load. That is exactly how the wizard
// broke once before — the script kept driving a `setup-step-provider` section
// that the markup no longer had, and reading a control off it threw before the
// first step was ever shown, leaving a first-run user staring at whichever
// section happened not to carry `hidden`.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { VARIANTS, bundleForContext } from './load.js';

const read = (variant, file) => fs.readFileSync(path.join(VARIANTS[variant], file), 'utf8');

const html = read('chrome', 'options.html');
// Every script the page loads, not just options.js: the ids are looked up from
// whichever of them owns that part of the UI, and a check that reads one file
// silently stops covering the rest the moment the page grows a second.
const js = bundleForContext('options');
const css = read('chrome', 'options.css');

const htmlIds = new Set([...html.matchAll(/id="([^"]+)"/g)].map(m => m[1]));

describe('setup wizard markup and script agree', () => {
  it('every id options.js looks up exists in options.html', () => {
    const missing = [...new Set([...js.matchAll(/getElementById\('([^']+)'\)/g)].map(m => m[1]))]
      .filter(id => !htmlIds.has(id));
    expect(missing).toEqual([]);
  });

  it('every step the wizard can order is a real section', () => {
    const ordered = [...new Set([...js.matchAll(/'(setup-step-[a-z-]+)'/g)].map(m => m[1]))];
    expect(ordered.length).toBeGreaterThan(0);
    expect(ordered.filter(id => !htmlIds.has(id))).toEqual([]);
  });

  it('every step section can be reached by the wizard', () => {
    const sections = [...html.matchAll(/id="(setup-step-[a-z-]+)"/g)].map(m => m[1]);
    const ordered = new Set([...js.matchAll(/'(setup-step-[a-z-]+)'/g)].map(m => m[1]));
    expect(sections.filter(id => !ordered.has(id))).toEqual([]);
  });

  it('no step section is left visible for the wizard to fall back onto', () => {
    // showStep() decides what is on screen. A section that ships without
    // `hidden` shows through before it runs, and stays up if it ever throws.
    const unhidden = [...html.matchAll(/<section class="card setup-step" id="([^"]+)"(?![^>]*hidden)/g)]
      .map(m => m[1]);
    expect(unhidden).toEqual([]);
  });
});

// The section tabs left a visibly different gap beneath them depending on
// which tab was selected. Not the tabs — the grid: its children were two
// column wrappers, and the one holding none of the selected section's cards
// collapsed to a zero-height grid item that still took a full 16px gutter.
// A card hidden with `display: none` is not a grid item at all, so a FLAT
// grid gives every tab the same gap by construction.
describe('the settings grid stays a flat list of sections', () => {
  // The grid is the last thing inside #settings-view's <main>, so its own
  // closing tag is the one immediately before </main>.
  const gridAt = html.indexOf('<div class="settings-grid">');
  const grid = html.slice(gridAt, html.indexOf('\n    </main>', gridAt));

  it('has no column wrappers left to collapse', () => {
    expect(html).not.toContain('settings-column');
    expect(css).not.toContain('settings-column');
  });

  // Every direct child (8-space indent, inside a 6-space grid) must be
  // section-owned. One that isn't would render on every tab — and, worse,
  // render an empty box plus its gutter on the tabs it has nothing for.
  it('every direct child of the grid belongs to exactly one section', () => {
    const children = [...grid.matchAll(/^ {8}<(?:section|details|div|ul)\b([^>]*)>/gm)].map(m => m[1]);
    expect(children.length).toBeGreaterThan(8);
    expect(children.filter(attrs => !/\bdata-section="/.test(attrs))).toEqual([]);
  });

  it('keeps the tab labels optically centred against their own tracking', () => {
    // 0.12em of tracking is painted after the last glyph as well; the indent
    // cancels it. They have to stay equal — see the rule's comment.
    const rule = css.slice(css.indexOf('.section-tabs .tab-btn {'));
    expect(rule).toMatch(/letter-spacing: 0\.12em;/);
    expect(rule).toMatch(/text-indent: 0\.12em;/);
  });
});

// The suggestion chips belong to the act of adding, not to the list of things
// already added — and inside the dialog they finally have a minutes field to
// read. The wizard keeps its own inline grids, which share the builders.
describe('the suggestion chips live in the add dialogs', () => {
  const block = (id) => {
    const start = html.indexOf(`<div id="${id}"`);
    return html.slice(start, html.indexOf('\n    </div>', start));
  };

  it('the site chips are in the Add-website dialog, not the Blocked sites card', () => {
    expect(block('add-site-modal')).toContain('id="sites-recommend-grid"');
    expect(block('add-site-modal')).toContain('id="sites-recommend-more"');
    expect(block('websites-card')).not.toContain('recommend');
  });

  it('the app chips are in the Add-app dialog, not the Blocked apps card', () => {
    expect(block('add-app-modal')).toContain('id="apps-recommend-grid"');
    expect(block('add-app-modal')).toContain('id="apps-recommend-more"');
    expect(block('apps-card')).not.toContain('recommend');
  });

  it("the wizard's own grids are untouched", () => {
    for (const id of ['setup-sites-recommend-grid', 'setup-sites-recommend-more',
                      'setup-apps-recommend-grid', 'setup-apps-recommend-more']) {
      expect(htmlIds.has(id), id).toBe(true);
    }
  });

  // Every route out has to exist, or the dialog is a trap on a phone where
  // there is no visible page behind the scrim to aim at.
  it('the dialogs can be dismissed three ways and trap focus', () => {
    expect(js).toContain('function wireModalDismissal');
    expect(js).toContain("wireModalDismissal('add-site-modal'");
    expect(js).toContain("wireModalDismissal('add-app-modal'");
    expect(js).toMatch(/e\.key === 'Escape'/);
    expect(js).toMatch(/e\.key !== 'Tab'/);
  });
});
