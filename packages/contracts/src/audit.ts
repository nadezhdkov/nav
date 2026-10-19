import { z } from "zod";

/** The event log's hash chain and the per-run audit export (spec §10.3, ADR 0061). */

export const ChainReport = z.object({
  ok: z.boolean(),
  events: z.number().int().nonnegative(),
  /** Events written before the chain existed, which it cannot vouch for. */
  legacy: z.number().int().nonnegative(),
  chained: z.number().int().nonnegative(),
  /** The last hash. Keep a copy where the daemon cannot write, and `navarch audit --expect <hash>` notices a rewrite of the whole log. */
  head: z.string().nullable(),
  broken: z.object({ seq: z.number().int(), id: z.string(), reason: z.string() }).nullable(),
});
export type ChainReport = z.infer<typeof ChainReport>;

export const AuditVerifyView = ChainReport.extend({
  /** Set when `expect` was given: whether the log's hash at that point matches. */
  expected: z.object({ hash: z.string(), found: z.boolean() }).nullable(),
});
export type AuditVerifyView = z.infer<typeof AuditVerifyView>;

export const AuditEvent = z.object({
  seq: z.number().int(),
  id: z.string(),
  ts: z.string(),
  type: z.string(),
  task_id: z.string().nullable(),
  actor: z.unknown(),
  payload: z.unknown(),
  hash: z.string().nullable(),
});
export type AuditEvent = z.infer<typeof AuditEvent>;

export const RunAudit = z.object({
  run: z.object({ id: z.string(), name: z.string(), status: z.string() }),
  generated_at: z.string(),
  chain: ChainReport,
  events: z.array(AuditEvent),
});
export type RunAudit = z.infer<typeof RunAudit>;
