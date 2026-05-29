export function nowIso(): string {
  return new Date().toISOString();
}

export function durationMs(start: number): number {
  return Date.now() - start;
}

export function safeTimestamp(date = new Date()): string {
  return date.toISOString().replace(/[:.]/g, "-");
}
