// SPDX-License-Identifier: AGPL-3.0-or-later
export function groupByRule(violations) {
  const map = new Map();
  for (const v of violations) {
    if (!map.has(v.rule)) map.set(v.rule, []);
    map.get(v.rule).push(v);
  }
  return map;
}

export function auditText(result, { waived = [], expired = [] } = {}) {
  const lines = [];
  lines.push('GREEN ROOM AUDIT');
  lines.push('='.repeat(64));
  lines.push(`Source files scanned : ${result.files}`);
  lines.push(`Violations           : ${result.violations.length}`);
  lines.push(`Entropy score        : ${result.entropy}`);
  if (result.findings) lines.push(`Evidence findings    : ${result.findings.length}`);
  if (result.providers?.length) {
    const active = result.providers.map((p) => `${p.provider}:${p.status}(${p.findings || 0})`).join(', ');
    lines.push(`Evidence providers   : ${active}`);
  }
  if (waived.length) lines.push(`Active waivers       : ${waived.length}`);
  if (expired.length) lines.push(`Expired waivers      : ${expired.length}`);
  lines.push('');
  const groups = groupByRule(result.violations);
  if (!groups.size) lines.push('✓ Clean. No configured violations found.');
  for (const [rule, items] of groups) {
    lines.push(`${rule} (${items.length})`);
    for (const item of items.slice(0, 12)) lines.push(`  - [${item.id}] ${item.message}`);
    if (items.length > 12) lines.push(`  … ${items.length - 12} more`);
    lines.push('');
  }
  const evidenceOnly = (result.findings || []).filter((f) => !String(f.id).startsWith('v-'));
  if (evidenceOnly.length) {
    lines.push('EVIDENCE / REVIEW CANDIDATES');
    for (const item of evidenceOnly.slice(0, 16)) lines.push(`  - [${item.confidence}] ${item.kind}: ${item.message} [${item.id}]`);
    if (evidenceOnly.length > 16) lines.push(`  … ${evidenceOnly.length - 16} more`);
    lines.push('');
  }
  if (waived.length) {
    lines.push('WAIVED');
    for (const item of waived.slice(0, 12)) lines.push(`  - [${item.violation.id}] ${item.violation.message} — ${item.waiver.reason}`);
    if (waived.length > 12) lines.push(`  … ${waived.length - 12} more`);
    lines.push('');
  }
  return lines.join('\n');
}

// A duplication violation's id is a hash of the block's CONTENT. Edit a line
// anywhere near duplication that is already baselined and the id changes, so
// the ratchet reports accepted debt as brand new entropy.
//
// MEASURED 2026-09-17 on a 1810-file repository: cleanup took it from 206
// violations to 130, and the gate then blocked every pull request with 11 "new"
// violations. All 11 were file pairs the baseline already contained, re-hashed
// because the cleanup had edited the surrounding lines. A repository is not
// supposed to block itself for getting cleaner.
//
// So duplication is matched by FILE SET as well as by id, and by count: the
// baseline grants each file set as many slots as it recorded, an exact id match
// or a re-hashed block consumes one, and anything beyond that is still new.
// Adding a SECOND duplicated block between the same two files therefore still
// blocks, which is the property that matters.
const RE_HASHABLE_RULES = new Set(['duplication/block', 'duplication/file']);

function fileSetKey(violation) {
  return `${violation.rule}|${violation.paths.join('|')}`;
}

// A RENAME IS NOT A NEW DUPLICATE.
//
// Matching by file set fixed the case where cleanup edits the lines AROUND a
// duplicated block. It cannot survive the block's file being MOVED or RENAMED,
// because the paths are the key: the old key keeps a slot nobody claims and is
// counted resolved, and the new key has no slot and is counted fresh. The
// repository blocks itself for tidying a folder, which is the same failure one
// step further along.
//
// MEASURED 2026-09-17 in apex-nexus: moving ten behaviour modules into
// packages/runtime/src/behavior/ and naming them after what they hold produced
// "Resolved 6 / NEW 6" -- the same six blocks, byte for byte, in renamed files.
//
// A duplicated block is identified by its CONTENT, which `duplicates.mjs`
// already writes as the first field of the detail, and by HOW MANY files carry
// it. Paths are where it happens to live. So:
//
//   same content, same count, different paths  -> a rename. One slot, matched.
//   same content, one more file                -> it spread. New key, blocks.
//   same content, one FEWER file               -> it shrank. One slot, matched.
//   different content, same two files          -> a second block. New key, blocks.
//
// The shrink case was the gap. A consolidation that takes one file out of a
// cluster of six leaves the same block in five, which is a different count and
// therefore a different key: the six-file entry reads as resolved and the
// five-file entry reads as NEW. The repository blocks itself for removing a
// duplicate, which is the one move the rule exists to encourage.
//
// MEASURED 2026-09-18 in apex-nexus: PR #840 routed council.js through a
// shared fetch helper, taking it out of a six-file block shared with
// complimentary-reviewers, retained-widgets, space-widgets, whiteboard and
// work-requests. Total violations fell 91 -> 90 and the check reported
// "Resolved 2 / NEW 1", blocking the PR that did the cleanup.
//
// A shrink consumes the larger slot rather than counting as resolved, for the
// same reason a rename does: the duplication is still there, in fewer files.
// Claiming it resolved would take credit for work that has not finished.
//
// Both properties #760 protected are kept, and renaming is no longer entropy.
//
// duplication/file stays keyed by file set: its detail is the constant
// `exact-normalized-file` with no content hash, so there is nothing else to key
// on. Changing that detail would change the id of every existing
// duplication/file violation and invalidate every baseline in the wild. A
// renamed duplicate FILE pair therefore still re-hashes, and that is a known
// gap rather than a silent one.
const BLOCK_CONTENT_HASH = /^([0-9a-f]{6,})\b/;

function reHashKey(violation) {
  if (violation.rule === 'duplication/block') {
    const hash = BLOCK_CONTENT_HASH.exec(String(violation.detail ?? ''))?.[1];
    // No hash means a baseline written before the detail carried one. Fall back
    // rather than invent a key: an unreadable identity is not a match.
    if (hash) return `${violation.rule}|content:${hash}|files:${violation.paths.length}`;
  }
  return fileSetKey(violation);
}

// The reference slot for the SAME block carried by MORE files. The smallest
// such count is taken, so a cluster that shrank from six to five consumes the
// six-file slot and not a ten-file one that is still its own finding.
function smallestLargerSlot(slots, violation) {
  const hash = BLOCK_CONTENT_HASH.exec(String(violation.detail ?? ''))?.[1];
  if (!hash) return null;
  const prefix = `${violation.rule}|content:${hash}|files:`;
  let best = null;
  let bestCount = Infinity;
  for (const [key, remaining] of slots) {
    if (remaining <= 0 || !key.startsWith(prefix)) continue;
    const count = Number(key.slice(prefix.length));
    if (!Number.isFinite(count) || count <= violation.paths.length) continue;
    if (count < bestCount) { bestCount = count; best = key; }
  }
  return best;
}

// The same choice made against the reference list rather than the live slot
// map, so the absorbed tally lands on the entry the shrink actually consumed.
function smallestLargerSlotKeyFor(reference, violation) {
  const hash = BLOCK_CONTENT_HASH.exec(String(violation.detail ?? ''))?.[1];
  if (!hash) return null;
  let best = null;
  let bestCount = Infinity;
  for (const r of reference) {
    if (r.rule !== 'duplication/block') continue;
    const rHash = BLOCK_CONTENT_HASH.exec(String(r.detail ?? ''))?.[1];
    if (rHash !== hash) continue;
    if (r.paths.length <= violation.paths.length) continue;
    if (r.paths.length < bestCount) { bestCount = r.paths.length; best = reHashKey(r); }
  }
  return best;
}

export function ratchet(currentViolations, referenceViolations) {
  const reference = referenceViolations || [];
  const allowedIds = new Set(reference.map((v) => v.id));
  const currentIds = new Set(currentViolations.map((v) => v.id));

  const slots = new Map();
  for (const v of reference) {
    if (!RE_HASHABLE_RULES.has(v.rule)) continue;
    slots.set(reHashKey(v), (slots.get(reHashKey(v)) || 0) + 1);
  }

  // Exact matches first, so a re-hashed block can never consume the slot that
  // an unchanged one still needs.
  const unmatched = [];
  for (const v of currentViolations) {
    if (allowedIds.has(v.id)) {
      if (RE_HASHABLE_RULES.has(v.rule)) {
        const key = reHashKey(v);
        slots.set(key, Math.max(0, (slots.get(key) || 0) - 1));
      }
      continue;
    }
    unmatched.push(v);
  }

  const fresh = [];
  const rehashed = [];
  const shrunk = [];
  for (const v of unmatched) {
    const key = reHashKey(v);
    const remaining = RE_HASHABLE_RULES.has(v.rule) ? (slots.get(key) || 0) : 0;
    if (remaining > 0) {
      slots.set(key, remaining - 1);
      rehashed.push(v);
      continue;
    }
    // An exact count match is preferred above, so a shrink can never take the
    // slot an unchanged cluster still needs. Only what is left over gets here.
    if (v.rule === 'duplication/block') {
      const slot = smallestLargerSlot(slots, v);
      if (slot) {
        slots.set(slot, slots.get(slot) - 1);
        rehashed.push(v);
        shrunk.push(v);
        continue;
      }
    }
    fresh.push(v);
  }

  // A baselined violation whose slot was taken by a re-hashed block is still
  // present, just under a different id. Counting it as resolved would claim
  // credit for cleanup that did not happen.
  const absorbed = new Map();
  const shrunkSet = new Set(shrunk);
  for (const v of rehashed) {
    // A shrunk cluster consumed a LARGER reference slot, so it must be counted
    // against that slot's key. Counting it against its own would leave the
    // six-file reference entry looking resolved while the block is still there.
    const key = shrunkSet.has(v)
      ? (smallestLargerSlotKeyFor(reference, v) ?? reHashKey(v))
      : reHashKey(v);
    absorbed.set(key, (absorbed.get(key) || 0) + 1);
  }

  const resolved = [];
  for (const v of reference) {
    if (currentIds.has(v.id)) continue;
    const key = reHashKey(v);
    if (RE_HASHABLE_RULES.has(v.rule) && (absorbed.get(key) || 0) > 0) {
      absorbed.set(key, absorbed.get(key) - 1);
      continue;
    }
    resolved.push(v);
  }

  return { fresh, resolved, rehashed };
}

export function checkText(current, reference, { referenceLabel = 'baseline', waived = [] } = {}) {
  const { fresh, resolved, rehashed } = ratchet(current.violations, reference?.violations);
  const lines = ['GREEN ROOM CHECK', '='.repeat(64)];
  lines.push(`Reference            : ${referenceLabel}`);
  lines.push(`Reference violations : ${reference?.violations?.length ?? 0}`);
  lines.push(`Current violations   : ${current.violations.length}`);
  lines.push(`Resolved             : ${resolved.length}`);
  if (rehashed.length) lines.push(`Re-hashed (same files): ${rehashed.length}`);
  lines.push(`Waived               : ${waived.length}`);
  lines.push(`NEW violations       : ${fresh.length}`);
  lines.push('');
  if (!fresh.length) lines.push('✓ PASS — no new entropy introduced.');
  else {
    lines.push('✗ BLOCKED — new entropy introduced:');
    for (const v of fresh) lines.push(`  - ${v.rule}: ${v.message} [${v.id}]`);
  }
  return { text: lines.join('\n'), fresh, resolved, rehashed };
}
