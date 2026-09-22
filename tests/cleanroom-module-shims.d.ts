declare module "@avant-iconic/cleanroom/src/init.mjs" { export function initialize(root: string, options?: { existing?: boolean }): unknown; }
declare module "@avant-iconic/cleanroom/src/config.mjs" { export function loadConfig(root: string): unknown; }
declare module "@avant-iconic/cleanroom/src/scanner.mjs" { export function scan(root: string, config: unknown): unknown; }
declare module "@avant-iconic/cleanroom/src/baseline.mjs" { export function makeBaseline(root: string, config: unknown, result: unknown): unknown; }
