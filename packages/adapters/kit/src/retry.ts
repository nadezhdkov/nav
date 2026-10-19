/**
 * Reset hints in rate-limit messages. Providers word them differently: Gemini APIs say
 * `Please retry in 23.5s` or `"retryDelay": "23s"`, agy says `Refreshes in 167h 2m`, HTTP
 * clients pass on `Retry-After`. Returns when the quota should be back (ISO 8601), or undefined.
 */

const UNIT_MS: Record<string, number> = { d: 86_400_000, h: 3_600_000, m: 60_000, s: 1_000 };

/** Phrases that announce a reset time; what follows is `in|after <duration>`. */
const HINT_PHRASE = /retry|try again|refreshes|resets?|available again/gi;
const RETRY_DELAY = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/;

/** Words that name a unit, as `1h`, `5 minutes` or `23.5 secs` write it. */
const UNIT_WORD = /^(?:days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)$/i;

const isSpace = (c: string | undefined) => c !== undefined && /\s/.test(c);
const isDigit = (c: string | undefined) => c !== undefined && c >= "0" && c <= "9";
const isLetter = (c: string | undefined) => c !== undefined && /[a-z]/i.test(c);

/**
 * Reads the durations right after a hint phrase: `1h 30m`, `23.5s`, `5 minutes`, `1m30s`, `2 hours and 5 minutes`.
 * It scans once from left to right, so a long run of spaces or digits costs time in proportion to its length.
 */
function durationsAfter(text: string, from: number): [number, string][] {
  let i = from;
  const skip = (test: (c: string | undefined) => boolean) => {
    while (test(text[i])) i++;
  };
  // `in` or `after`, between whitespace.
  if (!isSpace(text[i])) return [];
  skip(isSpace);
  const word = /^(?:in|after)/i.exec(text.slice(i, i + 5))?.[0];
  if (!word) return [];
  i += word.length;
  if (!isSpace(text[i])) return [];
  skip(isSpace);

  const parts: [number, string][] = [];
  for (;;) {
    const numberStart = i;
    skip(isDigit);
    if (i === numberStart) break;
    if (text[i] === "." && isDigit(text[i + 1])) {
      i++;
      skip(isDigit);
    }
    const value = Number(text.slice(numberStart, i));
    skip(isSpace);
    const unitStart = i;
    skip(isLetter);
    const unit = text.slice(unitStart, i);
    if (!UNIT_WORD.test(unit)) break;
    parts.push([value, unit.toLowerCase()[0]!]);
    skip((c) => isSpace(c) || c === ",");
    // An optional `and` joins the next part.
    if (/^and/i.test(text.slice(i, i + 3)) && isSpace(text[i + 3])) {
      i += 3;
      skip(isSpace);
    }
  }
  return parts;
}

/** ISO 8601 of `now + ms`, or undefined when the message names a time too far away to be a date. */
function iso(now: number, ms: number): string | undefined {
  const at = new Date(now + ms);
  return Number.isNaN(at.getTime()) ? undefined : at.toISOString();
}

export function retryAtFromText(text: string, now = Date.now()): string | undefined {
  const delay = RETRY_DELAY.exec(text);
  if (delay) return iso(now, Number(delay[1]) * 1_000);
  for (const phrase of text.matchAll(HINT_PHRASE)) {
    const parts = durationsAfter(text, phrase.index + phrase[0].length);
    if (!parts.length) continue;
    let ms = 0;
    for (const [value, unit] of parts) ms += value * (UNIT_MS[unit] ?? 0);
    return ms > 0 ? iso(now, ms) : undefined;
  }
  return undefined;
}

/** Unix seconds (or milliseconds) to ISO 8601. */
export function epochToIso(value: number): string {
  return new Date(value < 1e12 ? value * 1_000 : value).toISOString();
}
