// SPDX-License-Identifier: AGPL-3.0-or-later
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { findCampaign } from './plan.mjs';
import { writeText } from './lib/fs.mjs';

function kebab(value) {
  const name = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
  if (!name) throw new Error('OpenSpec change name resolved to an empty value');
  return name.slice(0, 96).replace(/-+$/g, '');
}


function bullets(values, empty = '- None declared.') {
  const items = [...new Set((values || []).filter(Boolean))];
  return items.length ? items.map((x) => `- ${x}`).join('\n') : empty;
}

function renderProposal(found) {
  const { phase, batch } = found;
  return `# Why\n\nGreen Room detected repository entropy in **${phase.title}**. The cleanup is intended to reduce ambiguity and repository maintenance cost without changing externally visible behavior.\n\n## What Changes\n\n- Resolve Green Room cleanup campaign \`${batch.id}\`.\n- Address ${batch.count} target item(s) across ${batch.paths.length} path(s).\n- Preserve the selected canonical implementation instead of adding wrappers or parallel replacements.\n- Delete superseded implementation only after caller, test, and behavior evidence is accounted for.\n- Pass Green Room verification and the repository's normal verification commands before completion.\n\n## Capabilities\n\n### New Capabilities\n\n- None. This is a behavior-preserving repository cleanup.\n\n### Modified Capabilities\n\n- None. If implementation work reveals an externally visible behavior change, stop this cleanup change, remove \`skip_specs: true\`, and author the appropriate OpenSpec delta specs before continuing.\n`;
}

function renderDesign(found) {
  const { phase, batch } = found;
  const evidence = (batch.evidence || []).slice(0, 30).map((x) => `- \`${x.id}\` **${x.kind}** [${x.confidence}] ${x.message}`).join('\n') || '- No external evidence records were attached to this campaign.';
  const violations = (batch.items || []).map((x) => `- \`${x.id}\` **${x.rule}** ${x.message}`).join('\n') || '- No blocking violation IDs; this campaign is evidence/review driven.';
  const verification = (batch.verificationCommands || []).map((x) => `- \`${[x.command, ...(x.args || [])].join(' ')}\``).join('\n') || '- Repository-specific tests/typecheck/build were not detected.';
  return `# Context\n\nGreen Room cleanup campaign \`${batch.id}\` targets **${phase.title}**. Base commit: \`${batch.baseCommit || 'unknown'}\`.\n\nTarget paths:\n\n${bullets(batch.paths.map((x) => `\`${x}\``))}\n\nBlocking violations:\n\n${violations}\n\nEvidence:\n\n${evidence}\n\n## Goals / Non-Goals\n\n**Goals**\n\n- Reduce repository entropy and canonicality ambiguity.\n- Migrate callers to one durable implementation where consolidation is required.\n- Remove superseded code rather than preserving indefinite compatibility wrappers.\n- Keep externally visible behavior unchanged.\n\n**Non-Goals**\n\n- Add new product behavior.\n- Silence Green Room through waivers or baseline replacement.\n- Delete code on the authority of one weak analyzer.\n- Perform unrelated cleanup outside this campaign.\n\n## Decisions\n\n1. **Green Room evidence remains authoritative for repository hygiene.** OpenSpec records the agreed cleanup contract; it does not replace static analysis or the ratchet.\n2. **Canonicality is decided before destructive mutation.** Current decision: ${batch.canonicalDecision ? `\`${batch.canonicalDecision}\`` : '_not yet recorded_'}.\n3. **Deletion-sensitive work requires explicit approval.** Approval status: **${batch.approval?.status || 'unknown'}**${batch.approval?.owner ? ` by **${batch.approval.owner}**` : ''}.\n4. **Behavior preservation is explicit.** Declared behavior that must survive:\n\n${bullets(batch.behaviorMustSurvive)}\n\n## Risks / Trade-offs\n\n- [False-positive cleanup candidate] → require corroboration, blast-radius review, and Green Room campaign verification before accepting deletion.\n- [Hidden dynamic caller] → inspect declared production roots, scripts, CI/hooks, project-native graph evidence, and tests before removing code.\n- [Cleanup introduces replacement debris] → Green Room check must pass with zero new entropy; wrappers and new fix scripts are not acceptable substitutes for consolidation.\n- [Scope creep] → only touch campaign paths plus the minimum callers/tests required to complete the migration.\n\n## Migration Plan\n\n1. Confirm campaign evidence and canonical ownership.\n2. Map production callers, test-only callers, scripts, hooks, and generated relationships.\n3. Make the smallest behavior-preserving consolidation in isolation.\n4. Migrate callers and remove superseded implementation in the same change.\n5. Run repository verification:\n\n${verification}\n\n6. Run \`greenroom cleanup verify ${batch.id}\`.\n7. Run \`greenroom check\`; do not accept the cleanup unless the ratchet passes.\n\n## Open Questions\n\n- None may remain that would change canonical ownership, behavior, or the deletion plan. If one appears, resolve it before implementation.\n`;
}

function renderTasks(found) {
  const { batch } = found;
  const approvalDone = !batch.approval?.required || batch.approval?.status === 'approved';
  const verifyCommands = (batch.verificationCommands || []).map((x) => `\`${[x.command, ...(x.args || [])].join(' ')}\``).join(', ') || 'the repository\'s applicable verification commands';
  return `## 1. Establish cleanup authority\n\n- [${approvalDone ? 'x' : ' '}] 1.1 Review Green Room campaign \`${batch.id}\`, confirm canonical ownership and deletion safety, and verify any required approval is recorded.\n- [ ] 1.2 Re-check production callers, test-only callers, scripts/hooks, generated relationships, and conflicting provider evidence; verify no unresolved evidence changes the plan.\n\n## 2. Consolidate without behavior drift\n\n- [ ] 2.1 Implement the bounded cleanup for the campaign paths, migrate callers to the canonical implementation, and verify no parallel replacement or fix script is introduced.\n- [ ] 2.2 Delete superseded code only after its behavior/callers are accounted for, and verify the intended externally visible behavior remains unchanged.\n\n## 3. Verify and ratchet\n\n- [ ] 3.1 Run ${verifyCommands} and verify all required commands pass.\n- [ ] 3.2 Run \`greenroom cleanup verify ${batch.id}\` and verify the campaign reports \`ok: true\`.\n- [ ] 3.3 Run \`greenroom check\` and verify zero new entropy is introduced.\n`;
}

function openspecExecutable(root) {
  const local = path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'openspec.cmd' : 'openspec');
  if (fs.existsSync(local)) return local;
  return 'openspec';
}

function validateChange(root, name) {
  const command = openspecExecutable(root);
  const probe = spawnSync(command, ['--version'], { cwd: root, encoding: 'utf8', shell: false, timeout: 10000 });
  if (probe.error?.code === 'ENOENT') return { installed: false, validated: false, command: null, output: '' };
  if (probe.error || probe.status !== 0) return { installed: false, validated: false, command, output: String(probe.stderr || probe.stdout || probe.error?.message || '').trim() };
  const result = spawnSync(command, ['validate', name, '--type', 'change', '--strict', '--no-interactive'], { cwd: root, encoding: 'utf8', shell: false, timeout: 30000 });
  return {
    installed: true,
    validated: result.status === 0,
    command,
    version: String(probe.stdout || probe.stderr || '').trim(),
    status: result.status,
    output: `${String(result.stdout || '').trim()}${result.stderr ? `\n${String(result.stderr).trim()}` : ''}`.trim()
  };
}

export function exportCampaignToOpenSpec(root, id, { name = '', validate = true } = {}) {
  const found = findCampaign(root, id);
  if (!found) throw new Error(`Cleanup campaign not found: ${id}`);
  const openspecRoot = path.join(root, 'openspec');
  if (!fs.existsSync(openspecRoot) || !fs.statSync(openspecRoot).isDirectory()) {
    throw new Error('OpenSpec is not initialized in this repository. Run `openspec init` first, then re-run the export.');
  }

  const changeName = kebab(name || `greenroom-${id}`);
  const changesRoot = path.join(openspecRoot, 'changes');
  const changeDir = path.join(changesRoot, changeName);
  if (fs.existsSync(changeDir)) throw new Error(`OpenSpec change already exists: openspec/changes/${changeName}`);

  fs.mkdirSync(changeDir, { recursive: true });
  try {
    // OpenSpec requires a plain YYYY-MM-DD date. A full ISO timestamp makes the
    // metadata invalid, which silently disables the skip_specs marker and makes
    // every generated change fail validation.
    const created = new Date().toISOString().slice(0, 10);
    writeText(path.join(changeDir, '.openspec.yaml'), `schema: spec-driven\ncreated: ${created}\nskip_specs: true\n`);
    writeText(path.join(changeDir, 'proposal.md'), renderProposal(found));
    writeText(path.join(changeDir, 'design.md'), renderDesign(found));
    writeText(path.join(changeDir, 'tasks.md'), renderTasks(found));

    const validation = validate ? validateChange(root, changeName) : { installed: false, validated: false, skipped: true };
    if (validation.installed && !validation.validated) {
      fs.rmSync(changeDir, { recursive: true, force: true });
      throw new Error(`OpenSpec rejected the generated change. Nothing was kept.\n${validation.output || 'Validation failed without output.'}`);
    }
    return {
      changeName,
      path: `openspec/changes/${changeName}`,
      campaign: id,
      skipSpecs: true,
      validation
    };
  } catch (error) {
    if (fs.existsSync(changeDir)) fs.rmSync(changeDir, { recursive: true, force: true });
    throw error;
  }
}
