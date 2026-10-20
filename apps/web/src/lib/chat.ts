/** The daemon's limit for one message (`ConciergeMessageRequest`). */
export const MESSAGE_MAX = 8_000;

export type ChatFile = { name: string; content: string };

/** Text files only: a NUL byte or the replacement character means binary or not UTF-8. */
export function isText(content: string): boolean {
  return !content.includes("\0") && !content.includes("�");
}

/**
 * The message the daemon receives: the typed text, then each attached file in a delimited block.
 * The block marks the file as the user's data, and a closing tag inside a file cannot end it early.
 */
export function composeMessage(text: string, files: ChatFile[]): string {
  const blocks = files.map((f) => {
    const name = f.name.replace(/["<>\r\n]/g, "_");
    const body = f.content.replace(/<\/attached_file/gi, "<\\/attached_file");
    return `<attached_file name="${name}">\n${body}\n</attached_file>`;
  });
  return [text.trim(), ...blocks].filter(Boolean).join("\n\n");
}

export function fits(text: string, files: ChatFile[]): boolean {
  return composeMessage(text, files).length <= MESSAGE_MAX;
}

/** The `@mention` being typed at the end of the draft, if any (ADR 0073): `@name/path/to` with no space. */
export function mentionAt(draft: string): { start: number; token: string } | undefined {
  const m = /(^|\s)@([^\s@]*)$/.exec(draft);
  return m ? { start: m.index + m[1]!.length, token: m[2]! } : undefined;
}

/**
 * What a mention token asks for: no slash yet means "which project"; after the first slash it is
 * a path inside that project, whose folder part narrows the list and whose tail filters it.
 */
export function splitMention(token: string): { project: string; dir: string; query: string } | { projectQuery: string } {
  const slash = token.indexOf("/");
  if (slash === -1) return { projectQuery: token };
  const rest = token.slice(slash + 1);
  const cut = rest.lastIndexOf("/") + 1;
  return { project: token.slice(0, slash), dir: rest.slice(0, cut), query: rest.slice(cut) };
}

/** The body of a folder mention: its file names, one per line, so the agent knows what is there. */
export function folderListing(paths: string[], truncated: boolean): string {
  return `${paths.join("\n")}${truncated ? "\n…" : ""}`;
}
