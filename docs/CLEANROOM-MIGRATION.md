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
  hardlinks). Nothing pre-existing is overwritten or deleted: not your
  files, and not bytes the migration itself already published.
- The migration marker (`.shipgate/policies/cleanroom/migration.json`) is
  the single commit point. It is written last, atomically, and a re-run of a
  completed identical migration is a no-op.
- Every step is recorded in a durable per-run journal under
  `.shipgate/policies/` before and after it happens.

## What is not guaranteed

- There is no multi-file atomic commit. A crash (including power loss) can
  leave a partially published destination.
- The lock file serializes cooperative migrators only. It cannot stop an
  editor, script, or operator that modifies files directly; against those,
  the migration preserves bytes and reports conflicts instead of racing.
- A stale lock is never reclaimed automatically, even when its recorded
  process is dead.

## If a migration is interrupted

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
  writes a proposed merged config to
  `.shipgate/policies/cleanroom.config-patch.json` and exits with code 2.
  Review it, replace `shipgate.config.json` with it, and re-run.
- TypeScript/JavaScript config: a proposed patch is written to the same
  location; merge `policies.cleanroom` into the config and re-run.
- A config that already contains `policies.cleanroom` is left as is.
