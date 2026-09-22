// SPDX-License-Identifier: AGPL-3.0-or-later
import { commandAvailability, runNamedJson, relativePath } from './util.mjs';
import { finding, mergeFindings } from '../evidence.mjs';

function itemPath(item, fallback = '') {
  return relativePath(item?.path || item?.file || item?.file_path || item?.filename || item?.from_path || item?.source_path || fallback);
}
function itemName(item) { return String(item?.name || item?.symbol || item?.export || item?.dependency || item?.specifier || ''); }

function pushList(out, list, kind, providerType, { confidence = 'high', action = 'cleanup-candidate', message } = {}) {
  if (!Array.isArray(list)) return;
  for (const raw of list) {
    const item = typeof raw === 'string' ? { path: raw } : raw;
    const path = itemPath(item);
    const symbol = itemName(item);
    out.push(finding({
      kind,
      confidence,
      severity: 'warning',
      action,
      scope: { files: path ? [path] : [], symbols: symbol ? [symbol] : [] },
      evidence: [{ provider: 'fallow', type: providerType, details: item }],
      identity: `fallow:${providerType}:${path}:${symbol}:${JSON.stringify(item?.cycle || item?.members || item?.paths || '')}`,
      message: message ? message(item, path, symbol) : `Fallow reported ${providerType}${path ? ` in ${path}` : ''}${symbol ? `: ${symbol}` : ''}`
    }));
  }
}

function pushCycles(out, list) {
  if (!Array.isArray(list)) return;
  for (const raw of list) {
    const item = typeof raw === 'string' ? { path: raw } : raw;
    const files = [...new Set([...(item?.files || item?.cycle || []), itemPath(item)].map(relativePath).filter(Boolean))];
    out.push(finding({
      kind: 'dependency-cycle', confidence: 'high', severity: 'warning', action: 'cleanup-candidate',
      scope: { files }, evidence: [{ provider: 'fallow', type: 'cycle', details: item }],
      identity: `fallow:cycle:${files.slice().sort().join('|')}`,
      message: `Fallow reported a dependency cycle${files.length ? ` across ${files.join(' -> ')}` : ''}`
    }));
  }
}

function pushBoundaries(out, list) {
  if (!Array.isArray(list)) return;
  for (const item of list) {
    const files = [...new Set([item?.from_path, item?.to_path].map(relativePath).filter(Boolean))];
    out.push(finding({
      kind: 'boundary-violation', confidence: 'proven', severity: 'warning', action: 'cleanup-candidate',
      scope: { files }, evidence: [{ provider: 'fallow', type: 'boundary-violation', details: item }],
      identity: `fallow:boundary:${item?.from_path || ''}->${item?.to_path || ''}:${item?.import_specifier || ''}`,
      message: `Fallow reported an architecture boundary violation${files.length ? `: ${files.join(' -> ')}` : ''}`
    }));
  }
}

function pushHealth(out, health) {
  if (!health || typeof health !== 'object') return;
  pushList(out, health.findings, 'complexity-finding', 'health-finding', { confidence: 'high', action: 'investigate' });
  pushList(out, health.hotspots, 'complexity-hotspot', 'hotspot', { confidence: 'high', action: 'investigate' });
  for (const key of ['design_system_findings','design_system_drift','styling_findings','css_findings']) {
    pushList(out, health[key], 'design-system-drift', key, { confidence: 'high', action: 'investigate' });
  }
  if (health.styling_health && typeof health.styling_health === 'object') {
    const style = health.styling_health;
    for (const key of ['findings','violations','raw_values','specificity_hotspots']) {
      pushList(out, style[key], 'design-system-drift', `styling-health:${key}`, { confidence: 'high', action: 'investigate' });
    }
  }
}

function normalizeCloneGroups(out, section) {
  if (!section || typeof section !== 'object') return;
  const groups = section?.clone_groups || section?.groups || section?.clones || section?.duplicates || section?.findings;
  if (!Array.isArray(groups)) return;
  for (const group of groups) {
    const instances = group?.instances || group?.occurrences || group?.members || group?.locations || [];
    const files = [...new Set((instances || []).map((x) => itemPath(x)).filter(Boolean))];
    if (files.length < 2) continue;
    out.push(finding({
      kind: 'duplicate-code', confidence: 'high', severity: 'warning', action: 'human-review-required',
      scope: { files },
      evidence: [{ provider: 'fallow', type: 'duplication', details: group }],
      identity: `fallow:dupe:${files.sort().join('|')}:${group?.fingerprint || group?.hash || group?.id || ''}`,
      message: `Fallow found a duplicate-code group across ${files.length} files`
    }));
  }
}

function sections(data) {
  const queue = [data];
  const out = [];
  const seen = new Set();
  const keys = ['check', 'dead_code', 'deadCode', 'results', 'result', 'analysis', 'data', 'payload'];
  while (queue.length) {
    const value = queue.shift();
    if (!value || typeof value !== 'object' || seen.has(value)) continue;
    seen.add(value); out.push(value);
    for (const key of keys) if (value[key] && typeof value[key] === 'object') queue.push(value[key]);
  }
  return out;
}

/** Normalize Fallow's public JSON envelopes into Green Room evidence.
 * The Fallow contract has several command-specific envelopes, so this intentionally
 * accepts both sectioned (`check`, `dead_code`) and direct result shapes.
 */
export function normalizeFallow(data) {
  const out = [];
  for (const dead of sections(data)) {
    pushList(out, dead.unused_files, 'unused-file', 'unused-file', { confidence: 'high', message: (_i,p) => `Unused file candidate: ${p}` });
    pushList(out, dead.unused_exports, 'unused-export', 'unused-export');
    pushList(out, dead.unused_types, 'unused-type', 'unused-type');
    pushList(out, dead.unused_members, 'unused-member', 'unused-member');
    pushList(out, dead.unused_dependencies, 'unused-dependency', 'unused-dependency');
    pushList(out, dead.unused_dev_dependencies, 'unused-dependency', 'unused-dev-dependency');
    pushList(out, dead.unused_optional_dependencies, 'unused-dependency', 'unused-optional-dependency');
    pushList(out, dead.unused_enum_members, 'unused-member', 'unused-enum-member');
    pushList(out, dead.unused_class_members, 'unused-member', 'unused-class-member');
    pushList(out, dead.unlisted_dependencies, 'unlisted-dependency', 'unlisted-dependency');
    pushList(out, dead.duplicate_exports, 'duplicate-export', 'duplicate-export', { action: 'human-review-required' });
    pushCycles(out, dead.circular_dependencies || dead.cycles);
    pushBoundaries(out, dead.boundary_violations);
    pushList(out, dead.unresolved_imports, 'unresolved-import', 'unresolved-import');
    normalizeCloneGroups(out, dead.dupes || dead.duplication || (dead.kind === 'dupes' ? dead : null));
    pushHealth(out, dead.health || dead.complexity);
  }
  pushHealth(out, data?.health || data?.complexity);
  if (data?.kind === 'audit' && Number.isInteger(data.changed_files_count)) {
    out.push(finding({ kind:'changed-file-scope', severity:'info', confidence:'proven', action:'observe', scope:{files:[]}, evidence:[{provider:'fallow',type:'audit-scope',details:{changed_files_count:data.changed_files_count,base_ref:data.base_ref||null,head_sha:data.head_sha||null}}], identity:`fallow:audit-scope:${data.base_ref||''}:${data.head_sha||''}:${data.changed_files_count}`, message:`Fallow audit scoped ${data.changed_files_count} changed file(s)` }));
  }
  return mergeFindings(out);
}

export function createFallowProvider(config = {}) {
  return {
    id: 'fallow',
    capabilities() { return ['static-analysis', 'reachability', 'duplication', 'architecture', 'design-system']; },
    available(root) {
      return commandAvailability(root, 'fallow', config.command);
    },
    scan(root) {
      const run = runNamedJson(root, 'fallow', config.command, ['--format', 'json', '--quiet'], { timeoutMs: config.timeoutMs || 120000 });
      if (!run.available) return { provider: 'fallow', available: false, status: run.unavailable ? 'unavailable' : 'error', errors: run.errors || [], findings: [] };
      if (run.data?.error) return { provider: 'fallow', available: true, status: 'error', errors: [run.data.message || 'Fallow returned an error envelope'], findings: [] };
      return { provider: 'fallow', available: true, status: 'ok', command: run.command, findings: normalizeFallow(run.data), rawKind: run.data?.kind || null };
    }
  };
}
