import { SPEC_GREEN_TARGET } from "@navarch/contracts";

/** The shares of one write's claims, for the bar: confirmed, inferred, gap, in percent of the claims. */
export function shares(v: { confirmed: number; inferred: number; gap: number }): { confirmed: number; inferred: number; gap: number } {
  const total = v.confirmed + v.inferred + v.gap;
  if (!total) return { confirmed: 0, inferred: 0, gap: 0 };
  return { confirmed: (v.confirmed / total) * 100, inferred: (v.inferred / total) * 100, gap: (v.gap / total) * 100 };
}

/** "94 %" for a green rate of 0.94; null while there are no claims. */
export function percent(rate: number | null): string | null {
  return rate === null ? null : `${Math.round(rate * 100)} %`;
}

/** Whether a write reaches the Phase 3 target of confirmed claims (spec §16). */
export function meetsTarget(rate: number | null): boolean {
  return rate !== null && rate >= SPEC_GREEN_TARGET;
}

/** The target as the percentage the screen states. */
export const TARGET_PERCENT = Math.round(SPEC_GREEN_TARGET * 100);
