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
