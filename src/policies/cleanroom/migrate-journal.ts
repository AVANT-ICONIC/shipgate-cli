// SPDX-License-Identifier: AGPL-3.0-or-later
import fs from "node:fs";
import path from "node:path";

/**
 * Durable migration journal (spec issue #1 step 6, reviewed protocol):
 * every public mutation is recorded BEFORE it is attempted ("begin") and
 * AFTER it completes ("done"). The journal lives next to the lock inside
 * `.shipgate/policies/`, is unique per run, and survives a process crash so
 * the next run can diagnose the interruption and resume by byte-verifying
 * each journaled piece. Every write fsyncs the file and its parent
 * directory so a crash cannot silently lose a recorded step.
 *
 * Recovery correctness never rests on the journal alone: every state and
 * marker publication is an exclusive create that is byte-verified on resume.
 * The single bounded exception is the JSON config merge, which commits with
 * one journaled atomic rename of a verified temp onto shipgate.config.json
 * (the explicit authorized config-replace exception). A lost or stale
 * journal degrades diagnosis, never safety.
 *
 * Section 2.2: pure filesystem helpers; no console output, no exit codes.
 */

export const JOURNAL_PREFIX = ".cleanroom-migrate.journal-";

export type JournalStep = {
  op: string;
  status: "begin" | "done";
  path?: string;
  sha256?: string;
  detail?: Record<string, unknown>;
};

export type Journal = {
  version: 1;
  runId: string;
  pid: number;
  startedAt: string;
  sourceDigest: string;
  steps: JournalStep[];
};

export const journalFileName = (runId: string): string => `${JOURNAL_PREFIX}${runId}.json`;

export function listJournals(policiesDirAbs: string): string[] {
  if (!fs.existsSync(policiesDirAbs)) return [];
  return fs
    .readdirSync(policiesDirAbs)
    .filter((entry) => entry.startsWith(JOURNAL_PREFIX) && entry.endsWith(".json"))
    .sort();
}

export function fsyncFile(abs: string): void {
  const fd = fs.openSync(abs, "r");
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

export function fsyncDir(abs: string): void {
  const fd = fs.openSync(abs, "r");
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/** EXCL-create the journal for this run and fsync it and its directory. */
export function createJournal(policiesDirAbs: string, runId: string, sourceDigest: string): Journal {
  const journal: Journal = {
    version: 1,
    runId,
    pid: process.pid,
    startedAt: new Date().toISOString(),
    sourceDigest,
    steps: [],
  };
  const abs = path.join(policiesDirAbs, journalFileName(runId));
  fs.writeFileSync(abs, JSON.stringify(journal, null, 2) + "\n", { flag: "wx" });
  fsyncFile(abs);
  fsyncDir(policiesDirAbs);
  return journal;
}

/** Append a step and persist: private temp + fsync + rename over our own
 * journal + parent-directory fsync. Single writer under the migration lock. */
export function recordStep(policiesDirAbs: string, journal: Journal, step: JournalStep): void {
  journal.steps.push(step);
  const abs = path.join(policiesDirAbs, journalFileName(journal.runId));
  const temp = `${abs}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(journal, null, 2) + "\n");
  fsyncFile(temp);
  fs.renameSync(temp, abs);
  fsyncDir(policiesDirAbs);
}

export function readJournal(abs: string): Journal {
  const parsed = JSON.parse(fs.readFileSync(abs, "utf8")) as Journal;
  if (
    parsed.version !== 1 ||
    typeof parsed.runId !== "string" ||
    typeof parsed.sourceDigest !== "string" ||
    !Array.isArray(parsed.steps)
  ) {
    throw new Error(`Malformed migration journal: ${abs}`);
  }
  return parsed;
}

/** All recorded steps for one op, in order. */
export function stepsFor(journal: Journal, op: string): JournalStep[] {
  return journal.steps.filter((s) => s.op === op);
}

/** The latest recorded step for one op, or null. */
export function lastStepFor(journal: Journal, op: string): JournalStep | null {
  const steps = stepsFor(journal, op);
  return steps.length > 0 ? steps[steps.length - 1]! : null;
}

/** Ops that mutate public state; a "done" entry for any of them means the
 * run published bytes that must be preserved and journaled, never removed. */
export const PUBLIC_OPS = ["publish-config", "publish-state", "config-commit", "marker-commit"] as const;

/** Any recorded step (begin OR done) for a public op: evidence that
 * publication may have begun. A begin without its done still explains
 * published bytes, so recovery and failure classification must treat it as
 * publication evidence - begin is not completion, but it is explanation. */
export function hasAnyPublicationStep(journal: Journal): boolean {
  return journal.steps.some((s) => (PUBLIC_OPS as readonly string[]).includes(s.op));
}
