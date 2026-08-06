// Guard for the setup wizard's weakest seam: options.js reaches into
// options.html purely by string id, so a section that gets renamed or dropped
// in the markup fails at runtime, not at load. That is exactly how the wizard
// broke once before — options.js kept driving a `setup-step-provider` section
// that the markup no longer had, and reading a control off it threw before the
// first step was ever shown, leaving a first-run user staring at whichever
// section happened not to carry `hidden`.

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { VARIANTS } from './load.js';

const read = (variant, file) => fs.readFileSync(path.join(VARIANTS[variant], file), 'utf8');

const html = read('chrome', 'options.html');
const js = read('chrome', 'options.js');

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
