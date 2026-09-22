// SPDX-License-Identifier: AGPL-3.0-or-later
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export function executableCandidates(root, name, configured = null) {
  const out = [];
  if (configured) out.push(configured);
  const local = path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? `${name}.cmd` : name);
  if (fs.existsSync(local)) out.push(local);
  out.push(name);
  return [...new Set(out)];
}

export function runJsonCommand(root, candidates, args, { timeoutMs = 120000, env = {} } = {}) {
  let unavailable = true;
  const errors = [];
  for (const command of candidates) {
    const r = spawnSync(command, args, {
      cwd: root,
      encoding: 'utf8',
      timeout: timeoutMs,
      maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, ...env },
      shell: false
    });
    if (r.error?.code === 'ENOENT') continue;
    unavailable = false;
    if (r.error) { errors.push(`${command}: ${r.error.message}`); continue; }
    const stdout = String(r.stdout || '').trim();
    if (![0, 1].includes(r.status)) {
      errors.push(`${command} exited ${r.status}: ${stdout || String(r.stderr || '').trim()}`);
      continue;
    }
    try { return { available: true, command, status: r.status, data: JSON.parse(stdout || '{}'), stderr: String(r.stderr || '').trim() }; }
    catch (error) { errors.push(`${command}: invalid JSON: ${error.message}`); }
  }
  return { available: false, unavailable, errors };
}

export function probeCommand(root, candidates, args = ['--version'], { timeoutMs = 10000, env = {} } = {}) {
  const errors = [];
  for (const command of candidates) {
    const r = spawnSync(command, args, {
      cwd: root,
      encoding: 'utf8',
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024,
      env: { ...process.env, ...env },
      shell: false,
    });
    if (r.error?.code === 'ENOENT') continue;
    if (r.error) { errors.push(`${command}: ${r.error.message}`); continue; }
    if (r.status === 0) {
      return { available: true, command, output: String(r.stdout || r.stderr || '').trim(), errors };
    }
    errors.push(`${command} exited ${r.status}: ${String(r.stderr || r.stdout || '').trim()}`);
  }
  return { available: false, command: null, output: '', errors };
}

export function relativePath(value) {
  return String(value || '').replaceAll('\\', '/').replace(/^\.\//, '');
}

export function commandAvailability(root, name, configured = null, options = {}) {
  const candidates = executableCandidates(root, name, configured);
  const result = probeCommand(root, candidates, options.args || ['--version'], options);
  return {
    available: result.available,
    command: result.command || null,
    version: result.output || null,
    errors: result.errors || []
  };
}

export function runNamedJson(root, name, configured, args, options = {}) {
  return runJsonCommand(root, executableCandidates(root, name, configured), args, options);
}
