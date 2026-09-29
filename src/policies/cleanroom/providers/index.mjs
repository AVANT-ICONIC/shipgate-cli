// SPDX-License-Identifier: AGPL-3.0-or-later
import { createFallowProvider } from './fallow.mjs';
import { createKnipProvider } from './knip.mjs';
import { mergeFindings } from '../evidence.mjs';
import { createProjectNativeProvider } from './project-native.mjs';

export function providersFor(config) {
  return [
    createFallowProvider(config.providers?.fallow || {}),
    createKnipProvider(config.providers?.knip || {}),
    createProjectNativeProvider(config.providers?.projectNative || {})
  ];
}

function configFor(config, provider) {
  const configKey = provider.id === 'project-native' ? 'projectNative' : provider.id;
  return config.providers?.[configKey] || {};
}

export function describeProviders(root, config) {
  return providersFor(config).map((provider) => {
    const pConfig = configFor(config, provider);
    if (pConfig.enabled === false) return { provider: provider.id, enabled: false, available: false, capabilities: provider.capabilities() };
    let availability;
    try { availability = provider.available(root); }
    catch (error) { availability = { available: false, errors: [error.message] }; }
    return { provider: provider.id, enabled: true, capabilities: provider.capabilities(), ...availability };
  });
}

export function scanProviders(root, config, { only = null } = {}) {
  const statuses = [];
  const findings = [];
  for (const provider of providersFor(config)) {
    const pConfig = configFor(config, provider);
    const capabilities = provider.capabilities();
    if (pConfig.enabled === false) { statuses.push({ provider: provider.id, status: 'disabled', enabled: false, available: false, capabilities, findings: 0 }); continue; }
    if (only && !only.includes(provider.id)) continue;
    let result;
    try { result = provider.scan(root, config); }
    catch (error) { result = { provider: provider.id, available: true, status: 'error', errors: [error.message], findings: [] }; }
    statuses.push({ provider: provider.id, status: result.status, enabled: true, available: result.available, capabilities, command: result.command || null, errors: result.errors || [], findings: result.findings?.length || 0, sources: result.sources || [] });
    findings.push(...(result.findings || []));
  }
  return { statuses, findings: mergeFindings(findings) };
}
