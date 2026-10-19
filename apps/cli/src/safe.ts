/**
 * Text from agents, issues and pull requests reaches the operator's terminal (events, summaries,
 * titles, the concierge's replies). Control characters in it could move the cursor, rewrite earlier
 * lines or set the window title, so they are dropped; newlines and tabs stay.
 */
// eslint-disable-next-line no-control-regex
const CONTROLS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029]/g;

export function stripControls(text: string): string {
  return text.replace(CONTROLS, "");
}

/** Same, for one line: line breaks go too, so a value cannot fake a following line. */
export function oneLineSafe(text: string): string {
  return stripControls(text.replace(/[\r\n]+/g, " "));
}

/**
 * Prints one line of untrusted text. It is written as is, not through `console.log`, which would
 * read `%s` and similar in the text as format directives.
 */
export function printSafeLine(text: string): void {
  process.stdout.write(`${oneLineSafe(text)}\n`);
}
