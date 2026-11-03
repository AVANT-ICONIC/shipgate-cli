declare module "./scanner.mjs" { export function scan(root: string, config: unknown, options?: unknown): unknown; }
declare module "./check.mjs" { export function evaluateCheck(root: string, options?: { explicitCompareRef?: string | null }): unknown; }
declare module "./baseline.mjs" { export function loadBaseline(root: string, config: unknown): unknown; export function makeBaseline(root: string, config: unknown, result: unknown): unknown; }
declare module "./waivers.mjs" { export function loadWaivers(root: string, config: unknown): unknown; }
declare module "./register.mjs" { export function registerCanonical(root: string, config: unknown, args: unknown): unknown; }
declare module "./plan.mjs" { export function planCleanup(root: string, result: unknown, options?: unknown): unknown; }
declare module "./providers/index.mjs" { export function scanProviders(root: string, config: unknown, options?: unknown): unknown; }
