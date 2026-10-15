import { monotonicFactory } from "ulid";

const ulid = monotonicFactory();

export type IdPrefix = "evt" | "run" | "task" | "art" | "sbx" | "apr" | "conv" | "prop";

/** Sortable, prefixed identifier, e.g. `run_01J...` (spec §9.2). */
export function newId(prefix: IdPrefix): string {
  return `${prefix}_${ulid()}`;
}
