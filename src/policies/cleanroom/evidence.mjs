// SPDX-License-Identifier: AGPL-3.0-or-later
import { sha } from './lib/fs.mjs';

const SEVERITIES = new Set(['info', 'warning', 'blocking']);
const CONFIDENCE = new Set(['low', 'medium', 'high', 'proven']);
const ACTIONS = new Set(['observe', 'investigate', 'cleanup-candidate', 'human-review-required', 'mechanical-fix']);

function cleanArray(values = []) {
  return [...new Set((values || []).filter(Boolean).map(String))].sort();
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((k) => [k, stable(value[k])]));
  return value;
}

export function finding(input) {
  const scope = {
    files: cleanArray(input.scope?.files),
    symbols: cleanArray(input.scope?.symbols),
    responsibility: input.scope?.responsibility || null
  };
  const evidence = (input.evidence || []).map((item) => ({
    provider: String(item.provider || 'builtin'),
    type: String(item.type || input.kind || 'evidence'),
    details: stable(item.details || {})
  }));
  const kind = String(input.kind || 'unknown');
  const identity = input.identity || JSON.stringify(stable({ kind, scope, evidence: evidence.map((x) => ({ provider: x.provider, type: x.type, details: x.details })) }));
  return {
    id: input.id || sha(identity).slice(0, 20),
    kind,
    severity: SEVERITIES.has(input.severity) ? input.severity : 'warning',
    confidence: CONFIDENCE.has(input.confidence) ? input.confidence : 'medium',
    scope,
    evidence,
    canonical_candidate: input.canonical_candidate || null,
    action: ACTIONS.has(input.action) ? input.action : 'investigate',
    message: String(input.message || kind),
    first_seen: input.first_seen || null,
    last_seen: input.last_seen || null,
    metadata: stable(input.metadata || {})
  };
}

export function findingFromViolation(v) {
  return finding({
    id: `v-${v.id}`,
    identity: `violation:${v.id}`,
    kind: v.rule,
    severity: 'blocking',
    confidence: 'proven',
    scope: { files: v.paths },
    evidence: [{ provider: 'builtin', type: v.rule, details: { violation_id: v.id, detail: v.detail || '' } }],
    action: 'cleanup-candidate',
    message: v.message
  });
}

export function mergeFindings(items = []) {
  const map = new Map();
  for (const raw of items) {
    const item = finding(raw);
    const existing = map.get(item.id);
    if (!existing) { map.set(item.id, item); continue; }
    existing.evidence = [...existing.evidence, ...item.evidence];
    existing.scope.files = cleanArray([...existing.scope.files, ...item.scope.files]);
    existing.scope.symbols = cleanArray([...existing.scope.symbols, ...item.scope.symbols]);
    if (existing.confidence === 'low' && item.confidence !== 'low') existing.confidence = item.confidence;
  }
  return [...map.values()].sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));
}
