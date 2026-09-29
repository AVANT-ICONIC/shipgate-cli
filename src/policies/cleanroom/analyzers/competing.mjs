// SPDX-License-Identifier: AGPL-3.0-or-later
import path from 'node:path';
import { finding } from '../evidence.mjs';
import { violation } from '../violations.mjs';

const NOISE = new Set(['fix','fixed','repair','repaired','normalize','normalise','new','old','backup','copy','temp','tmp','final','v2','v3','v4','v5','script']);
const SUSPICIOUS = /(?:^|[-_.])(fix(?:ed)?|repair(?:ed)?|final|new|old|backup|copy|temp|tmp|v\d+)(?:[-_.]|$)/i;
const STYLE_EXTS = new Set(['.css','.scss','.sass','.less']);

function tokens(rel) {
  return path.basename(rel, path.extname(rel)).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).filter((x) => !NOISE.has(x) && !/^v\d+$/.test(x));
}
function signature(rel) { return [...new Set(tokens(rel))].sort().join('-'); }
function similarity(a, b) {
  const A = new Set(tokens(a));
  const B = new Set(tokens(b));
  const shared = [...A].filter((x) => B.has(x)).length;
  const union = new Set([...A, ...B]).size || 1;
  return { shared, score: shared / union };
}
function find(parent, x) {
  if (parent.get(x) !== x) parent.set(x, find(parent, parent.get(x)));
  return parent.get(x);
}
function union(parent, a, b) {
  const A = find(parent, a);
  const B = find(parent, b);
  if (A !== B) parent.set(B, A);
}
function key(a, b) { return [a, b].sort().join('|'); }

/**
 * Detect likely competing implementations without turning a 4k-file repo into
 * an O(n²) space heater. Exact responsibility signatures are bucketed in O(n).
 * Fuzzy comparison is deliberately limited to suspicious legacy/fix-style peers
 * inside the same directory.
 */
export function analyzeCompetingResponsibilities(files, config) {
  if (!config.rules.competingResponsibilities) return { violations: [], findings: [] };

  const code = files.filter((f) => !STYLE_EXTS.has(f.ext));
  const parent = new Map(code.map((f) => [f.rel, f.rel]));
  const reasons = new Map();
  const sigBuckets = new Map();
  const dirBuckets = new Map();

  for (const file of code) {
    const sig = signature(file.rel);
    if (sig) {
      if (!sigBuckets.has(sig)) sigBuckets.set(sig, []);
      sigBuckets.get(sig).push(file.rel);
    }
    const dir = path.posix.dirname(file.rel);
    if (!dirBuckets.has(dir)) dirBuckets.set(dir, []);
    dirBuckets.get(dir).push(file.rel);
  }

  // Exact normalized responsibility signatures. This catches e.g.
  // provider-state.ts + fix-provider-state.ts without comparing every file pair.
  for (const [sig, paths] of sigBuckets) {
    if (paths.length < 2) continue;
    const anchor = paths[0];
    for (let i = 1; i < paths.length; i += 1) {
      const other = paths[i];
      union(parent, anchor, other);
      reasons.set(key(anchor, other), {
        exact: true,
        sameDir: path.posix.dirname(anchor) === path.posix.dirname(other),
        sharedTokens: tokens(anchor).length,
        similarity: 1,
        signatures: [sig, sig],
      });
    }
  }

  // Fuzzy matching is bounded to directories that contain suspicious names.
  // Normal modules never pay quadratic cost merely for existing.
  for (const paths of dirBuckets.values()) {
    const suspicious = paths.filter((p) => SUSPICIOUS.test(path.basename(p)));
    if (!suspicious.length) continue;
    for (const a of suspicious) {
      for (const b of paths) {
        if (a === b || reasons.has(key(a, b))) continue;
        const sa = signature(a);
        const sb = signature(b);
        if (!sa || !sb || sa === sb) continue;
        const sim = similarity(a, b);
        if (sim.shared < 2 || sim.score < 0.67) continue;
        union(parent, a, b);
        reasons.set(key(a, b), {
          exact: false,
          sameDir: true,
          sharedTokens: sim.shared,
          similarity: sim.score,
          signatures: [sa, sb],
        });
      }
    }
  }

  const groups = new Map();
  for (const file of code) {
    const root = find(parent, file.rel);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(file.rel);
  }

  const findings = [];
  const violations = [];
  for (const unsortedPaths of groups.values()) {
    if (unsortedPaths.length < 2) continue;
    const paths = [...unsortedPaths].sort();
    const pairReasons = [];
    for (let i = 0; i < paths.length; i += 1) {
      for (let j = i + 1; j < paths.length; j += 1) {
        const reason = reasons.get(key(paths[i], paths[j]));
        if (reason) pairReasons.push(reason);
      }
    }
    if (!pairReasons.length) continue;

    const high = pairReasons.some((r) => r.exact) && paths.some((p) => SUSPICIOUS.test(path.basename(p)));
    findings.push(finding({
      kind: 'competing-responsibility',
      severity: high ? 'blocking' : 'warning',
      confidence: high ? 'high' : 'medium',
      action: 'human-review-required',
      scope: { files: paths },
      evidence: [{ provider: 'builtin', type: 'responsibility-signature', details: { pairs: pairReasons } }],
      identity: `competing:${paths.join('|')}`,
      message: `Files may compete for the same responsibility: ${paths.join(', ')}`,
    }));
    if (high) {
      violations.push(violation(
        'architecture/competing-responsibility',
        paths,
        `High-confidence competing responsibility cluster: ${paths.join(', ')}`,
        paths.join('|'),
      ));
    }
  }
  return { violations, findings };
}
