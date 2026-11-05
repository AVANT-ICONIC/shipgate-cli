import type { Command } from "commander";
import { runCleanroomCli } from "../policies/cleanroom/cli.js";

/**
 * Spec issue #1 step 5: Commander boundary over the Cleanroom policy
 * dispatcher. The boundary is the ONLY place allowed to terminate the
 * process, and it does so by assigning `process.exitCode` -- never by
 * calling the runtime terminator directly -- so the gate keeps working when
 * ShipGate runs embedded in a host process (MCP server, tests, other CLIs).
 * All 40 legacy executable exit sites now return from the dispatcher instead.
 *
 * The `cleanroom` subcommand is a strict passthrough proxy:
 * - `enablePositionalOptions` on the program and the `policy` parent stops
 *   ancestor commands from consuming tokens meant for the dispatcher (the
 *   host `--version` option would otherwise swallow `policy cleanroom
 *   --version` before it reaches this command).
 * - `passThroughOptions` preserves the exact token order after the first
 *   operand, because the ported legacy argv parser depends on it.
 * - `helpOption(false)` disables the generated help option here so `--help`
 *   and `-h` reach the dispatcher like the legacy cli, instead of printing
 *   generic usage and terminating the host process.
 * The dispatcher result's stdout/stderr are written verbatim; `error` is a
 * programmatic diagnostic already reflected in stderr, never appended again.
 */
export function registerPolicyCommand(program: Command): void {
  program.enablePositionalOptions();
  const policy = program
    .command("policy")
    .description("Run a ported repository policy pack.")
    .enablePositionalOptions();

  policy
    .command("cleanroom")
    .description("Run the ported Cleanroom anti-entropy policy pack.")
    .helpOption(false)
    .allowUnknownOption(true)
    .allowExcessArguments(true)
    .passThroughOptions(true)
    .argument("[args...]", "arguments passed through to the policy dispatcher")
    .action((args: string[]) => {
      const result = runCleanroomCli(args, { cwd: process.cwd() });
      if (result.stdout.length > 0) process.stdout.write(result.stdout);
      if (result.stderr.length > 0) process.stderr.write(result.stderr);
      process.exitCode = result.exitCode;
    });
}
