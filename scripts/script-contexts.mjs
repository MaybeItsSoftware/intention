// Which shared script files load into which runtime context — read out of the
// manifests and pages that actually ship, never restated by hand.
//
// The extension has no bundler. Four separate global scopes (the background
// worker, the content script, the options page and the coaching page) each
// load some subset of shared/, and a file may only call what its own context
// loaded. That subsetting is real and load-bearing: it is why the target-rule
// resolution was copied into three files instead of shared.
//
// It used to be written out in three more places — the ESLint globals, the vm
// bundles in tests/load.js, and the CI file check — each free to fall behind
// the manifest. This module is the one reader. Adding a script to the manifest
// now lints it, tests it and ships it without touching anything else.

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

// Every test source, from a source directory's repo root. Absent (a generated
// variant directory consulted on its own) simply contributes nothing.
function testFiles(dir) {
  const root = dirname(dir);
  const out = [];
  for (const sub of ['tests', join('tests', 'smoke')]) {
    const path = join(root, sub);
    if (!existsSync(path)) continue;
    for (const f of readdirSync(path)) {
      if (f.endsWith('.js') || f.endsWith('.mjs')) out.push(join(path, f));
    }
  }
  return out;
}

// A source directory is either `shared/` (manifest.base.json plus per-platform
// overlays) or a generated variant directory (one merged manifest.json).
function manifests(dir) {
  if (existsSync(join(dir, 'manifest.json'))) {
    const merged = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
    return { base: merged, firefox: merged };
  }
  return {
    base: JSON.parse(readFileSync(join(dir, 'manifest.base.json'), 'utf8')),
    firefox: JSON.parse(readFileSync(join(dir, 'manifest.firefox.json'), 'utf8'))
  };
}

function scriptTags(dir, page) {
  const html = readFileSync(join(dir, page), 'utf8');
  return [...html.matchAll(/<script\s+src="([^"]+)"/g)].map(m => m[1]);
}

// { contextName: [file, ...] } for one source directory.
//
// Chrome's manifest names only `service_worker`, leaving background.js to pull
// its own dependencies in with importScripts(); Firefox and Apple spell the
// whole list out and it is the same set, so the Firefox background list is
// what gets read.
export function scriptContexts(dir) {
  const { base, firefox } = manifests(dir);
  return {
    content: base.content_scripts[0].js.slice(),
    background: firefox.background.scripts.slice(),
    options: scriptTags(dir, 'options.html'),
    coaching: scriptTags(dir, 'coaching.html')
  };
}

// Top-level (column-0) const/let/var/function/class declaration names. These
// are exactly the names a classic script publishes to the scripts loaded
// alongside it. Conservative on purpose: only declarations starting at the
// beginning of a line, so nothing nested is mistaken for a shared global.
export function topLevelDeclaredNames(code) {
  const names = new Set();
  const re = /^(?:const|let|var|function|async function|class)\s+([A-Za-z_$][\w$]*)/gm;
  let m;
  while ((m = re.exec(code)) !== null) names.add(m[1]);
  return [...names];
}

// Comments are stripped before any name is looked for. This codebase explains
// itself at length and names functions while doing it, so a comment mentioning
// resolveBlockConfig() must not count as a reference to it.
function stripComments(code) {
  return code.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
}

// For each file in `dir`:
//   globals — the names its context-mates declare, i.e. every identifier it may
//             legitimately reference without declaring it itself;
//   used    — the names IT declares that a context-mate references back.
//
// A file loaded into more than one context (providers.js, report.js) gets the
// union, which is the honest answer: it has to work in all of them.
//
// `used` is what makes an unused-variable check possible at all here. Every
// shared file's public surface is "top-level declaration a sibling script
// picks up off the global scope", which no linter can infer on its own — so
// without this, every exported function reads as dead. With it, a top-level
// name that no sibling references and the file itself never uses is genuinely
// dead code.
export function crossFileGlobals(dir) {
  const contexts = scriptContexts(dir);
  const cache = new Map();
  const read = (file) => {
    if (!cache.has(file)) {
      const code = readFileSync(join(dir, file), 'utf8');
      cache.set(file, { declared: topLevelDeclaredNames(code), body: stripComments(code) });
    }
    return cache.get(file);
  };

  // References that live outside the script files: inline handlers in the
  // pages (onclick="save()"), and the test suite — the smoke tests drive the
  // wizard by calling showSetupStep() and friends inside page.evaluate(), and
  // those are seams somebody would otherwise delete as dead.
  //
  // So "used" here means referenced anywhere in the repo, not referenced in
  // production. That is the weaker of the two questions, and deliberately so:
  // the stronger one cannot be answered without judgement about which callers
  // count, and a check that needs judgement gets disabled rather than heeded.
  const external = [
    ...['options.html', 'coaching.html'].map(p => join(dir, p)),
    ...testFiles(dir)
  ].map(p => stripComments(readFileSync(p, 'utf8'))).join('\n');

  const byFile = new Map();
  for (const files of Object.values(contexts)) {
    for (const file of files) {
      const entry = byFile.get(file) || { globals: new Set(), used: new Set() };
      const mine = read(file).declared;
      for (const sibling of files) {
        if (sibling === file) continue;
        const other = read(sibling);
        for (const name of other.declared) entry.globals.add(name);
        for (const name of mine) {
          if (new RegExp(`\\b${name}\\b`).test(other.body)) entry.used.add(name);
        }
      }
      for (const name of mine) {
        if (new RegExp(`\\b${name}\\b`).test(external)) entry.used.add(name);
      }
      byFile.set(file, entry);
    }
  }
  return byFile;
}
