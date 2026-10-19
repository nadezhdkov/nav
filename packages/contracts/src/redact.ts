/**
 * Secret redaction for logs and event payloads (spec §6.1.5, threat T7).
 * Patterns cover well-known token formats; values registered at runtime are redacted verbatim.
 */
const patterns: RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{10,}/g,
  /sk-(?:proj-)?[A-Za-z0-9_-]{20,}/g,
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /xox[abprs]-[A-Za-z0-9-]{10,}/g,
  /AKIA[0-9A-Z]{16}/g,
  // Navarch device access and refresh tokens (ADR 0020).
  /nv[dr]_[A-Za-z0-9_.-]{20,}/g,
];

const known = new Set<string>();

export function registerSecret(value: string): void {
  if (value.length >= 8) known.add(value);
}

/**
 * A PEM private key, from its BEGIN line to the first END line after it. Done in one pass instead of
 * `BEGIN[\s\S]*?END`: that pattern rescans to the end of the text from every BEGIN when no END
 * follows, which is quadratic on text a repository controls (CodeQL js/polynomial-redos).
 */
const keyBegin = /-----BEGIN [A-Z ]*PRIVATE KEY-----/g;
const keyEnd = /-----END [A-Z ]*PRIVATE KEY-----/g;

function redactPrivateKeys(text: string): string {
  let out = "";
  let from = 0;
  keyBegin.lastIndex = 0;
  for (;;) {
    const begin = keyBegin.exec(text);
    if (!begin) break;
    keyEnd.lastIndex = begin.index + begin[0].length;
    const end = keyEnd.exec(text);
    // No END after this BEGIN means none after a later one either: stop scanning.
    if (!end) break;
    out += `${text.slice(from, begin.index)}[REDACTED]`;
    from = end.index + end[0].length;
    keyBegin.lastIndex = from;
  }
  return out + text.slice(from);
}

export function redact(text: string): string {
  let out = text;
  for (const value of known) out = out.split(value).join("[REDACTED]");
  for (const pattern of patterns) out = out.replace(pattern, "[REDACTED]");
  return redactPrivateKeys(out);
}
