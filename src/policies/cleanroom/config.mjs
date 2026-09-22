// SPDX-License-Identifier: AGPL-3.0-or-later
import path from 'node:path';
import { DEFAULT_CONFIG } from './defaults.mjs';
import { readJsonStrict, writeJson, exists, isSafeRelativePath } from './lib/fs.mjs';

const RULE_KEYS = new Set(Object.keys(DEFAULT_CONFIG.rules));
const DESIGN_KEYS = new Set(Object.keys(DEFAULT_CONFIG.design));
const SCRIPT_KEYS = new Set(Object.keys(DEFAULT_CONFIG.scripts));
const MANAGED_KEYS = new Set(Object.keys(DEFAULT_CONFIG.managed));
const ARCHITECTURE_KEYS = new Set(Object.keys(DEFAULT_CONFIG.architecture));
const PROVIDER_KEYS = new Set(Object.keys(DEFAULT_CONFIG.providers));
const DISTRIBUTION_KEYS = new Set(Object.keys(DEFAULT_CONFIG.distribution));

function merge(base, override) {
  if (!override || typeof override !== 'object' || Array.isArray(override)) return override ?? base;
  const out = { ...base };
  for (const [k, v] of Object.entries(override)) {
    out[k] = (v && typeof v === 'object' && !Array.isArray(v) && base?.[k] && typeof base[k] === 'object' && !Array.isArray(base[k]))
      ? merge(base[k], v)
      : v;
  }
  return out;
}

function assertKnown(obj, allowed, label) {
  for (const key of Object.keys(obj || {})) if (!allowed.has(key)) throw new Error(`Unknown ${label} key: ${key}`);
}
function assertStringArray(value, label) {
  if (!Array.isArray(value) || value.some((x) => typeof x !== 'string')) throw new Error(`${label} must be an array of strings`);
}
function assertSafePaths(values, label) {
  assertStringArray(values, label);
  for (const value of values) if (!isSafeRelativePath(value)) throw new Error(`${label} contains unsafe path: ${value}`);
}

export function validateConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('.greenroom.json must contain an object');
  if (config.version !== 1) throw new Error(`Unsupported Green Room policy version: ${config.version}`);
  assertKnown(config.rules, RULE_KEYS, 'rules');
  assertKnown(config.design, DESIGN_KEYS, 'design');
  assertKnown(config.scripts, SCRIPT_KEYS, 'scripts');
  assertKnown(config.managed, MANAGED_KEYS, 'managed');
  assertKnown(config.architecture, ARCHITECTURE_KEYS, 'architecture');
  assertKnown(config.providers, PROVIDER_KEYS, 'providers');
  assertKnown(config.distribution, DISTRIBUTION_KEYS, 'distribution');
  for (const key of DISTRIBUTION_KEYS) if (typeof config.distribution[key] !== 'string' || !config.distribution[key].trim()) throw new Error(`distribution.${key} must be a non-empty string`);
  for (const key of PROVIDER_KEYS) {
    const value = config.providers?.[key];
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`providers.${key} must be an object`);
    const allowedKeys = key === 'projectNative' ? ['enabled','directory'] : ['enabled','command','timeoutMs'];
    for (const allowed of Object.keys(value)) if (!allowedKeys.includes(allowed)) throw new Error(`Unknown providers.${key} key: ${allowed}`);
    if (typeof value.enabled !== 'boolean') throw new Error(`providers.${key}.enabled must be boolean`);
    if (key === 'projectNative') {
      if (!isSafeRelativePath(value.directory)) throw new Error('providers.projectNative.directory must be a safe relative path');
    } else {
      if (typeof value.command !== 'string') throw new Error(`providers.${key}.command must be string`);
      if (!Number.isInteger(value.timeoutMs) || value.timeoutMs < 1000) throw new Error(`providers.${key}.timeoutMs must be an integer >= 1000`);
    }
  }
  if (!config.budgets || typeof config.budgets !== 'object' || Array.isArray(config.budgets)) throw new Error('budgets must be an object');
  for (const [rule, value] of Object.entries(config.budgets)) if (!Number.isInteger(value) || value < 0) throw new Error(`budgets.${rule} must be an integer >= 0`);
  for (const [key, value] of Object.entries(config.rules || {})) if (typeof value !== 'boolean') throw new Error(`rules.${key} must be boolean`);
  for (const key of ['sourceRoots', 'scriptRoots', 'entrypoints', 'ignore', 'ignorePatterns', 'defaultBranches', 'generatedAgentFiles']) assertStringArray(config[key], key);
  assertStringArray(config.sourceRoots, 'sourceRoots');
  assertStringArray(config.architecture.testPatterns, 'architecture.testPatterns');
  assertStringArray(config.architecture.excludeFromStranded, 'architecture.excludeFromStranded');
  assertStringArray(config.scriptRoots, 'scriptRoots');
  for (const value of config.sourceRoots) if (!isSafeRelativePath(value, { allowDot: true })) throw new Error(`sourceRoots contains unsafe path: ${value}`);
  for (const value of config.scriptRoots) if (!isSafeRelativePath(value, { allowDot: true })) throw new Error(`scriptRoots contains unsafe path: ${value}`);
  assertSafePaths(config.entrypoints, 'entrypoints');
  assertSafePaths(config.generatedAgentFiles, 'generatedAgentFiles');
  assertStringArray(config.design.roots, 'design.roots');
  for (const value of config.design.roots) if (!isSafeRelativePath(value, { allowDot: true })) throw new Error(`design.roots contains unsafe path: ${value}`);
  assertSafePaths(config.design.tokenFiles, 'design.tokenFiles');
  for (const key of ['registryFile', 'generatedFile', 'baselineFile', 'waiversFile']) if (!isSafeRelativePath(config[key])) throw new Error(`${key} must be a safe relative path`);
  for (const key of ['skillFile', 'workflowFile']) if (!isSafeRelativePath(config.managed[key])) throw new Error(`managed.${key} must be a safe relative path`);
  if (!Number.isInteger(config.duplicateBlocks.minLines) || config.duplicateBlocks.minLines < 3) throw new Error('duplicateBlocks.minLines must be an integer >= 3');
  if (!Number.isInteger(config.duplicateBlocks.minOccurrences) || config.duplicateBlocks.minOccurrences < 2) throw new Error('duplicateBlocks.minOccurrences must be an integer >= 2');
  assertStringArray(config.duplicateBlocks.ignorePatterns, 'duplicateBlocks.ignorePatterns');
  if (!Number.isInteger(config.maxFileBytes) || config.maxFileBytes < 1024) throw new Error('maxFileBytes must be an integer >= 1024');
  return config;
}

export function configPath(root) { return path.join(root, '.greenroom.json'); }
export function loadPolicySource(root) {
  const file = configPath(root);
  return exists(file) ? readJsonStrict(file, '.greenroom.json') : {};
}
export function loadConfig(root) {
  const local = loadPolicySource(root);
  return validateConfig(merge(DEFAULT_CONFIG, local));
}
export function writeDefaultConfig(root) { writeJson(configPath(root), DEFAULT_CONFIG); }
