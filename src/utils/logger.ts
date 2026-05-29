import pc from "picocolors";

export const logger = {
  info(message: string) {
    console.log(message);
  },
  success(message: string) {
    console.log(pc.green(`✓ ${message}`));
  },
  fail(message: string) {
    console.error(pc.red(`✕ ${message}`));
  },
  warn(message: string) {
    console.warn(pc.yellow(`! ${message}`));
  },
  dim(message: string) {
    console.log(pc.dim(message));
  }
};
