// SPDX-License-Identifier: AGPL-3.0-or-later
import { scan } from './scanner.mjs';
import { loadConfig } from './config.mjs';
import { loadBaseline } from './baseline.mjs';
import { inferCompareRef, withRefWorktree } from './comparison.mjs';
import { integrityViolations, governanceAllowed } from './integrity.mjs';
import { loadWaivers, applyWaivers } from './waivers.mjs';
import { violation, sortViolations } from './violations.mjs';
import { checkText } from './report.mjs';

function expiredWaiverViolations(expired, config) {
  return expired.map((item) => violation('policy/expired-waiver', [config.waiversFile], `Waiver expired for ${item.id}${item.expiresAt ? ` on ${item.expiresAt}` : ''}: ${item.reason}`, `${item.id}:${item.expiresAt || 'expired'}`));
}

function filteredResult(root, config, raw) {
  const waiverData = loadWaivers(root, config);
  const applied = applyWaivers(raw.violations, waiverData);
  return {
    result: { ...raw, violations: applied.violations },
    waived: applied.waived,
    expired: applied.expired
  };
}

export function evaluateCheck(root, { explicitCompareRef = null } = {}) {
  const config = loadConfig(root);
  const baseline = loadBaseline(root, config);
  if (!baseline) return { error: 'No Green Room baseline found. Run `greenroom baseline` after reviewing the first audit.', exitCode: 2 };

  const raw = scan(root, config);
  const currentFiltered = filteredResult(root, config, raw);
  const compareRef = inferCompareRef(root, config, explicitCompareRef);
  const guards = integrityViolations(root, config, baseline, { compareRef });
  const finalViolations = sortViolations([...currentFiltered.result.violations, ...expiredWaiverViolations(currentFiltered.expired, config), ...guards]);
  const finalCounts = {};
  let finalEntropy = 0;
  for (const item of finalViolations) {
    finalCounts[item.rule] = (finalCounts[item.rule] || 0) + 1;
    finalEntropy += config.entropyWeights?.[item.rule] ?? 1;
  }
  const current = {
    ...currentFiltered.result,
    violations: finalViolations,
    counts: finalCounts,
    entropy: finalEntropy
  };

  let reference = baseline;
  let referenceLabel = `adoption baseline (${config.baselineFile})`;
  let comparison = null;

  if (compareRef && !governanceAllowed()) {
    comparison = withRefWorktree(root, compareRef, (baseRoot, resolved) => {
      try {
        const baseConfig = loadConfig(baseRoot);
        if (!loadBaseline(baseRoot, baseConfig)) return null;
        const baseRaw = scan(baseRoot, baseConfig);
        const baseFiltered = filteredResult(baseRoot, baseConfig, baseRaw);
        return { resolved, root: baseRoot, violations: baseFiltered.result.violations };
      } catch { return null; }
    });
    if (comparison) {
      reference = { violations: comparison.violations };
      referenceLabel = `repository state @ ${comparison.resolved.slice(0, 12)}`;
    }
  }

  const checked = checkText(current, reference, { referenceLabel, waived: currentFiltered.waived });
  return {
    exitCode: checked.fresh.length ? 1 : 0,
    compareRef,
    referenceLabel,
    fresh: checked.fresh,
    resolved: checked.resolved,
    waived: currentFiltered.waived,
    expiredWaivers: currentFiltered.expired,
    current,
    text: checked.text
  };
}
