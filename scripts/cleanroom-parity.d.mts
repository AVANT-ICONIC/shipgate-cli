export function canonicalize(value: unknown, roots?: string[], key?: string): unknown;
export function compareRuns(
  legacy: { exitCode: number | null; json: unknown },
  shipgate: { exitCode: number | null; json: unknown },
  roots?: string[]
): { legacy: unknown; shipgate: unknown; legacyDigest: string; shipgateDigest: string; equal: boolean };
export function runCli(cli: string, repo: string, ref: string): {
  exitCode: number | null; stdout: string; stderr: string; json: Record<string, unknown>; compareRef: string | null;
};
export function runParity(options: {
  repo: string; legacyCli: string; shipgateCli: string; ref: string; output: string;
}): unknown;
