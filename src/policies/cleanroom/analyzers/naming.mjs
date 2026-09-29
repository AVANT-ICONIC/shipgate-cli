// SPDX-License-Identifier: AGPL-3.0-or-later
import path from 'node:path';
import { matchesAnyPattern } from '../lib/fs.mjs';
import { violation } from '../violations.mjs';

// The words that mark a file as a version of another file.
const MARKER = /(?:^|[-_.])(fix(?:ed)?|final|new|old|backup|copy|temp|tmp|v\d+)(?=[-_.]|$)/gi;
const TRAILING_MARKER = /[-_.](fix(?:ed)?|final|new|old|backup|copy|temp|tmp|v\d+)$/i;

// A SERIAL NUMBER IS NOT A NAME.
//
// `agentube-1.mjs`, `hive-3.mjs`, `game-foundry-5.mjs`: a shared prefix and an
// index. The digit says which piece of an extraction this was, which is a fact
// about how the code arrived and not about what it does.
//
// MEASURED 2026-09-17 in apex-nexus: 53 such files, 16% of a flat source
// directory, and 47 of the 53 carried no header comment either. Every one was
// imported by exactly one well-named module under a proper symbol name --
// `dunetrace-1.mjs` was always `ToolOscillationAnalyzer` inside. The name of a
// file is the cheapest documentation there is and these spent it on nothing.
//
// A LONE trailing number is not enough evidence. `sha-256`, `base-64`, `h-264`
// and `utf-8` are names, and a rule that convicts them is the word-search
// mistake one more time. What makes an index an index is a SIBLING carrying the
// same prefix and a different number. That is the same counterpart test the
// leading-marker rule uses, and on the apex tree it catches 40 of the 46
// without a single false positive.
const TRAILING_INDEX = /^(.+)[-_.](\d{1,3})$/;

/** The basename without its last extension: `vault-backup.test.mjs` -> `vault-backup.test`. */
function stemOf(base) {
  const ext = path.extname(base);
  return ext ? base.slice(0, -ext.length) : base;
}

/**
 * The names this file would have if one of its version markers were dropped.
 *
 * `copy-of-utils.js` -> `of-utils`. A name can carry more than one marker, so
 * every position is offered.
 */
function namesWithoutAMarker(stem) {
  const out = [];
  for (const m of stem.matchAll(MARKER)) {
    const candidate = m.index === 0
      ? stem.slice(m[0].length).replace(/^[-_.]/, '')
      : stem.slice(0, m.index) + stem.slice(m.index + m[0].length);
    if (candidate) out.push(candidate);
  }
  return out;
}

/**
 * Files whose name marks them as a version of another file.
 *
 * WHY POSITION MATTERS. The rule used to convict any name containing one of
 * those words anywhere in it, which is a word search over prose. They are
 * ordinary English words, and a repository that names things in sentences uses
 * them constantly.
 *
 * MEASURED 2026-09-17 in apex-nexus: 16 findings, 15 of them sentence-shaped
 * test names -- `the-new-ui-chat-sends-a-message.test.mjs`,
 * `a-worker-must-be-able-to-pick-up-its-own-fix.test.mjs`,
 * `vault-backup.test.mjs`, which tests the vault's backup. Not one named a
 * version of anything. The sixteenth, `scripts/temp-run-root.mjs`, is the file
 * that owns the temporary run root; `temp` is its subject, not its status.
 *
 * A version marker is a SUFFIX. `utils-v2.js`, `auth-fixed.ts`,
 * `config.old.json`: the base name says what the file is and the last segment
 * says which copy of it this is. That is the whole first rule, and it is why
 * `vault-backup.test.mjs` is quiet -- its last segment is `test`.
 *
 * The second rule covers the other real form, a marker at the front, as in
 * `copy-of-utils.js`. On its own a leading word is no more evidence than a
 * middle one, so that form is reported only when the file it claims to be a
 * copy of is sitting in the same directory. `scripts/temp-run-root.mjs` is
 * quiet because there is no `scripts/run-root.mjs`.
 */
export function analyzeNaming(files, config) {
  if (!config.rules.suspiciousFilenames) return [];
  const stemsByDir = new Map();
  for (const f of files) {
    const dir = path.posix.dirname(f.rel);
    if (!stemsByDir.has(dir)) stemsByDir.set(dir, new Map());
    stemsByDir.get(dir).set(stemOf(path.posix.basename(f.rel)), f.rel);
  }

  const out = [];
  for (const f of files) {
    if (matchesAnyPattern(f.rel, config.naming?.allow || [])) continue;
    const base = path.posix.basename(f.rel);
    const stem = stemOf(base);

    const siblings = stemsByDir.get(path.posix.dirname(f.rel)) || new Map();
    let counterpart = null;
    for (const candidate of namesWithoutAMarker(stem)) {
      const hit = siblings.get(candidate);
      if (hit && hit !== f.rel) { counterpart = hit; break; }
    }

    // A numbered sibling is what turns a trailing digit into a serial index.
    const indexed = TRAILING_INDEX.exec(stem);
    let numberedSibling = null;
    if (indexed) {
      const [, prefix, digits] = indexed;
      for (const [otherStem, otherRel] of siblings) {
        if (otherRel === f.rel) continue;
        const other = TRAILING_INDEX.exec(otherStem);
        if (other && other[1] === prefix && other[2] !== digits) { numberedSibling = otherRel; break; }
      }
    }

    if (numberedSibling) {
      out.push(violation(
        'naming/suspicious',
        [f.rel, numberedSibling],
        `Serial-numbered filename: ${f.rel} sits beside ${numberedSibling}. The digit is an index, not a name.`,
        base
      ));
      continue;
    }

    if (!TRAILING_MARKER.test(stem) && !counterpart) continue;
    out.push(violation(
      'naming/suspicious',
      counterpart ? [f.rel, counterpart] : [f.rel],
      counterpart
        ? `Suspicious version/fix filename: ${f.rel} sits beside ${counterpart}`
        : `Suspicious version/fix filename: ${f.rel}`,
      base
    ));
  }
  return out;
}
