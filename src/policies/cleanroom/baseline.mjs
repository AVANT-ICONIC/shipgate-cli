// SPDX-License-Identifier: AGPL-3.0-or-later
import path from 'node:path';
import { writeJson, readJsonStrict, exists } from './lib/fs.mjs';
import { policyHash, registryHash, generatedHash } from './integrity.mjs';
import { waiversHash } from './waivers.mjs';

function validateBaseline(data, label) {
  if (!data || typeof data !== 'object' || data.version !== 1 || !Array.isArray(data.violations)) throw new Error(`${label} is not a valid Green Room baseline`);
  const ids = new Set();
  for (const item of data.violations) {
    if (!item || typeof item.id !== 'string' || typeof item.rule !== 'string' || !Array.isArray(item.paths)) throw new Error(`${label} contains an invalid violation`);
    if (ids.has(item.id)) throw new Error(`${label} contains duplicate violation id ${item.id}`);
    ids.add(item.id);
  }
  return data;
}

export function makeBaseline(root, config, result) {
  const file = path.join(root, config.baselineFile);
  const baseline = {
    version: 1,
    createdAt: new Date().toISOString(),
    policyHash: policyHash(root),
    waiversHash: waiversHash(root, config),
    registryHash: registryHash(root, config),
    generatedHash: generatedHash(root, config),
    entropy: result.entropy,
    counts: result.counts,
    violations: result.violations.map(({ id, rule, paths, message, detail }) => ({ id, rule, paths, message, detail }))
  };
  writeJson(file, baseline);
  return baseline;
}
export function loadBaseline(root, config) {
  const file = path.join(root, config.baselineFile);
  return exists(file) ? validateBaseline(readJsonStrict(file, config.baselineFile), config.baselineFile) : null;
}
