// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Exit-code-collecting dispatcher for `shipgate policy cleanroom` (spec
 * Step 5). Ports every legacy `greenroom` cli.mjs branch; each branch
 * RETURNS `{ exitCode, stdout, stderr }` instead of calling
 * process exit. Only the command boundary (src/commands/policy.ts)
 * converts the result into process state, and nothing here writes to the
 * console, so `--json` stdout stays pure and the process always ends
 * naturally (spec section 2.2 zero-exit rule).
 *
 * Argument parsing reproduces the legacy option/flag/positional semantics
 * exactly so the table-driven parity tests can drive this dispatcher and
 * the legacy cli.mjs with the same argv.
 */
import path from "node:path";
import fs from "node:fs";
import { loadConfig } from "../cleanroom/config.mjs";
import { initialize } from "../cleanroom/init.mjs";
import { scan } from "../cleanroom/scanner.mjs";
import { auditText } from "../cleanroom/report.mjs";
import { makeBaseline, loadBaseline } from "../cleanroom/baseline.mjs";
import { sourceFiles } from "../cleanroom/lib/fs.mjs";
import { doctor, doctorText } from "../cleanroom/doctor.mjs";
import { createPlan, writePlan, nextCleanupBatch, verifyCampaign, approveCampaign } from "../cleanroom/plan.mjs";
import { registerCanonical } from "../cleanroom/register.mjs";
import { loadWaivers, applyWaivers, addWaiver, removeWaiver } from "../cleanroom/waivers.mjs";
import { evaluateCheck } from "../cleanroom/check.mjs";
import { scanProviders } from "../cleanroom/providers/index.mjs";
import { responsibilityMap } from "../cleanroom/analyzers/registry.mjs";
import { exportCampaignToOpenSpec } from "../cleanroom/openspec.mjs";
import { resolveStatePath } from "./paths.js";

/**
 * The Cleanroom behavior version this pack ports (issue #1: "Move all
 * Cleanroom 1.1.0 behavior into ShipGate"). Pinned to the parity-manifest
 * source, AVANT-ICONIC/cleanroom 3da8cf6c73bce533e4d1b08e97b7e3992da31927,
 * whose package version is 1.1.0 - read there, not retyped from ShipGate's
 * own package version.
 */
export const CLEANROOM_POLICY_VERSION = "1.1.0";

export type CleanroomCliResult = {
  exitCode: 0 | 1 | 2;
  stdout: string;
  stderr: string;
  error?: string;
};

const VALUE_OPTIONS = ["root", "against", "reason", "owner", "expires", "alias", "batch-size", "provider", "entrypoint", "test", "replace", "forbid", "status", "canonical", "preserve", "doc", "generated", "caller", "directory", "history", "name"];

class ParsedArgs {
  constructor(private readonly args: string[]) {}
  option(name: string, fallback: string | null = null): string | null {
    const eq = this.args.find((x) => x.startsWith(`--${name}=`));
    if (eq) return eq.slice(name.length + 3);
    const index = this.args.indexOf(`--${name}`);
    if (index >= 0 && this.args[index + 1] && !this.args[index + 1]!.startsWith("--")) return this.args[index + 1]!;
    return fallback;
  }
  flag(name: string): boolean {
    return this.args.includes(`--${name}`);
  }
  positional(start = 1): string[] {
    const out: string[] = [];
    for (let i = start; i < this.args.length; i++) {
      const arg = this.args[i]!;
      if (arg.startsWith("--")) {
        if (!arg.includes("=") && this.args[i + 1] && !this.args[i + 1]!.startsWith("--") && VALUE_OPTIONS.includes(arg.slice(2))) i++;
        continue;
      }
      out.push(arg);
    }
    return out;
  }
}

function jsonText(value: unknown): string {
  return JSON.stringify(value, (_k, v) => v instanceof Map
    ? Object.fromEntries([...v].map(([k, s]) => [k, s instanceof Set ? [...s] : s]))
    : v instanceof Set ? [...v] : v, 2) + "\n";
}

const line = (text: string) => `${text}\n`;

export function cleanroomHelpText(): string {
  return `ShipGate Cleanroom policy ${CLEANROOM_POLICY_VERSION} — repository anti-entropy control plane

Commands:
  shipgate policy cleanroom init [--existing] [--baseline]
  shipgate policy cleanroom audit [--provider=fallow|knip|project-native] [--json]
  shipgate policy cleanroom providers [--provider=fallow|knip|project-native] [--json]
  shipgate policy cleanroom baseline [--force --reason="..."]
  shipgate policy cleanroom check [--against=<git-ref>] [--json]
  shipgate policy cleanroom doctor "task" [--json]
  shipgate policy cleanroom find "query" [--json]
  shipgate policy cleanroom explain <finding-id> [--json]
  shipgate policy cleanroom responsibility list [--json]
  shipgate policy cleanroom responsibility show <id> [--json]
  shipgate policy cleanroom register <responsibility|component> <name> <path> [--alias=a,b] [--owner=x]
  shipgate policy cleanroom clean [--batch-size=12] [--json]
  shipgate policy cleanroom cleanup plan [--batch-size=12] [--json]
  shipgate policy cleanroom cleanup approve <campaign-id> --owner=x --reason="..." [--canonical=path|none] [--preserve=a,b]
  shipgate policy cleanroom cleanup verify <campaign-id> [--no-run] [--json]
  shipgate policy cleanroom cleanup openspec <campaign-id> [--name=change-name] [--no-validate] [--json]
  shipgate policy cleanroom next [--batch-size=12] [--json]
  shipgate policy cleanroom waive <violation-id> --reason="..." --owner=name --expires=YYYY-MM-DD
  shipgate policy cleanroom unwaive <violation-id>
  shipgate policy cleanroom version

Options:
  --root=/path/to/repo
  --json

Exit codes:
  0 success / entropy gate pass
  1 entropy gate blocked
  2 invalid usage, configuration, or missing adoption baseline

`;
}

function appendGovernanceLog(root: string, entry: Record<string, unknown>): void {
  const file = resolveStatePath(root, ".greenroom/governance.jsonl");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n");
}

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

export function runCleanroomCli(args: string[], env: { cwd: string }): CleanroomCliResult {
  const parsed = new ParsedArgs(args);
  const command = args[0] || "help";
  const root = path.resolve(env.cwd, parsed.option("root", env.cwd) ?? env.cwd);
  const json = parsed.flag("json");
  let stdout = "";
  let stderr = "";
  const out = (text: string) => { stdout += line(text); };
  const outRaw = (text: string) => { stdout += text; };
  const err = (text: string) => { stderr += line(text); };
  const done = (exitCode: 0 | 1 | 2, error?: string): CleanroomCliResult => ({ exitCode, stdout, stderr, ...(error ? { error } : {}) });

  try {
    if (command === "help" || command === "--help" || command === "-h") {
      outRaw(cleanroomHelpText());
      return done(0);
    }
    if (command === "version" || command === "--version" || command === "-v") {
      out(CLEANROOM_POLICY_VERSION);
      return done(0);
    }

    if (command === "init") {
      const existing = parsed.flag("existing");
      const r = initialize(root, { existing }) as Any;
      out(`Green Room initialized in ${root}`);
      for (const x of r.created as string[]) out(`  + ${x}`);
      for (const x of r.updated as string[]) out(`  ~ ${x}`);
      if (!(r.created as string[]).length && !(r.updated as string[]).length) out("  ✓ managed files already current");
      const config = loadConfig(root) as Any;
      const baseline = loadBaseline(root, config);
      if (!baseline && existing && !parsed.flag("baseline")) {
        out("  ! Brownfield mode: baseline intentionally not created. Tune policy, run `shipgate policy cleanroom audit`, register canonical paths, then run `shipgate policy cleanroom baseline`.");
        return done(0);
      }
      if (!baseline) {
        const initial = scan(root, config) as Any;
        if (!existing && (initial.violations as unknown[]).length) {
          err("\nGreenfield initialization found existing entropy and will not grandfather it automatically.");
          err(auditText(initial));
          err("\nFix these violations, or re-run `shipgate policy cleanroom init --existing` if this is actually a brownfield repository.");
          return done(1);
        }
        const b = makeBaseline(root, config, initial) as Any;
        out(`  ✓ adoption baseline created (${(b.violations as unknown[]).length} violation(s) grandfathered)`);
      }
      return done(0);
    }

    const config = loadConfig(root) as Any;
    const providerOpt = parsed.option("provider");
    if (providerOpt && !["fallow", "knip", "project-native"].includes(providerOpt)) throw new Error(`Unknown provider: ${providerOpt}`);
    const includeProviders = ["audit", "clean", "plan", "next", "cleanup", "explain"].includes(command);
    const result = scan(root, config, { includeProviders, onlyProviders: providerOpt ? [providerOpt] : null }) as Any;

    if (command === "providers") {
      const p = scanProviders(root, config, { only: providerOpt ? [providerOpt] : null }) as Any;
      if (json) outRaw(jsonText(p));
      else {
        out("GREEN ROOM PROVIDERS\n" + "=".repeat(64));
        for (const item of p.statuses as Any[]) out(`  ${String(item.provider).padEnd(14)} ${String(item.status).padEnd(12)} findings=${item.findings || 0}  capabilities=${(item.capabilities || []).join(",")}${item.command ? `  command=${item.command}` : ""}`);
      }
      return done(0);
    }

    if (command === "audit") {
      const applied = applyWaivers(result.violations, loadWaivers(root, config)) as Any;
      if (json) outRaw(jsonText({ ...result, waivers: { active: applied.waived, expired: applied.expired } }));
      else outRaw(auditText(result, { waived: applied.waived, expired: applied.expired }) + "\n");
      return done(0);
    }

    if (command === "baseline") {
      const existingBaseline = loadBaseline(root, config);
      if (existingBaseline && !parsed.flag("force")) {
        err("A baseline already exists. Routine work must not re-baseline. Intentional governance updates require `shipgate policy cleanroom baseline --force --reason=\"...\"`.");
        return done(2);
      }
      if (existingBaseline && parsed.flag("force") && !parsed.option("reason")) {
        err("Forced re-baselining requires --reason=\"...\" so the governance change is auditable.");
        return done(2);
      }
      const b = makeBaseline(root, config, result) as Any;
      if (existingBaseline) appendGovernanceLog(root, { action: "rebaseline", reason: parsed.option("reason"), beforeEntropy: (existingBaseline as Any).entropy, afterEntropy: b.entropy });
      out(`Baseline saved: ${config.baselineFile}\n${(b.violations as unknown[]).length} existing violation(s) grandfathered.\nRoutine changes may introduce 0 new violations.`);
      return done(0);
    }

    if (command === "check") {
      const evaluated = evaluateCheck(root, { explicitCompareRef: parsed.option("against") }) as Any;
      if (evaluated.error) {
        err(String(evaluated.error));
        return done(evaluated.exitCode, String(evaluated.error));
      }
      if (json) outRaw(jsonText(evaluated)); else outRaw(`${evaluated.text}\n`);
      return done(evaluated.exitCode);
    }

    if (command === "register") {
      const [kind, name, canonical] = parsed.positional(1);
      if (!kind || !name || !canonical) {
        err("Usage: shipgate policy cleanroom register <responsibility|component> <name> <path> [--alias=a,b] [--allow-missing]");
        return done(2);
      }
      const split = (opt: string) => String(parsed.option(opt, "")).split(",").map((x) => x.trim()).filter(Boolean);
      const metadata = { owner: parsed.option("owner", ""), status: parsed.option("status", ""), entrypoints: split("entrypoint"), tests: split("test"), docs: split("doc"), generated: split("generated"), replaces: split("replace"), allowedCallers: split("caller"), allowedDirectories: split("directory"), forbiddenPatterns: split("forbid"), cleanupHistory: split("history") };
      const value = registerCanonical(root, config, kind, name, canonical, split("alias"), { allowMissing: parsed.flag("allow-missing"), metadata }) as Any;
      out(`Registered ${kind} ${name} -> ${value.canonical}`);
      if (loadBaseline(root, config)) out("This modifies the canonical architecture registry after adoption and therefore requires a human governance PR.");
      return done(0);
    }

    if (command === "responsibility") {
      const [sub, name] = parsed.positional(1);
      const map = responsibilityMap(root, config) as Record<string, Any>;
      if (sub === "list") {
        const values = Object.values(map).sort((a, b) => String(a.name).localeCompare(String(b.name)));
        if (json) outRaw(jsonText(values));
        else {
          out("GREEN ROOM RESPONSIBILITIES\n" + "=".repeat(64));
          if (!values.length) out("  (none registered)");
          for (const r of values) out(`  ${r.name} -> ${(r.canonical as string[]).join(", ") || "(unknown)"}${r.owner ? `  owner=${r.owner}` : ""}`);
        }
        return done(0);
      }
      if (sub === "show" && name) {
        const r = map[name];
        if (!r) {
          err(`Unknown responsibility: ${name}`);
          return done(2);
        }
        if (json) outRaw(jsonText(r)); else out(JSON.stringify(r, null, 2));
        return done(0);
      }
      err("Usage: shipgate policy cleanroom responsibility list | shipgate policy cleanroom responsibility show <id>");
      return done(2);
    }

    if (command === "explain") {
      const id = parsed.positional(1)[0];
      if (!id) {
        err("Usage: shipgate policy cleanroom explain <finding-id>");
        return done(2);
      }
      const item = (result.findings as Any[] | undefined)?.find((x) => x.id === id) || (result.violations as Any[]).find((x) => x.id === id);
      if (!item) {
        err(`Finding not found: ${id}`);
        return done(2);
      }
      if (json) outRaw(jsonText(item)); else out(JSON.stringify(item, null, 2));
      return done(0);
    }

    if (command === "doctor" || command === "find") {
      const query = parsed.positional(1).join(" ").trim();
      if (!query) {
        err(`Usage: shipgate policy cleanroom ${command} "task description"`);
        return done(2);
      }
      const r = doctor(query, root, config, result, sourceFiles(root, config));
      if (json) outRaw(jsonText(r)); else out(doctorText(r));
      return done(0);
    }

    if (command === "cleanup" && parsed.positional(1)[0] === "approve") {
      const campaignId = parsed.positional(1)[1];
      if (!campaignId) {
        err("Usage: shipgate policy cleanroom cleanup approve <campaign-id> --owner=x --reason=\"...\" [--canonical=path|none] [--preserve=a,b]");
        return done(2);
      }
      const preserve = String(parsed.option("preserve", "")).split(",").map((x) => x.trim()).filter(Boolean);
      const approved = approveCampaign(root, campaignId, { owner: parsed.option("owner"), reason: parsed.option("reason"), canonicalDecision: parsed.option("canonical", "") ?? "", behaviorMustSurvive: preserve }) as Any;
      out(`Cleanup campaign approved: ${approved.id} by ${approved.approval.owner}`);
      return done(0);
    }

    if (command === "cleanup" && parsed.positional(1)[0] === "verify") {
      const campaignId = parsed.positional(1)[1];
      if (!campaignId) {
        err("Usage: shipgate policy cleanroom cleanup verify <campaign-id> [--no-run]");
        return done(2);
      }
      const verified = verifyCampaign(root, config, campaignId, { runCommands: !parsed.flag("no-run") }) as Any;
      if (json) outRaw(jsonText(verified)); else out(JSON.stringify(verified, null, 2));
      return done(verified.ok ? 0 : 1);
    }

    if (command === "cleanup" && parsed.positional(1)[0] === "openspec") {
      const campaignId = parsed.positional(1)[1];
      if (!campaignId) {
        err("Usage: shipgate policy cleanroom cleanup openspec <campaign-id> [--name=change-name] [--no-validate]");
        return done(2);
      }
      const exported = exportCampaignToOpenSpec(root, campaignId, { name: parsed.option("name", "") ?? "", validate: !parsed.flag("no-validate") }) as Any;
      if (json) outRaw(jsonText(exported));
      else {
        out(`OpenSpec cleanup change created: ${exported.path}`);
        if (exported.validation?.installed) out(`OpenSpec validation: ${exported.validation.validated ? "PASS" : "FAIL"} (${exported.validation.version || "version unknown"})`);
        else if (exported.validation?.skipped) out("OpenSpec validation: skipped by --no-validate");
        else out("OpenSpec validation: OpenSpec CLI not installed; generated artifacts were not externally validated.");
        out("This bridge is for behavior-preserving cleanup. If cleanup changes product behavior, author real OpenSpec delta specs instead of using skip_specs.");
      }
      return done(0);
    }

    if (command === "clean" || command === "plan" || command === "next" || (command === "cleanup" && parsed.positional(1)[0] === "plan")) {
      const batchSize = Number.parseInt(parsed.option("batch-size", "12") ?? "12", 10);
      if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 100) {
        err("--batch-size must be an integer from 1 to 100");
        return done(2);
      }
      const p = createPlan(result, { batchSize, root }) as Any;
      if (command === "next") {
        const next = nextCleanupBatch(p) as Any;
        if (json) outRaw(jsonText(next || { clean: true }));
        else if (!next) out("✓ No cleanup batch. The configured audit is clean.");
        else out(`GREEN ROOM NEXT CLEANUP BATCH\n${"=".repeat(64)}\n${next.phase.title}\n${next.batch.id}\n\n${next.batch.goal}\n\nPaths:\n${(next.batch.paths as string[]).map((x) => `  - ${x}`).join("\n")}\n\nViolations:\n${(next.batch.items as Any[]).map((x) => `  - [${x.id}] ${x.message}`).join("\n")}\n\nDefinition of done:\n${(next.batch.definitionOfDone as string[]).map((x) => `  - ${x}`).join("\n")}`);
        return done(0);
      }
      writePlan(root, p);
      if (json) outRaw(jsonText(p));
      else out(`Cleanup campaign written:\n  .greenroom/cleanup-plan.md\n  .greenroom/cleanup-plan.json\n\n${p.phases.length} phases · ${p.totalViolations} violations · entropy ${p.entropy}\nNo source files were modified.`);
      return done(0);
    }

    if (command === "waive") {
      const id = parsed.positional(1)[0];
      if (!id) {
        err("Usage: shipgate policy cleanroom waive <violation-id> --reason=\"...\" --owner=name --expires=YYYY-MM-DD");
        return done(2);
      }
      const target = (result.violations as Any[]).find((v) => v.id === id);
      if (!target) {
        err(`Violation not found in current audit: ${id}`);
        return done(2);
      }
      const waiver = addWaiver(root, config, target, { reason: parsed.option("reason"), owner: parsed.option("owner", "") ?? "", expiresAt: parsed.option("expires", "") ?? "" }) as Any;
      appendGovernanceLog(root, { action: "waive", id, rule: target.rule, reason: waiver.reason, owner: waiver.owner, expiresAt: waiver.expiresAt || null });
      out(`Waiver recorded for ${id}.\nThis is a governance change. CI will reject it unless GREENROOM_ALLOW_GOVERNANCE_UPDATE=1 is explicitly enabled for the governance PR, and the adoption baseline governance hashes are updated.`);
      return done(0);
    }

    if (command === "unwaive") {
      const id = parsed.positional(1)[0];
      if (!id) {
        err("Usage: shipgate policy cleanroom unwaive <violation-id>");
        return done(2);
      }
      const removed = removeWaiver(root, config, id);
      if (!removed) {
        err(`No waiver found for ${id}`);
        return done(2);
      }
      appendGovernanceLog(root, { action: "unwaive", id });
      out(`Waiver removed: ${id}`);
      return done(0);
    }

    outRaw(cleanroomHelpText());
    return done(2);
  } catch (error) {
    const message = error instanceof Error ? (error.stack || error.message) : String(error);
    stderr += line(`Green Room failed: ${message}`);
    return { exitCode: 2, stdout, stderr, error: message };
  }
}
