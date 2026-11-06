# Cleanroom migration: recovery and availability contract

`shipgate migrate cleanroom` copies legacy Cleanroom state (`.greenroom.json`
and `.greenroom/`) into the ShipGate layout (`.shipgate/policies/cleanroom.json`
and `.shipgate/policies/cleanroom/`). Legacy state is never deleted.

This page documents the failure and recovery behavior operators should
expect. It describes current behavior on the migration branch; the handling
of a pre-existing JSON `shipgate.config.json` (proposed merged file plus
exit 2, no automatic merge) is a pending spec decision and may change.

## What is guaranteed

- Byte-for-byte copy, verified twice: staging is re-inventoried against the
  source, and the placed destination is verified before completion.
- Old and new `check --json` must produce identical findings and exit codes
  before anything is published.
- Publication uses exclusive-create operations only (O_EXCL copies, mkdir,
  hardlinks). No public path is overwritten. On handled failures, published
  state and your data are preserved; cleanup removes only journal-proven,
  inode-verified private scratch (this run's staging, temps, journal, and an
  empty reservation directory whose identity matches its journal record).
- The migration marker (`.shipgate/policies/cleanroom/migration.json`) is
  the commit point. It is written last, via an atomic no-replace link. For
  policy commands, the marker file's existence alone selects the migrated
  layout; the migrate command itself only treats a marker with status
  "completed" and a parity digest as proof of completion, and a re-run of a
  completed identical migration is a no-op.
- Every step is recorded in a durable per-run journal under
  `.shipgate/policies/` before and after it happens.

## What is not guaranteed

- There is no multi-file atomic commit. A crash (including power loss) can
  leave a partially published destination.
- The lock file serializes cooperative migrators only. It cannot fence an
  editor, script, or operator that modifies files directly. Conflicts the
  migration detects are preserved and reported, but there is no byte-level
  guarantee against a non-cooperating writer (for example an in-place edit
  of an already published file).
- A stale lock is never reclaimed automatically, even when its recorded
  process is dead.

## If a migration is interrupted

This applies while no completed marker exists. (Once the marker is complete,
a re-run verifies the destination, reports any leftover residue without
deleting it, and returns 0 - even if a stale lock is present.)

1. A re-run refuses while a lock file exists and prints a diagnosis: the
   recorded pid, start time, whether that process is still alive, and the
   last journaled step.
2. After confirming no migration is running, remove
   `.shipgate/policies/.cleanroom-migrate.lock` deliberately and re-run.
3. The re-run re-stages a fresh copy from the legacy source, requires the
   source to be unchanged since the interrupted run, and byte-verifies every
   journaled piece: matching bytes are adopted, anything unexpected is
   preserved and reported as a conflict.
4. On success, the run removes its own staging and journal. Residue it
   cannot prove ownership of (by journal record and inode identity, never by
   name) is preserved and listed in the output; remove it deliberately.

## Availability during migration

Until the marker exists, policy commands that find both the legacy and the
migrated layout fail closed with a conflict error instead of combining two
state roots. So a migration interrupted between its first publication and
the marker leaves policy reads unavailable until the migration is resumed
and completed (or the partial destination is removed deliberately). The
legacy state itself is always intact and can be restored to sole use by
removing the partial destination.

## Config handling

- No `shipgate.config.*` exists: one is created with `policies.cleanroom`.
- `shipgate.config.json` exists (pending spec decision): the migration
  writes a proposed merged config to `.shipgate/policies/cleanroom.config-patch.json`
  and exits with code 2. If that path is already taken by different content,
  a uniquely suffixed path is written instead - use the exact path the
  command reports. Review the proposal, replace `shipgate.config.json` with
  it, and re-run.
- TypeScript/JavaScript config: a proposed patch is written (same path
  rules); merge `policies.cleanroom` into your config and re-run. Known
  limitation: a code config cannot be inspected safely, so the command stops
  with the proposal again on every run, even after you merge - it does not
  currently detect the added policy in a TypeScript/JavaScript config.
- A config that already contains `policies.cleanroom` is left as is.
