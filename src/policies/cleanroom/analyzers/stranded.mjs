// SPDX-License-Identifier: AGPL-3.0-or-later
import { isInsideAny, matchesAnyPattern } from '../lib/fs.mjs';
import { violation } from '../violations.mjs';
import { finding } from '../evidence.mjs';

function reachableFrom(graph, starts) {
  const seen = new Set();
  const visit = (node) => {
    if (seen.has(node) || !graph.has(node)) return;
    seen.add(node);
    for (const dep of graph.get(node) || []) visit(dep);
  };
  for (const start of starts) visit(start);
  return seen;
}

export function analyzeStranded(files, graph, config) {
  if (!config.rules.strandedFeatures) return { violations: [], findings: [], reachability: null };
  const productionRoots = (config.entrypoints || []).filter((entry) => graph.has(entry));
  if (!productionRoots.length) return { violations: [], findings: [], reachability: { productionRoots: [], testRoots: [], production: new Set(), tests: new Set() } };
  const testRoots = files.map((f) => f.rel).filter((rel) => graph.has(rel) && matchesAnyPattern(rel, config.architecture?.testPatterns || []));
  const production = reachableFrom(graph, productionRoots);
  const tests = reachableFrom(graph, testRoots);
  const violations = [];
  const findings = [];
  for (const file of files) {
    const rel = file.rel;
    if (!graph.has(rel) || !isInsideAny(rel, config.sourceRoots || [])) continue;
    if (production.has(rel)) continue;
    if (matchesAnyPattern(rel, config.architecture?.testPatterns || [])) continue;
    if (matchesAnyPattern(rel, config.architecture?.excludeFromStranded || [])) continue;
    const testOnly = tests.has(rel);
    const kind = testOnly ? 'stranded-feature' : 'unreachable-source';
    findings.push(finding({
      kind,
      severity: testOnly ? 'blocking' : 'warning',
      confidence: testOnly ? 'proven' : 'high',
      action: testOnly ? 'human-review-required' : 'investigate',
      scope: { files: [rel] },
      evidence: [{ provider: 'builtin', type: 'resolved-import-reachability', details: { productionRoots, testOnly, reachableFromTests: testOnly } }],
      identity: `${kind}:${rel}`,
      message: testOnly
        ? `Implementation is reachable from tests but not from any production entrypoint: ${rel}`
        : `Source is not reachable from configured production entrypoints: ${rel}`
    }));
    if (testOnly) violations.push(violation('architecture/stranded-feature', [rel], `Tested implementation is not wired into a production entrypoint: ${rel}`, rel));
  }
  return { violations, findings, reachability: { productionRoots, testRoots, production, tests } };
}
