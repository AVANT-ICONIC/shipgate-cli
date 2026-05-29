import { execa } from "execa";

export type ClipboardCommand = {
  command: string;
  args: string[];
};

export type ClipboardCopyResult = {
  command: string;
};

export type ClipboardRunner = (command: ClipboardCommand, text: string) => Promise<void>;

export function clipboardCommands(platform: NodeJS.Platform = process.platform): ClipboardCommand[] {
  if (platform === "darwin") return [{ command: "pbcopy", args: [] }];
  if (platform === "win32") return [{ command: "clip", args: [] }];
  if (platform === "linux") {
    return [
      { command: "wl-copy", args: [] },
      { command: "xclip", args: ["-selection", "clipboard"] },
      { command: "xsel", args: ["--clipboard", "--input"] }
    ];
  }

  return [];
}

function formatCommand(command: ClipboardCommand): string {
  return [command.command, ...command.args].join(" ");
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function defaultClipboardRunner(command: ClipboardCommand, text: string): Promise<void> {
  await execa(command.command, command.args, {
    input: text
  });
}

export async function copyToClipboard(
  text: string,
  options: {
    platform?: NodeJS.Platform;
    runner?: ClipboardRunner;
  } = {}
): Promise<ClipboardCopyResult> {
  const commands = clipboardCommands(options.platform);
  const runner = options.runner ?? defaultClipboardRunner;
  const failures: string[] = [];

  for (const command of commands) {
    try {
      await runner(command, text);
      return { command: formatCommand(command) };
    } catch (error) {
      failures.push(`${formatCommand(command)}: ${formatError(error)}`);
    }
  }

  const tried = failures.length ? failures.join("; ") : `no clipboard commands configured for ${options.platform ?? process.platform}`;
  throw new Error(`Could not copy to clipboard. Tried ${tried}.`);
}
