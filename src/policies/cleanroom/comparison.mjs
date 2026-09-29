// SPDX-License-Identifier: AGPL-3.0-or-later
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { exists } from './lib/fs.mjs';

function git(root, args, { quiet = true } = {}) {
  try {
    return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', quiet ? 'ignore' : 'pipe'] }).trim();
  } catch { return null; }
}

export function hasGit(root) { return git(root, ['rev-parse', '--is-inside-work-tree']) === 'true'; }
export function refExists(root, ref) { return Boolean(git(root, ['rev-parse', '--verify', `${ref}^{commit}`])); }
export function isDirty(root) { const value = git(root, ['status', '--porcelain']); return value == null ? false : Boolean(value); }
export function currentBranch(root) { return git(root, ['branch', '--show-current']) || null; }

function firstExisting(root, refs) { return refs.find((r) => refExists(root, r)) || null; }

export function inferCompareRef(root, config, explicit = null) {
  if (explicit) return explicit;
  if (process.env.GREENROOM_COMPARE_REF) return process.env.GREENROOM_COMPARE_REF;
  if (process.env.GITHUB_BASE_REF) {
    return firstExisting(root, [`origin/${process.env.GITHUB_BASE_REF}`, process.env.GITHUB_BASE_REF]) || process.env.GITHUB_BASE_REF;
  }
  if (!hasGit(root) || !refExists(root, 'HEAD')) return null;
  const branch = currentBranch(root);
  const defaults = config.defaultBranches || ['main', 'master'];
  if (branch && !defaults.includes(branch)) {
    const candidateRefs = defaults.flatMap((x) => [`origin/${x}`, x]);
    const base = firstExisting(root, candidateRefs);
    if (base) return git(root, ['merge-base', 'HEAD', base]) || base;
    if (isDirty(root)) return 'HEAD';
    return null;
  }
  if (branch && defaults.includes(branch)) {
    if (isDirty(root)) return 'HEAD';
    if (refExists(root, 'HEAD^')) return 'HEAD^';
  }
  if (isDirty(root)) return 'HEAD';
  return null;
}

export function withRefWorktree(root, ref, fn) {
  if (!ref || !hasGit(root)) return null;
  const resolved = git(root, ['rev-parse', '--verify', `${ref}^{commit}`]);
  if (!resolved) return null;
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'greenroom-compare-'));
  const target = path.join(parent, 'tree');
  try {
    execFileSync('git', ['-C', root, 'worktree', 'add', '--detach', '--quiet', target, resolved], { stdio: ['ignore', 'ignore', 'pipe'] });
    return fn(target, resolved);
  } finally {
    try { execFileSync('git', ['-C', root, 'worktree', 'remove', '--force', target], { stdio: 'ignore' }); } catch {}
    try { fs.rmSync(parent, { recursive: true, force: true }); } catch {}
  }
}

export function refHasGreenRoom(root) {
  return exists(path.join(root, '.greenroom.json')) && exists(path.join(root, '.greenroom', 'baseline.json'));
}
