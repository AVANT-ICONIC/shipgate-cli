// SPDX-License-Identifier: AGPL-3.0-or-later
import { sourceFiles } from './lib/fs.mjs';
import { analyzeNaming } from './analyzers/naming.mjs';
import { analyzeDesign } from './analyzers/design.mjs';
import { analyzeDuplicates } from './analyzers/duplicates.mjs';
import { analyzeImports } from './analyzers/imports.mjs';
import { analyzeScripts } from './analyzers/scripts.mjs';
import { analyzeRegistry } from './analyzers/registry.mjs';
import { analyzeWrappers } from './analyzers/wrappers.mjs';
import { analyzeStranded } from './analyzers/stranded.mjs';
import { analyzeCompetingResponsibilities } from './analyzers/competing.mjs';
import { analyzeGenerated } from './analyzers/generated.mjs';
import { analyzeScriptOwnership } from './analyzers/script-ownership.mjs';
import { analyzeScriptJunk } from './analyzers/script-junk.mjs';
import { analyzeResponsibilityBoundaries } from './analyzers/responsibility-boundaries.mjs';
import { sortViolations } from './violations.mjs';
import { findingFromViolation, mergeFindings } from './evidence.mjs';
import { scanProviders } from './providers/index.mjs';
import { corroborate } from './corroboration.mjs';
import { analyzeBudgets } from './analyzers/budgets.mjs';

export function scan(root, config, { includeProviders = false, onlyProviders = null } = {}) {
  const files = sourceFiles(root, config);
  const importResult = analyzeImports(root, files, config);
  const registryResult = analyzeRegistry(root, files, config);
  const stranded = analyzeStranded(files, importResult.graph, config);
  const competing = analyzeCompetingResponsibilities(files, config);
  const generated = analyzeGenerated(root, config);
  const scriptOwnership = analyzeScriptOwnership(root, files, config);
  const scriptJunk = analyzeScriptJunk(root, files, config);
  const responsibilityBoundaries = analyzeResponsibilityBoundaries(root, importResult.graph, config);
  const rawViolations = [
    ...analyzeNaming(files, config),
    ...analyzeDesign(files, config),
    ...analyzeDuplicates(files, config),
    ...importResult.violations,
    ...analyzeScripts(root, files, config),
    ...registryResult.violations,
    ...responsibilityBoundaries,
    ...analyzeWrappers(files, config),
    ...stranded.violations,
    ...competing.violations,
    ...generated.violations,
    ...scriptOwnership.violations
  ];
  let violations = sortViolations([...new Map(rawViolations.map((v) => [v.id, v])).values()]);
  const budgetViolations = analyzeBudgets(violations, config);
  violations = sortViolations([...violations, ...budgetViolations]);
  const providerResult = includeProviders ? scanProviders(root, config, { only: onlyProviders }) : { statuses: [], findings: [] };
  const findings = mergeFindings([
    ...violations.map(findingFromViolation),
    ...registryResult.findings,
    ...stranded.findings,
    ...competing.findings,
    ...generated.findings,
    ...scriptOwnership.findings,
    ...scriptJunk.findings,
    ...providerResult.findings
  ]);
  const counts = {};
  let entropy = 0;
  for (const v of violations) {
    counts[v.rule] = (counts[v.rule] || 0) + 1;
    entropy += config.entropyWeights?.[v.rule] ?? 1;
  }
  return {
    files: files.length,
    violations,
    findings,
    counts,
    entropy,
    graph: importResult.graph,
    reachability: stranded.reachability,
    providers: providerResult.statuses,
    corroboration: corroborate(findings)
  };
}
