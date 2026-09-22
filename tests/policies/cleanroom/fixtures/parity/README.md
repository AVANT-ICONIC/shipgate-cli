# Cleanroom parity evidence

Step 0 freezes the inputs before any Cleanroom runtime code moves.

## Pinned sources

- Cleanroom: `https://github.com/AVANT-ICONIC/cleanroom` at `3da8cf6c73bce533e4d1b08e97b7e3992da31927`.
- ShipGate base: `https://github.com/AVANT-ICONIC/shipgate-cli` at `7eef931a0e63b767b0dc66cb7e1d183dd79e3b42`.
- Apex (private): `https://github.com/AVANT-ICONIC/apex-nexus.git` at `6f26921a05becbc71321aaf318da11085311575c`. The private tree and raw JSON stay outside this public repository; only the commit and reproducible digests are recorded.

The harness refuses dirty repositories, scrubs every `GREENROOM_ALLOW_*`, `GREENROOM_COMPARE_REF`, and `GREENROOM_BASE_REF` variable, records the remote and commit, and compares exit codes plus canonical JSON. Canonicalization removes only timestamps, durations, temporary absolute roots, and the Green Room/Cleanroom prose brand. Finding IDs, rules, paths, details, counts, entropy, hashes, compare refs, waiver and provider status, severity, confidence, actions, and exit codes remain load-bearing.

Example:

```bash
node scripts/cleanroom-parity.mjs \
  --repo /path/to/clean/repository \
  --legacy-cli /path/to/cleanroom/src/cli.mjs \
  --shipgate-cli /path/to/shipgate-cleanroom-cli.mjs \
  --ref origin/main \
  --output /tmp/parity-manifest.json
```

Ground-truth execution on the pinned Apex tree, on branch `master`, with Cleanroom `3da8cf6` produced:

- `audit --json`: exit 0, 42 findings, 3 violations, entropy 12. The full-output digest is environment-sensitive and is evidence for this run, not a cross-machine invariant: `013c106d89b019bf1b7017a76b4bd8d225cf774cc3a89476edbd4d3978804f34`.
- `providers --json`: exit 0. Availability is environment-sensitive; the exact status metadata for this run is committed as `../providers-status.json`. Full-output digest: `bb502c98b6fcfc4574afa91b67c780760f1b1a9cf529136fadf6aced0aa4652d`.
- `check --json`: exit 0, resolved compare ref `HEAD^`, reproducible SHA-256 `875e01a9cf60cc9f78c2b7d743e7abb306ea9ba8008134f9ceb44fa7d5df076d`. A detached checkout of the same commit resolves no compare ref and falls back to the adoption baseline, so the branch is part of the evidence.
- `test/apex-ground-truth.test.mjs`: 3/3 passed, covering the stranded tested-only implementation, unreachable implementation plus duplicated decision source, and private-symbol false-positive classes.

The real old/new run starts after the ShipGate policy entry point exists. Until then, Step 0 tests exercise the harness with controlled executables and prove that semantic changes fail while the narrow volatile set passes.

Step 0 now executes the legacy half of the required fresh-copy gate: it creates a repository with `origin/main`, runs legacy Cleanroom auto-resolution in the original and a ShipGate fresh copy, and requires identical compare refs and findings. Step 4 adds the same assertion through the registered ShipGate policy pack and must pass before Step 5.
