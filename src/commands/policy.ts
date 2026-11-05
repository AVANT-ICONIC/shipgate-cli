import type { Command } from "commander";
import { runCleanroomCli } from "../policies/cleanroom/cli.js";

/**
 * Spec issue #1 step 5: Commander boundary over the Cleanroom policy
 * dispatcher. The boundary is the ONLY place allowed to terminate the
 * process, and it does so by assigning `process.exitCode` -- never by
 * calling the runtime terminator directly -- so the gate keeps working when
 * ShipGate runs embedded in a host process (MCP server, tests, other CLIs).
 * All 41 legacy exit sites now return from the dispatcher instead.
 */
export function registerPolicyCommand(program: Command): void {
  const policy = program
    .command("policy")
    .description("Run a ported repository policy pack.");

  policy
    .command("cleanroom")
    .description("Run the ported Cleanroom anti-entropy policy pack.")
    .allowUnknownOption(true)
    .allowExcessArguments(true)
    .argument("[args...]", "arguments passed through to the policy dispatcher")
    .action((args: string[]) => {
      const result = runCleanroomCli(args, { cwd: process.cwd() });
      if (result.stdout.length > 0) process.stdout.write(result.stdout);
      if (result.stderr.length > 0) process.stderr.write(result.stderr);
      if (result.error) process.stderr.write(`ShipGate policy error: ${result.error}\n`);
      process.exitCode = result.exitCode;
    });
}
