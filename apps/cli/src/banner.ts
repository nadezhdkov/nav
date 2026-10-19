/**
 * The greeting of `navarch` and `navarch chat`: a ship with its helmsman beside the name. Colour only
 * when the output is a terminal that wants it (`NO_COLOR` unset, `TERM` not `dumb`); with no terminal at
 * all the caller prints one plain line.
 */

const SHIP = [
  "       |\\",
  "       | \\",
  "    ___|__\\___",
  "    \\ (o_o)  /",
  "     \\______/",
  "  ~~~~~~~~~~~~~~",
];

const CYAN = "\x1b[36m";
const BLUE = "\x1b[34m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

/** Whether to use colour on this output, following the NO_COLOR convention. */
export function wantsColor(tty: boolean, env: Record<string, string | undefined> = process.env): boolean {
  return tty && !env.NO_COLOR && env.TERM !== "dumb";
}

export function banner(opts: { color: boolean; cwd: string }): string {
  const paint = (code: string, text: string) => (opts.color ? `${code}${text}${RESET}` : text);
  const side = [paint(BOLD + CYAN, "navarch"), paint(DIM, "your fleet of coding agents"), "", paint(DIM, opts.cwd), paint(DIM, "/help for help")];
  const rows = SHIP.map((line, i) => {
    const art = i === SHIP.length - 1 ? paint(BLUE, line) : paint(CYAN, line);
    return `${art}${" ".repeat(Math.max(0, 18 - line.length))}${side[i - 0] ?? ""}`;
  });
  return `${rows.join("\n")}\n`;
}
