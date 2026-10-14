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
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

const known = new Set<string>();

export function registerSecret(value: string): void {
  if (value.length >= 8) known.add(value);
}

export function redact(text: string): string {
  let out = text;
  for (const value of known) out = out.split(value).join("[REDACTED]");
  for (const pattern of patterns) out = out.replace(pattern, "[REDACTED]");
  return out;
}
