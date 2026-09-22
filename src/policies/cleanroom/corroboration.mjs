// SPDX-License-Identifier: AGPL-3.0-or-later
function deletionFamily(kind) {
  if (['unused-file','stranded-feature','unreachable-source','architecture/unreachable','architecture/stranded-feature'].includes(kind)) return 'reachability';
  if (['duplicate-code','competing-responsibility','architecture/competing-responsibility','duplication/file','duplication/block'].includes(kind)) return 'duplication';
  if (['dependency-cycle','architecture/cycle'].includes(kind)) return 'cycle';
  return null;
}

function positiveFamily(kind) {
  if (['production-reachable','runtime-reachable','used-file','production-used'].includes(kind)) return 'reachability';
  if (['distinct-responsibility','intentional-duplicate'].includes(kind)) return 'duplication';
  return null;
}

export function corroborate(findings = []) {
  const groups = new Map();
  const get = (family, file) => {
    const key = `${family}:${file}`;
    if (!groups.has(key)) groups.set(key, { family, file, providers: new Set(), findings: [], positiveFindings: [], negativeProviders: new Set(), positiveProviders: new Set() });
    return groups.get(key);
  };
  for (const item of findings) {
    const negative = deletionFamily(item.kind);
    const positive = positiveFamily(item.kind);
    const file = item.scope?.files?.[0];
    if ((!negative && !positive) || !file) continue;
    const family = negative || positive;
    const g = get(family, file);
    const providers = new Set((item.evidence || []).map((e) => e.provider).filter(Boolean));
    for (const p of providers) g.providers.add(p);
    if (negative) {
      g.findings.push(item.id);
      for (const p of providers) g.negativeProviders.add(p);
    } else {
      g.positiveFindings.push(item.id);
      for (const p of providers) g.positiveProviders.add(p);
    }
  }
  return [...groups.values()].filter((g) => g.findings.length).map((g) => ({
    family: g.family,
    file: g.file,
    providers: [...g.providers].sort(),
    findings: g.findings.sort(),
    contradictoryFindings: g.positiveFindings.sort(),
    status: g.positiveFindings.length ? 'conflicting' : g.negativeProviders.size >= 2 ? 'corroborated' : 'single-source',
    deletionAuthority: false
  })).sort((a,b) => a.family.localeCompare(b.family) || a.file.localeCompare(b.file));
}
