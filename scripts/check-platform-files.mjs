#!/usr/bin/env node
//
// Every file the manifests and pages actually load is present, in every
// platform directory.
//
// This replaced a hand-written REQUIRED_FILES list in ci.yml: it named
// thirteen files, was already missing three that ship (rules.js, sites.js,
// page_context.js), and checked only Chrome and Firefox. A list nobody
// remembers to extend passes whatever it is pointed at.

import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scriptContexts } from './script-contexts.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Android keeps its own background.html and android-bridge.js instead of a
// manifest, but loads the same shared files, so the same list applies.
const PLATFORMS = [
  'Intention Chrome',
  'Intention Firefox',
  join('Intention Apple', 'Shared (Extension)', 'Resources'),
  join('Intention Android', 'app', 'src', 'main', 'assets')
];

// Non-script files every platform copy needs. The scripts themselves come out
// of the manifests below.
const ASSETS = ['options.html', 'coaching.html', 'content.css', 'options.css', 'tokens.css', 'paywall.css'];

const contexts = scriptContexts(join(ROOT, 'shared'));
const required = [...new Set([...Object.values(contexts).flat(), ...ASSETS])].sort();

let failed = false;
for (const platform of PLATFORMS) {
  const dir = join(ROOT, platform);
  if (!existsSync(dir)) {
    console.log(`- ${platform}/ absent, skipping`);
    continue;
  }
  const missing = required.filter(f => !existsSync(join(dir, f)));
  if (missing.length) {
    failed = true;
    console.error(`✗ ${platform}/ is missing ${missing.length}:`);
    for (const f of missing) console.error(`    ${f}`);
  } else {
    console.log(`✓ ${platform}/ has all ${required.length}`);
  }
}

if (failed) {
  console.error('\n  Run scripts/sync.sh to propagate shared/ to every platform.');
  process.exit(1);
}
