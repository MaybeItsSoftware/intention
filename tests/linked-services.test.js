// Android shares a pass between a site and its app (LinkedServices.kt), using
// a copy of APP_ICON_SITE because the accessibility service reads passes
// natively, with no WebView round trip. This keeps the copy honest: a pairing
// added to sites.js and not to Kotlin would quietly gate a link twice again.

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadSource, REPO_ROOT } from './load.js';

let S;
beforeAll(() => {
  S = loadSource('sites.js');
});

describe('LinkedServices.kt mirrors APP_ICON_SITE', () => {
  it('has exactly the same app → site pairs', () => {
    const kotlin = readFileSync(join(REPO_ROOT, 'Intention Android', 'app', 'src', 'main', 'java',
      'uk', 'co', 'maybeitssoftware', 'intention', 'LinkedServices.kt'), 'utf8');
    const pairs = Object.fromEntries(
      [...kotlin.matchAll(/"([^"]+)"\s+to\s+"([^"]+)"/g)].map(m => [m[1], m[2]])
    );
    expect(pairs).toEqual({ ...S.APP_ICON_SITE });
  });
});
