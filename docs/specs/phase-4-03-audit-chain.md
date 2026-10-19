# Phase 4, slice 3: hash-chained event log

Status: implemented · Branch: `feat/audit-chain` · Spec: §10.3 · ADR: 0061

## Behavior

- Every event carries a `hash` chained to the previous one (`apps/daemon/src/events/chain.ts`); the log verifies with `EventStore.verifyChain()`, and the daemon warns at start when it does not.
- `navarch audit [verify] [--expect <hash>]` (`GET /api/v1/audit`) prints the chain report and the head; `navarch audit export <run> [--json]` (`GET /api/v1/runs/:id/audit`) exports a run's events with hashes. Neither is open to paired devices.
- Logs from before the chain keep their old events unhashed (`legacy`).

## Acceptance

- A log written by the store verifies, across batches; an empty log is fine (`apps/daemon/test/audit-chain.test.ts`).
- An edited event, a removed middle event and an event whose hash was cut out are found, with their `seq`.
- A removed newest event is found only by the kept head (`hasHash`).
- A log without the column gets it, counts its old events as legacy and chains the new ones.

## Not in this slice

- Signing, scheduled export of the head, a UI screen, recording `audit.verified` events.
