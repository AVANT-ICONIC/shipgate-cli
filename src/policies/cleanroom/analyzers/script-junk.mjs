// SPDX-License-Identifier: AGPL-3.0-or-later
import path from 'node:path';
import { walk, readJson, isInsideAny } from '../lib/fs.mjs';
import { finding } from '../evidence.mjs';

function normalizeCommand(value) {
  return String(value || '').trim().replace(/\s+/g, ' ');
}

/** Evidence-only script governance. Deterministic script chains remain blocking in scripts.mjs;
 * these findings identify likely consolidation work that still needs human/agent canonicality review.
 */
export function analyzeScriptJunk(root, files, config) {
  if (!config.rules.scriptJunkDrawer) return { findings: [] };
  const findings = [];
  const packages = walk(root, config).filter((f) => path.basename(f.rel) === 'package.json');
  if (!packages.some((f) => f.rel === 'package.json')) packages.unshift({ rel: 'package.json', abs: path.join(root, 'package.json') });

  for (const pkgFile of packages) {
    const pkg = readJson(pkgFile.abs, null);
    const scripts = pkg && typeof pkg === 'object' ? (pkg.scripts || {}) : {};
    const byCommand = new Map();
    for (const [name, command] of Object.entries(scripts)) {
      const normalized = normalizeCommand(command);
      if (!normalized) continue;
      if (!byCommand.has(normalized)) byCommand.set(normalized, []);
      byCommand.get(normalized).push(name);
    }
    for (const [command, names] of byCommand) {
      if (names.length < 2) continue;
      const sorted = [...names].sort();
      findings.push(finding({
        kind: 'duplicate-package-script', severity: 'warning', confidence: 'proven', action: 'human-review-required',
        scope: { files: [pkgFile.rel], symbols: sorted },
        evidence: [{ provider: 'builtin', type: 'duplicate-package-script-command', details: { command, scripts: sorted } }],
        identity: `duplicate-package-script:${pkgFile.rel}:${command}`,
        message: `${pkgFile.rel} has ${sorted.length} package scripts with the same command: ${sorted.join(', ')}`
      }));
    }
  }

  // Ownership is handled separately and can be made blocking. Here we expose the script surface
  // so cleanup campaigns can see how large the junk drawer is without claiming every script is bad.
  const scriptFiles = files.filter((f) => isInsideAny(f.rel, config.scriptRoots || []));
  if (scriptFiles.length) findings.push(finding({
    kind: 'script-surface', severity: 'info', confidence: 'proven', action: 'observe',
    scope: { files: scriptFiles.map((f) => f.rel) },
    evidence: [{ provider: 'builtin', type: 'script-inventory', details: { count: scriptFiles.length } }],
    identity: `script-surface:${scriptFiles.map((f) => f.rel).sort().join('|')}`,
    message: `Repository contains ${scriptFiles.length} source script${scriptFiles.length === 1 ? '' : 's'} under governed script roots`
  }));

  return { findings };
}
