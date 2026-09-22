// SPDX-License-Identifier: AGPL-3.0-or-later
import { sha } from './lib/fs.mjs';

function stableDetail(detail) {
  return String(detail ?? '')
    .replace(/line\s+\d+/gi, 'line')
    .replace(/:\d+(?::\d+)?/g, ':#')
    .trim();
}

export function violation(rule, paths, message, detail = '') {
  const sorted = [...new Set(paths)].sort();
  const identity = `${rule}|${sorted.join('|')}|${stableDetail(detail || message)}`;
  return {
    id: sha(identity).slice(0, 16),
    rule,
    paths: sorted,
    message,
    detail
  };
}

export function sortViolations(items) {
  return items.sort((a, b) => a.rule.localeCompare(b.rule) || a.paths.join().localeCompare(b.paths.join()) || a.id.localeCompare(b.id));
}
