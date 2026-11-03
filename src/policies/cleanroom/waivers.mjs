// SPDX-License-Identifier: AGPL-3.0-or-later
import path from 'node:path';
import { exists, readJsonStrict, writeJson } from './lib/fs.mjs';
import { sha } from './lib/fs.mjs';

export function emptyWaivers() { return { version: 1, waivers: [] }; }

export function loadWaivers(root, config) {
  const file = path.join(root, config.waiversFile);
  if (!exists(file)) return emptyWaivers();
  const data = readJsonStrict(file, config.waiversFile);
  if (!data || typeof data !== 'object' || data.version !== 1 || !Array.isArray(data.waivers)) throw new Error(`${config.waiversFile} must contain { "version": 1, "waivers": [] }`);
  for (const item of data.waivers) {
    if (!item || typeof item !== 'object' || typeof item.id !== 'string' || typeof item.reason !== 'string' || !item.reason.trim()) throw new Error(`${config.waiversFile} contains an invalid waiver`);
    if (typeof item.owner !== 'string' || !item.owner.trim()) throw new Error(`Waiver ${item.id} requires an owner`);
    if (typeof item.expiresAt !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(item.expiresAt)) throw new Error(`Waiver ${item.id} requires expiry YYYY-MM-DD`);
  }
  return data;
}

export function waiversHash(root, config) {
  const data = loadWaivers(root, config);
  const stable = [...data.waivers].sort((a,b) => a.id.localeCompare(b.id)).map((x) => ({ id:x.id, reason:x.reason, owner:x.owner || '', expiresAt:x.expiresAt || '' }));
  return sha(JSON.stringify(stable));
}

export function waiverStatus(data, now = new Date()) {
  const today = now.toISOString().slice(0, 10);
  const active = new Map();
  const expired = [];
  for (const item of data.waivers || []) {
    if (item.expiresAt && item.expiresAt < today) expired.push(item);
    else active.set(item.id, item);
  }
  return { active, expired };
}

export function applyWaivers(violations, data, now = new Date()) {
  const { active, expired } = waiverStatus(data, now);
  const waived = [];
  const kept = [];
  for (const v of violations) {
    const waiver = active.get(v.id);
    if (waiver) waived.push({ violation: v, waiver });
    else kept.push(v);
  }
  return { violations: kept, waived, expired };
}

export function addWaiver(root, config, violation, { reason, owner = '', expiresAt = '' }) {
  if (!reason?.trim()) throw new Error('A waiver requires --reason="..."');
  if (!owner?.trim()) throw new Error('A waiver requires --owner="..."');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(expiresAt || '')) throw new Error('A waiver requires --expires=YYYY-MM-DD');
  const today = new Date().toISOString().slice(0, 10);
  if (expiresAt < today) throw new Error('--expires must be today or a future date');
  const data = loadWaivers(root, config);
  const next = {
    id: violation.id,
    rule: violation.rule,
    paths: violation.paths,
    reason: reason.trim(),
    owner: owner.trim(),
    createdAt: new Date().toISOString(),
    expiresAt
  };
  const idx = data.waivers.findIndex((x) => x.id === violation.id);
  if (idx >= 0) data.waivers[idx] = next; else data.waivers.push(next);
  data.waivers.sort((a,b) => a.id.localeCompare(b.id));
  writeJson(path.join(root, config.waiversFile), data);
  return next;
}

export function removeWaiver(root, config, id) {
  const data = loadWaivers(root, config);
  const before = data.waivers.length;
  data.waivers = data.waivers.filter((x) => x.id !== id);
  writeJson(path.join(root, config.waiversFile), data);
  return before !== data.waivers.length;
}
