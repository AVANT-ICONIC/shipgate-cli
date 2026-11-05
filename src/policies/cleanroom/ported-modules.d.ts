declare module "./scanner.mjs" { export function scan(root: string, config: unknown, options?: unknown): unknown; }
declare module "./check.mjs" { export function evaluateCheck(root: string, options?: { explicitCompareRef?: string | null }): unknown; }
declare module "./baseline.mjs" { export function loadBaseline(root: string, config: unknown): unknown; export function makeBaseline(root: string, config: unknown, result: unknown): unknown; }
declare module "./waivers.mjs" { export function loadWaivers(root: string, config: unknown): unknown; }
declare module "./register.mjs" { export function registerCanonical(root: string, config: unknown, args: unknown): unknown; }
declare module "./plan.mjs" { export function planCleanup(root: string, result: unknown, options?: unknown): unknown; }
declare module "./providers/index.mjs" { export function scanProviders(root: string, config: unknown, options?: unknown): unknown; }
declare module "*/cleanroom/check.mjs" { export function evaluateCheck(root: string, options?: { explicitCompareRef?: string | null }): unknown; }
declare module "*/cleanroom/config.mjs" { export function loadConfig(root: string): unknown; }
declare module "*/cleanroom/init.mjs" { export function initialize(root: string, options?: { existing?: boolean }): unknown; }
declare module "*/cleanroom/scanner.mjs" { export function scan(root: string, config: unknown, options?: unknown): unknown; }
declare module "*/cleanroom/report.mjs" { export function auditText(result: unknown, options?: { waived?: unknown[]; expired?: unknown[] }): string; }
declare module "*/cleanroom/baseline.mjs" { export function loadBaseline(root: string, config: unknown): unknown; export function makeBaseline(root: string, config: unknown, result: unknown): unknown; }
declare module "*/cleanroom/lib/fs.mjs" { export function sourceFiles(root: string, config: unknown): unknown; }
declare module "*/cleanroom/doctor.mjs" { export function doctor(query: string, root: string, config: unknown, scanResult: unknown, files: unknown): unknown; export function doctorText(result: unknown): string; }
declare module "*/cleanroom/plan.mjs" {
  export function createPlan(result: unknown, options?: { batchSize?: number; root?: string }): unknown;
  export function writePlan(root: string, plan: unknown): unknown;
  export function nextCleanupBatch(plan: unknown): unknown;
  export function verifyCampaign(root: string, config: unknown, id: string, options?: { runCommands?: boolean }): unknown;
  export function approveCampaign(root: string, id: string, options?: { owner?: string | null; reason?: string | null; canonicalDecision?: string; behaviorMustSurvive?: string[] }): unknown;
}
declare module "*/cleanroom/register.mjs" { export function registerCanonical(root: string, config: unknown, kind: string, name: string, canonical: string, aliases?: string[], options?: { allowMissing?: boolean; metadata?: Record<string, unknown> }): unknown; }
declare module "*/cleanroom/waivers.mjs" {
  export function loadWaivers(root: string, config: unknown): unknown;
  export function applyWaivers(violations: unknown, waiverData: unknown): unknown;
  export function addWaiver(root: string, config: unknown, violation: unknown, options: { reason?: string | null; owner?: string; expiresAt?: string }): unknown;
  export function removeWaiver(root: string, config: unknown, id: string): unknown;
}
declare module "*/cleanroom/providers/index.mjs" { export function scanProviders(root: string, config: unknown, options?: { only?: string[] | null }): unknown; }
declare module "*/cleanroom/analyzers/registry.mjs" { export function responsibilityMap(root: string, config: unknown): unknown; }
declare module "*/cleanroom/openspec.mjs" { export function exportCampaignToOpenSpec(root: string, id: string, options?: { name?: string; validate?: boolean }): unknown; }
