// SPDX-License-Identifier: AGPL-3.0-or-later
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { sha, exists } from './lib/fs.mjs';
import { loadConfig } from './config.mjs';
import { loadRegistry } from './analyzers/registry.mjs';
import { loadGeneratedRegistry } from './analyzers/generated.mjs';
import { violation } from './violations.mjs';
import { waiversHash } from './waivers.mjs';
import { RULES_TEXT, SKILL_TEXT, workflowText, extractManagedBlock } from './managed.mjs';
import { classifyRegistryDiff } from './registry-diff.mjs';

function deepStable(value) {
  if (Array.isArray(value)) return value.map(deepStable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((k) => [k, deepStable(value[k])]));
  return value;
}

export function policyHash(root) { return sha(JSON.stringify(deepStable(loadConfig(root)))); }
export function registryHash(root, config) { return sha(JSON.stringify(deepStable(loadRegistry(root, config)))); }
export function generatedHash(root, config) { return sha(JSON.stringify(deepStable(loadGeneratedRegistry(root, config)))); }
export function governanceAllowed(kind = '') {
  return process.env.GREENROOM_ALLOW_GOVERNANCE_UPDATE === '1' || (kind && process.env[`GREENROOM_ALLOW_${kind.toUpperCase()}_UPDATE`] === '1');
}

function git(root, args) {
  try { return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); }
  catch { return null; }
}

function compareTrackedFile(root, rel, base, rule, message, allowKind) {
  if (!base || governanceAllowed(allowKind)) return null;
  const currentPath = path.join(root, rel);
  const current = fs.existsSync(currentPath) ? fs.readFileSync(currentPath, 'utf8').trim() : null;
  let previous = git(root, ['show', `${base}:${rel}`]);
  if (previous == null && !String(base).startsWith('origin/')) previous = git(root, ['show', `origin/${base}:${rel}`]);
  if (previous != null) previous = previous.trim();
  if (previous !== null && previous !== current) return violation(rule, [rel], message.replace('{base}', base), base);
  return null;
}

/**
 * Read a tracked file as the base branch has it. Null means we could not, which
 * is a different answer from "it is empty" and never reads as one.
 */
function textAtBase(root, rel, base) {
  if (!base) return null;
  let previous = git(root, ['show', `${base}:${rel}`]);
  if (previous == null && !String(base).startsWith('origin/')) previous = git(root, ['show', `origin/${base}:${rel}`]);
  return previous;
}

/**
 * ADDING A RESPONSIBILITY IS THE WORK. CHANGING ONE IS A DECISION.
 *
 * The registry starts empty and is filled one responsibility at a time. Under a
 * byte comparison every one of those pull requests is a governance event, and
 * the only way through is GREENROOM_ALLOW_GOVERNANCE_UPDATE=1, which switches
 * off the policy, waiver, registry and generated guards at once. A rule that
 * makes a project disable four guards to do routine work has inverted itself.
 *
 * An addition is still judged: analyzeRegistry rejects a canonical path that is
 * already claimed, one that does not exist, and a non-canonical peer left
 * beside it. What it cannot judge is an entry that was already there, so a
 * changed or removed entry stays blocked exactly as it was.
 *
 * Returns true only when we READ both sides and the edit was purely additive.
 * No base ref, no git, an unreadable file on either side: false, and the caller
 * blocks as it always did.
 */
function registryIsAdditiveOnly(root, config, base) {
  const previous = textAtBase(root, config.registryFile, base);
  if (previous == null) return false;
  const currentPath = path.join(root, config.registryFile);
  const current = fs.existsSync(currentPath) ? fs.readFileSync(currentPath, 'utf8') : null;
  if (current == null) return false;
  const { kind } = classifyRegistryDiff(previous, current);
  return kind === 'additive' || kind === 'same';
}

function managedViolations(root, config) {
  if (!config.rules.managedFiles) return [];
  const out = [];
  for (const rel of config.generatedAgentFiles || []) {
    const file = path.join(root, rel);
    if (!exists(file)) {
      out.push(violation('policy/managed-file', [rel], `Required agent instruction file is missing: ${rel}`, rel));
      continue;
    }
    const text = fs.readFileSync(file, 'utf8');
    const block = extractManagedBlock(text);
    if (!block) out.push(violation('policy/managed-file', [rel], `Green Room managed rule block is missing from ${rel}`, rel));
    else if (config.managed?.enforceAgentBlockExact && block !== RULES_TEXT) out.push(violation('policy/managed-file', [rel], `Green Room managed rule block was modified in ${rel}`, `${rel}:managed-block`));
  }
  const skill = config.managed?.skillFile;
  if (config.managed?.requireSkill) {
    if (!skill || !exists(path.join(root, skill))) out.push(violation('policy/managed-file', [skill || '.greenroom'], `Required Green Room hygiene skill is missing: ${skill || '(not configured)'}`, skill || 'skill'));
    else if (config.managed?.enforceSkillExact && fs.readFileSync(path.join(root, skill), 'utf8') !== SKILL_TEXT) out.push(violation('policy/managed-file', [skill], `Green Room hygiene skill was modified: ${skill}`, `${skill}:content`));
  }
  const workflow = config.managed?.workflowFile;
  if (config.managed?.requireWorkflow) {
    if (!workflow || !exists(path.join(root, workflow))) out.push(violation('policy/managed-file', [workflow || '.github/workflows'], `Required Green Room workflow is missing: ${workflow || '(not configured)'}`, workflow || 'workflow'));
    else {
      const text = fs.readFileSync(path.join(root, workflow), 'utf8');
      if (config.managed?.enforceWorkflowExact) {
        if (text !== workflowText(config)) out.push(violation('policy/managed-file', [workflow], `Generated Green Room workflow was modified: ${workflow}`, `${workflow}:content`));
      } else if (!/greenroom\s+check|src\/cli\.mjs\s+check/.test(text)) out.push(violation('policy/managed-file', [workflow], `Green Room workflow no longer runs the entropy gate: ${workflow}`, workflow));
    }
  }
  return out;
}

export function integrityViolations(root, config, baseline, { compareRef = null } = {}) {
  const out = [];
  const base = compareRef || process.env.GITHUB_BASE_REF || process.env.GREENROOM_BASE_REF;
  // Computed once and used for both registry checks, so the hash path and the
  // branch path cannot disagree about the same edit.
  const registryAdditive = governanceAllowed('registry') || registryIsAdditiveOnly(root, config, base);

  if (!governanceAllowed('policy') && baseline?.policyHash && baseline.policyHash !== policyHash(root)) out.push(violation('policy/config-changed', ['.greenroom.json'], 'Green Room policy changed after baseline. Policy changes require an explicit human governance update.', 'policy-hash'));
  if (!governanceAllowed('waiver') && baseline?.waiversHash && baseline.waiversHash !== waiversHash(root, config)) out.push(violation('policy/waivers-changed', [config.waiversFile], 'Green Room waivers changed after baseline. Waivers require an explicit human governance update.', 'waivers-hash'));
  if (!registryAdditive && baseline?.registryHash && baseline.registryHash !== registryHash(root, config)) out.push(violation('policy/registry-changed', [config.registryFile], 'Green Room canonical registry changed after baseline. Canonical architecture changes require an explicit human governance update.', 'registry-hash'));
  if (!governanceAllowed('generated') && baseline?.generatedHash && baseline.generatedHash !== generatedHash(root, config)) out.push(violation('policy/generated-registry-changed', [config.generatedFile], 'Green Room generated-artifact registry changed after baseline. Generated ownership changes require an explicit human governance update.', 'generated-hash')); 
  const baselineIssue = compareTrackedFile(root, config.baselineFile, base, 'policy/baseline-changed', `Baseline differs from {base}. Re-baselining inside routine work is blocked.`, 'baseline');
  if (baselineIssue) out.push(baselineIssue);
  const policyIssue = compareTrackedFile(root, '.greenroom.json', base, 'policy/config-changed', `Policy differs from {base}. Policy changes require an explicit human governance update.`, 'policy');
  if (policyIssue && !out.some((x) => x.id === policyIssue.id)) out.push(policyIssue);
  const waiverIssue = compareTrackedFile(root, config.waiversFile, base, 'policy/waivers-changed', `Waivers differ from {base}. Waiver changes require an explicit human governance update.`, 'waiver');
  if (waiverIssue && !out.some((x) => x.id === waiverIssue.id)) out.push(waiverIssue);
  const registryIssue = registryAdditive ? null : compareTrackedFile(root, config.registryFile, base, 'policy/registry-changed', `Canonical registry differs from {base}. Architecture registry changes require an explicit human governance update.`, 'registry');
  if (registryIssue && !out.some((x) => x.id === registryIssue.id)) out.push(registryIssue);
  const generatedIssue = compareTrackedFile(root, config.generatedFile, base, 'policy/generated-registry-changed', `Generated-artifact registry differs from {base}. Ownership changes require an explicit human governance update.`, 'generated');
  if (generatedIssue && !out.some((x) => x.id === generatedIssue.id)) out.push(generatedIssue);
  out.push(...managedViolations(root, config));
  return out;
}
