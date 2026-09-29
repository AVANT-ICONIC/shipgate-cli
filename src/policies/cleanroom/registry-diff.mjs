// SPDX-License-Identifier: AGPL-3.0-or-later
// Is this registry edit a DECLARATION, or an ARCHITECTURE CHANGE?
//
// WHY THIS EXISTS. `policy/registry-changed` fires on any byte-level difference
// in the canonical registry against the base branch. That is the right answer
// for an edit that rewrites what a responsibility owns, and the wrong answer for
// the only way the registry ever gets populated: adding a responsibility that
// did not exist.
//
// MEASURED 2026-09-17 in apex-nexus: the registry is
// `{"version":1,"responsibilities":{},"components":{}}` -- empty -- and 532
// files need declaring. Declaring them is roughly 34 pull requests. Under the
// byte rule every one of those is a governance PR needing
// GREENROOM_ALLOW_GOVERNANCE_UPDATE=1, and that flag switches off the policy,
// waiver, registry AND generated guards together. The rule as written pushes a
// project towards turning all four off for routine work, which is the opposite
// of what it is for.
//
// WHY ADDING IS SAFE TO WAVE THROUGH, AND CHANGING IS NOT. A new entry is not
// taken on trust. `analyzeRegistry` already judges it on its merits in the same
// run: `registry/duplicate-responsibility` rejects a second concept claiming a
// canonical path that is already spoken for, `registry/missing-canonical`
// rejects a canonical path that does not exist on disk, and
// `registry/noncanonical-component` rejects leaving a peer beside the canonical
// file. An addition therefore cannot quietly take ownership of anything, and
// cannot point at nothing. Those checks say nothing about an entry that was
// ALREADY there, so editing or deleting one stays exactly as blocked as before.
//
// This never opens a hole in the other three governance guards. It classifies
// one file, and only the registry.

function parse(text) {
  if (typeof text !== 'string' || text.trim() === '') return null;
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return value;
  } catch { return null; }
}

function section(registry, key) {
  const value = registry[key];
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((k) => [k, stable(value[k])]));
  }
  return value;
}

const same = (a, b) => JSON.stringify(stable(a)) === JSON.stringify(stable(b));

/** Every top-level key that is not a bag of entries. Changing one is a mutation. */
function scalarKeys(registry) {
  return Object.keys(registry).filter((k) => k !== 'responsibilities' && k !== 'components');
}

/**
 * Classify a registry edit.
 *
 * Returns `kind`:
 *   'same'       identical, nothing to judge
 *   'additive'   entries were added; every entry that already existed is byte
 *                for byte what it was, and no other field moved
 *   'mutating'   an existing entry changed or was removed, or a top-level field
 *                outside the two entry bags moved
 *   'unreadable' either side is missing or is not a registry object
 *
 * 'unreadable' is its own answer and never collapses into 'additive'. A file we
 * cannot read is not a file we have judged, and the caller fails closed on it.
 */
export function classifyRegistryDiff(previousText, currentText) {
  const previous = parse(previousText);
  const current = parse(currentText);
  if (!previous || !current) {
    return { kind: 'unreadable', added: [], changed: [], removed: [] };
  }

  const added = [];
  const changed = [];
  const removed = [];

  for (const key of ['responsibilities', 'components']) {
    const before = section(previous, key);
    const after = section(current, key);
    for (const name of Object.keys(before)) {
      if (!(name in after)) removed.push(`${key}.${name}`);
      else if (!same(before[name], after[name])) changed.push(`${key}.${name}`);
    }
    for (const name of Object.keys(after)) {
      if (!(name in before)) added.push(`${key}.${name}`);
    }
  }

  // A top-level field outside the two entry bags is policy, not a declaration.
  // `version` going 1 -> 2 changes how every entry is read.
  const beforeKeys = scalarKeys(previous);
  const afterKeys = scalarKeys(current);
  const scalarMoved = beforeKeys.length !== afterKeys.length
    || beforeKeys.some((k) => !afterKeys.includes(k) || !same(previous[k], current[k]));
  if (scalarMoved) changed.push('(top-level)');

  if (changed.length || removed.length) return { kind: 'mutating', added, changed, removed };
  if (added.length) return { kind: 'additive', added, changed, removed };
  return { kind: 'same', added, changed, removed };
}
