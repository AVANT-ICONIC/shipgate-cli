// Boundary declarations for the ported Cleanroom .mjs modules consumed by the
// dual-mode state tests. The ported subtree is deliberately excluded from tsc;
// these wildcard shims type only what the tests call, for any importer path.
declare module "*/cleanroom/init.mjs" {
  export function initialize(root: string, options?: { existing?: boolean }): unknown;
}
declare module "*/cleanroom/config.mjs" {
  export function loadConfig(root: string): unknown;
  export function configPath(root: string): string;
}
declare module "*/cleanroom/baseline.mjs" {
  export function loadBaseline(root: string, config: unknown): unknown;
  export function makeBaseline(root: string, config: unknown, result: unknown): unknown;
}
declare module "*/cleanroom/waivers.mjs" {
  export function loadWaivers(root: string, config: unknown): unknown;
  export function waiversHash(root: string, config: unknown): string;
  export function addWaiver(
    root: string,
    config: unknown,
    violation: { id: string; rule: string; paths: string[] },
    options: { reason: string; owner?: string; expiresAt?: string },
  ): unknown;
}
declare module "*/cleanroom/analyzers/registry.mjs" {
  export function loadRegistry(root: string, config: unknown): unknown;
}
declare module "*/cleanroom/analyzers/generated.mjs" {
  export function loadGeneratedRegistry(root: string, config: unknown): unknown;
}
declare module "*/cleanroom/integrity.mjs" {
  export function policyHash(root: string): string;
  export function registryHash(root: string, config: unknown): string;
  export function generatedHash(root: string, config: unknown): string;
}
declare module "*/cleanroom/scanner.mjs" {
  export function scan(root: string, config: unknown, options?: unknown): unknown;
}
declare module "*/cleanroom/check.mjs" {
  export function evaluateCheck(root: string, options?: { explicitCompareRef?: string | null }): unknown;
}
