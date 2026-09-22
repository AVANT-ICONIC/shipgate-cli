// SPDX-License-Identifier: AGPL-3.0-or-later
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { writeJson, writeText, readJsonStrict, readJson } from './lib/fs.mjs';
import { groupByRule } from './report.mjs';
import { scan } from './scanner.mjs';
import { evaluateCheck } from './check.mjs';

const ORDER = [
  'policy/managed-file', 'registry/missing-canonical', 'architecture/cycle', 'architecture/stranded-feature',
  'architecture/competing-responsibility', 'architecture/trivial-wrapper', 'scripts/chain', 'scripts/unowned',
  'duplication/file', 'duplication/block', 'registry/noncanonical-component', 'registry/duplicate-responsibility',
  'generated/missing', 'generated/stale', 'architecture/unreachable', 'design/raw-color', 'design/important',
  'design/raw-radius', 'design/raw-spacing', 'design/raw-typography', 'naming/suspicious'
];
const LABELS = {
  'policy/managed-file': 'Restore repository guardrails',
  'registry/missing-canonical': 'Repair canonical registry paths',
  'architecture/cycle': 'Break dependency cycles',
  'architecture/stranded-feature': 'Wire or remove stranded implementations',
  'architecture/competing-responsibility': 'Resolve competing implementations',
  'architecture/trivial-wrapper': 'Remove needless wrapper layers',
  'scripts/chain': 'Collapse script chains',
  'scripts/unowned': 'Assign or remove unowned scripts',
  'duplication/file': 'Consolidate duplicate files',
  'duplication/block': 'Consolidate duplicated implementations',
  'registry/noncanonical-component': 'Consolidate UI primitives into canonical components',
  'registry/duplicate-responsibility': 'Repair canonical registry',
  'generated/missing': 'Restore generated artifacts from canonical sources',
  'generated/stale': 'Regenerate stale artifacts',
  'architecture/unreachable': 'Remove or reconnect unreachable code',
  'design/raw-color': 'Migrate raw colors to design tokens',
  'design/important': 'Remove CSS escalation',
  'design/raw-radius': 'Migrate radius values to tokens',
  'design/raw-spacing': 'Migrate spacing values to design tokens',
  'design/raw-typography': 'Migrate typography values to design tokens',
  'naming/suspicious': 'Resolve versioned/fix/temporary files'
};
const GOALS = {
  'architecture/cycle': 'Choose the correct ownership direction, move shared behavior to the owning module, then remove the reverse dependency.',
  'architecture/stranded-feature': 'Decide whether the behavior belongs in production. If yes, wire it through the canonical production path. If no, prove it is safe to delete.',
  'architecture/competing-responsibility': 'Choose the canonical owner using callers, tests, behavior and registry evidence. Migrate callers and delete superseded implementations.',
  'architecture/trivial-wrapper': 'Remove the extra navigation layer or make the module own meaningful behavior. Preserve intentional public facades only through an explicit allow rule.',
  'scripts/chain': 'Move orchestration into one canonical entry point or reusable library code; delete patch scripts and migrate callers.',
  'scripts/unowned': 'Map this script to a durable repository responsibility or remove it. Scripts may not live as unowned permanent repair debris.',
  'duplication/file': 'Choose one canonical implementation, migrate every caller, then delete the duplicate files.',
  'duplication/block': 'Consolidate shared behavior only where the responsibilities are truly the same; prefer deleting duplicate implementation over adding wrappers.',
  'registry/noncanonical-component': 'Use the registered design-system primitive, migrate callers, and remove the parallel primitive.',
  'generated/stale': 'Regenerate from declared canonical sources. Never hand-edit generated output to silence the finding.',
  'generated/missing': 'Regenerate from declared canonical sources and verify the regeneration command is deterministic.',
  'design/raw-color': 'Replace raw values with an existing semantic token; add a token only when the design system genuinely lacks the concept.',
  'naming/suspicious': 'Determine whether this is a duplicate/replacement. Rename only if it is canonical; otherwise migrate callers and delete it.'
};

function chunk(items, size) { const out=[]; for (let i=0;i<items.length;i+=size) out.push(items.slice(i,i+size)); return out; }
function gitHead(root) { try { return execFileSync('git',['-C',root,'rev-parse','HEAD'],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim(); } catch { return null; } }
function reverseGraph(graph = new Map()) {
  const reverse=new Map(); for (const node of graph.keys()) reverse.set(node,new Set());
  for (const [from,deps] of graph) for (const dep of deps) { if(!reverse.has(dep)) reverse.set(dep,new Set()); reverse.get(dep).add(from); }
  return reverse;
}
function verificationCommands(root) {
  const pkg = readJson(path.join(root,'package.json'), null);
  const scripts = pkg?.scripts || {};
  const commands=[];
  if (scripts.test) commands.push({ id:'test', command:'npm', args:['test'], required:true });
  if (scripts.typecheck) commands.push({ id:'typecheck', command:'npm', args:['run','typecheck'], required:true });
  if (scripts.build) commands.push({ id:'build', command:'npm', args:['run','build'], required:true });
  return commands;
}
function needsApproval(rule) { return /duplicate|stranded|unreachable|competing|scripts\/chain|trivial-wrapper/.test(rule); }

export function createPlan(result, { batchSize = 12, root = process.cwd() } = {}) {
  const groups = groupByRule(result.violations);
  const phases = [];
  const reverse = reverseGraph(result.graph);
  const baseCommit = gitHead(root);
  const verify = verificationCommands(root);
  const orderedRules = [...ORDER, ...[...groups.keys()].filter((r) => !ORDER.includes(r)).sort()];
  for (const rule of orderedRules) {
    const items = groups.get(rule) || [];
    if (!items.length) continue;
    const batches = chunk(items, batchSize).map((batch, index) => {
      const paths=[...new Set(batch.flatMap((x) => x.paths))].sort();
      const evidenceFindings=(result.findings || []).filter((f) => f.scope?.files?.some((p) => paths.includes(p)));
      const callersBefore=Object.fromEntries(paths.map((p)=>[p,[...(reverse.get(p)||[])].sort()]));
      return {
        id: `${rule.replace(/[^a-z0-9]+/gi, '-')}-${index + 1}`,
        state: 'DETECTED',
        stateMachine: ['DETECTED','CORROBORATED','BLAST_RADIUS_MAPPED','CANONICALITY_CHECKED','BEHAVIOR_PRESERVATION_CHECKED','CLEANUP_PLAN_READY','APPROVED','MUTATED_IN_ISOLATION','VERIFIED','RATCHET_UPDATED'],
        index: index + 1,
        count: batch.length,
        baseCommit,
        paths,
        items: batch,
        findingIds: evidenceFindings.map((f)=>f.id),
        evidence: evidenceFindings,
        callersBefore,
        canonicalDecision: null,
        behaviorMustSurvive: [],
        plannedMutations: [],
        verificationCommands: verify,
        approval: { required: needsApproval(rule), status: needsApproval(rule) ? 'pending' : 'not-required' },
        ratchet: { targetViolationIds: batch.map((x)=>x.id), acceptOnlyAfterVerified: true },
        goal: GOALS[rule] || `Remove these ${rule} violations without introducing new Green Room violations.`,
        definitionOfDone: [
          'Target violation IDs no longer appear in `greenroom audit`.',
          'Production behavior that was explicitly declared to survive still works.',
          'All migrated callers use the canonical implementation.',
          'Superseded files/paths are deleted rather than wrapped indefinitely.',
          'Repository tests/typecheck/build pass where available.',
          '`greenroom check` passes with zero new entropy.'
        ]
      };
    });
    phases.push({ rule, title: LABELS[rule] || rule, count: items.length, batches });
  }

  const evidenceOnly = (result.findings || []).filter((f) => !String(f.id).startsWith('v-') && ['cleanup-candidate','human-review-required'].includes(f.action));
  if (evidenceOnly.length) {
    phases.push({
      rule: 'evidence/review-candidates', title: 'Review corroborated cleanup candidates', count: evidenceOnly.length,
      batches: chunk(evidenceOnly, batchSize).map((batch,index)=>({
        id:`evidence-review-${index+1}`, state:'DETECTED', stateMachine:['DETECTED','CORROBORATED','BLAST_RADIUS_MAPPED','CANONICALITY_CHECKED','BEHAVIOR_PRESERVATION_CHECKED','CLEANUP_PLAN_READY','APPROVED','MUTATED_IN_ISOLATION','VERIFIED','RATCHET_UPDATED'],
        index:index+1, count:batch.length, baseCommit, paths:[...new Set(batch.flatMap((x)=>x.scope?.files||[]))].sort(), items:[], findingIds:batch.map((x)=>x.id), evidence:batch,
        callersBefore:{}, canonicalDecision:null, behaviorMustSurvive:[], plannedMutations:[], verificationCommands:verify,
        approval:{required:true,status:'pending'}, ratchet:{targetViolationIds:[],acceptOnlyAfterVerified:true},
        goal:'Resolve suspicious canonicality/reachability evidence only after corroborating callers, production roots, tests and registry ownership.',
        definitionOfDone:['Canonicality is explicitly decided.','Deletion candidates have blast-radius evidence from more than one trustworthy signal where available.','Behavior preservation is verified.','`greenroom check` passes.']
      }))
    });
  }

  return { version: 2, generatedAt: new Date().toISOString(), baseCommit, totalViolations: result.violations.length, totalFindings: result.findings?.length || 0, entropy: result.entropy, corroboration: result.corroboration || [], phases };
}

export function nextCleanupBatch(plan) {
  for (const phase of plan.phases) if (phase.batches?.length) return { phase: { rule: phase.rule, title: phase.title }, batch: phase.batches[0] };
  return null;
}

export function writePlan(root, plan) {
  writeJson(path.join(root, '.greenroom/cleanup-plan.json'), plan);
  const md = ['# Green Room Cleanup Plan', '', `Base commit: **${plan.baseCommit || 'unavailable'}**`, `Current entropy: **${plan.entropy}**`, `Violations: **${plan.totalViolations}**`, `Evidence findings: **${plan.totalFindings || 0}**`, '', '> Generated evidence only. Clean one bounded batch at a time. No analyzer has mutation authority.', ''];
  plan.phases.forEach((p, i) => {
    md.push(`## Phase ${String(i+1).padStart(2,'0')} — ${p.title}`, '', `Rule: \`${p.rule}\` · ${p.count} item(s)`, '');
    for (const batch of p.batches) {
      md.push(`### Batch ${batch.index} — ${batch.id}`, '', `State: **${batch.state}**`, '', batch.goal, '', '**Affected paths**', '');
      for (const rel of batch.paths) md.push(`- \`${rel}\``);
      if (batch.items?.length) { md.push('', '**Blocking violations**', ''); for (const item of batch.items) md.push(`- [ ] **${item.id}** ${item.message}`); }
      if (batch.evidence?.length) { md.push('', '**Evidence**', ''); for (const item of batch.evidence.slice(0,20)) md.push(`- **${item.kind}** [${item.confidence}] ${item.message} (${item.id})`); }
      md.push('', '**Approval**', '', `- Required: ${batch.approval.required ? 'yes' : 'no'}`, `- Status: ${batch.approval.status}`, '', '**Definition of done**', '');
      for (const item of batch.definitionOfDone) md.push(`- ${item}`);
      md.push('');
    }
  });
  writeText(path.join(root, '.greenroom/cleanup-plan.md'), md.join('\n'));
}

export function findCampaign(root, id) {
  const plan=readJsonStrict(path.join(root,'.greenroom/cleanup-plan.json'),'.greenroom/cleanup-plan.json');
  for (const phase of plan.phases || []) for (const batch of phase.batches || []) if (batch.id===id) return { plan, phase, batch };
  return null;
}

export function approveCampaign(root, id, { owner, reason, canonicalDecision = '', behaviorMustSurvive = [] } = {}) {
  if (!owner?.trim()) throw new Error('Cleanup approval requires --owner="..."');
  if (!reason?.trim()) throw new Error('Cleanup approval requires --reason="..."');
  const found = findCampaign(root, id);
  if (!found) throw new Error(`Cleanup campaign not found: ${id}`);
  if (found.batch.approval?.required && !String(canonicalDecision || '').trim()) {
    throw new Error('Deletion-sensitive cleanup approval requires --canonical=<path|none>');
  }
  found.batch.canonicalDecision = String(canonicalDecision || found.batch.canonicalDecision || '').trim() || null;
  found.batch.behaviorMustSurvive = [...new Set((behaviorMustSurvive || []).filter(Boolean))].sort();
  found.batch.approval = {
    required: Boolean(found.batch.approval?.required),
    status: 'approved',
    owner: owner.trim(),
    reason: reason.trim(),
    approvedAt: new Date().toISOString()
  };
  found.batch.state = 'APPROVED';
  writePlan(root, found.plan);
  return found.batch;
}

export function verifyCampaign(root, config, id, { runCommands = true } = {}) {
  const found=findCampaign(root,id);
  if (!found) return { ok:false, error:`Cleanup campaign not found: ${id}` };
  const current=scan(root,config,{includeProviders:true});
  const currentIds=new Set(current.violations.map((x)=>x.id));
  const currentFindingIds=new Set(current.findings.map((x)=>x.id));
  const unresolved=(found.batch.ratchet?.targetViolationIds||[]).filter((x)=>currentIds.has(x));
  const unresolvedFindings=(found.batch.findingIds||[]).filter((x)=>currentFindingIds.has(x) && !(found.batch.ratchet?.targetViolationIds||[]).some((v)=>`v-${v}`===x));
  const approvalPending=Boolean(found.batch.approval?.required && found.batch.approval?.status!=='approved');
  const commandResults=[];
  if (runCommands && !unresolved.length && !unresolvedFindings.length && !approvalPending) {
    for (const cmd of found.batch.verificationCommands || []) {
      const r=spawnSync(cmd.command,cmd.args,{cwd:root,encoding:'utf8',shell:process.platform==='win32',env:process.env});
      commandResults.push({id:cmd.id,command:[cmd.command,...cmd.args].join(' '),status:r.status,passed:r.status===0,stdout:String(r.stdout||'').slice(-4000),stderr:String(r.stderr||'').slice(-4000)});
      if (cmd.required && r.status!==0) break;
    }
  }
  const gate = (unresolved.length || unresolvedFindings.length || approvalPending) ? null : evaluateCheck(root, {});
  const commandsPass=commandResults.every((x)=>x.passed);
  const ok=!unresolved.length && !unresolvedFindings.length && !approvalPending && commandsPass && (!gate || gate.exitCode===0);
  const ratchetDelta={removedViolationIds:(found.batch.ratchet?.targetViolationIds||[]).filter((x)=>!currentIds.has(x)),removedFindingIds:(found.batch.findingIds||[]).filter((x)=>!currentFindingIds.has(x))};
  const result={version:1,campaign:id,verifiedAt:new Date().toISOString(),baseCommit:found.batch.baseCommit||found.plan.baseCommit||null,ok,state:ok?'VERIFIED':'CLEANUP_PLAN_READY',approvalPending,unresolvedViolationIds:unresolved,unresolvedFindingIds:unresolvedFindings,commandResults,ratchetDelta,gate:gate?{exitCode:gate.exitCode,fresh:gate.fresh}:null};
  const dir=path.join(root,'.greenroom','campaigns'); fs.mkdirSync(dir,{recursive:true}); writeJson(path.join(dir,`${id}.json`),result);
  return result;
}
