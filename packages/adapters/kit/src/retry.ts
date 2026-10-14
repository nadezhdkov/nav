/**
 * Reset hints in rate-limit messages. Providers word them differently: Gemini APIs say
 * `Please retry in 23.5s` or `"retryDelay": "23s"`, agy says `Refreshes in 167h 2m`, HTTP
 * clients pass on `Retry-After`. Returns when the quota should be back (ISO 8601), or undefined.
 */

const UNIT_MS: Record<string, number> = { d: 86_400_000, h: 3_600_000, m: 60_000, s: 1_000 };

/** A duration like `1h 30m`, `23.5s`, `5 minutes` or `1m30s` right after a hint phrase. */
const HINT =
  /(?:retry|try again|refreshes|resets?|available again)\s+(?:in|after)\s+((?:\d+(?:\.\d+)?\s*(?:days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)(?![a-z])[\s,]*(?:and\s+)?)+)/i;
const RETRY_DELAY = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/;

export function retryAtFromText(text: string, now = Date.now()): string | undefined {
  const delay = RETRY_DELAY.exec(text);
  if (delay) return new Date(now + Number(delay[1]) * 1_000).toISOString();
  const hint = HINT.exec(text);
  if (!hint?.[1]) return undefined;
  let ms = 0;
  for (const part of hint[1].matchAll(/(\d+(?:\.\d+)?)\s*([a-z]+)/gi)) {
    const unit = part[2]!.toLowerCase()[0]!;
    ms += Number(part[1]) * (UNIT_MS[unit] ?? 0);
  }
  return ms > 0 ? new Date(now + ms).toISOString() : undefined;
}

/** Unix seconds (or milliseconds) to ISO 8601. */
export function epochToIso(value: number): string {
  return new Date(value < 1e12 ? value * 1_000 : value).toISOString();
}
