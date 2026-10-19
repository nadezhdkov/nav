import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { ChainReport } from "@navarch/contracts";

/**
 * The event log's hash chain (spec §10.3, ADR 0061): each event stores `sha256` of the previous
 * event's hash and its own stored fields, so changing, removing or reordering an event breaks every
 * hash after it. Events written before the chain existed have no hash (the "legacy" prefix).
 */

export type ChainFields = {
  id: string;
  ts: string;
  type: string;
  run_id: string | null;
  task_id: string | null;
  /** The JSON text as stored. */
  actor: string;
  /** The JSON text as stored. */
  payload: string;
  schema_version: number;
};

export const GENESIS = "genesis";

export function chainHash(prev: string, e: ChainFields): string {
  // JSON of an array keeps field boundaries unambiguous: no field can borrow characters from its neighbour.
  return createHash("sha256")
    .update(JSON.stringify([prev, e.id, e.ts, e.type, e.run_id, e.task_id, e.actor, e.payload, e.schema_version]))
    .digest("hex");
}

/** Walks the log in order and recomputes every hash. */
export function verifyChain(db: DatabaseSync): ChainReport {
  const report: ChainReport = { ok: true, events: 0, legacy: 0, chained: 0, head: null, broken: null };
  let prev = GENESIS;
  let started = false;
  const rows = db.prepare("SELECT seq, id, ts, type, run_id, task_id, actor, payload, schema_version, hash FROM events ORDER BY seq").iterate() as Iterable<
    ChainFields & { seq: number; hash: string | null }
  >;
  for (const row of rows) {
    report.events++;
    if (row.hash === null) {
      if (started) {
        report.ok = false;
        report.broken ??= { seq: Number(row.seq), id: row.id, reason: "an event without a hash after the chain began" };
      } else report.legacy++;
      continue;
    }
    started = true;
    const expected = chainHash(prev, { ...row, run_id: row.run_id ?? null, task_id: row.task_id ?? null, schema_version: Number(row.schema_version) });
    if (expected !== row.hash && report.broken === null) {
      report.ok = false;
      report.broken = { seq: Number(row.seq), id: row.id, reason: "the hash does not match the event and the one before it" };
    }
    // After a break keep following the stored hashes, so the report still counts the events.
    prev = row.hash;
    report.chained++;
    report.head = row.hash;
  }
  return report;
}

/** The hash the next event must chain to. */
export function chainTip(db: DatabaseSync): string {
  const row = db.prepare("SELECT hash FROM events WHERE hash IS NOT NULL ORDER BY seq DESC LIMIT 1").get() as { hash: string } | undefined;
  return row?.hash ?? GENESIS;
}
