import { renderMascot, WIDTH as MASCOT_WIDTH } from "./mascot.ts";
import { stripControls } from "./safe.ts";

/**
 * The greeting of `navarch` and `navarch chat`: the mascot, a helm wheel and the name, then where you are
 * (project, repository, workspace, branch, agents) and "System ready". It adapts to the terminal: the
 * mascot needs true colour and 78 columns, the name 54, and below that only the lines of text are left.
 * With no terminal at all the caller prints one plain line instead.
 */

export type BannerInfo = {
  project?: string | undefined;
  repository?: string | undefined;
  workspace: string;
  branch?: string | undefined;
  agents?: string | undefined;
};

export type BannerOptions = {
  color: boolean;
  /** 24-bit colour: the mascot is drawn only then. */
  truecolor?: boolean;
  columns?: number;
  info: BannerInfo;
};

const E = "\x1b[";
const RESET = `${E}0m`;
const CYAN = `${E}38;2;86;212;240m`;
const STEEL = `${E}38;2;90;122;148m`;
const WHITE = `${E}38;2;236;234;226m`;
const DIM = `${E}38;2;139;148;158m`;
const GREEN = `${E}38;2;86;211;100m`;
const BOLD = `${E}1m`;

/** The name in a 5-row block font, one glyph per letter (N A V A R C H). */
const GLYPHS: Record<string, string[]> = {
  N: ["█   █", "██  █", "█ █ █", "█  ██", "█   █"],
  A: [" ███ ", "█   █", "█████", "█   █", "█   █"],
  V: ["█   █", "█   █", "█   █", " █ █ ", "  █  "],
  R: ["████ ", "█   █", "████ ", "█  █ ", "█   █"],
  C: [" ████", "█    ", "█    ", "█    ", " ████"],
  H: ["█   █", "█   █", "█████", "█   █", "█   █"],
};
const WORD = [..."NAVARCH"];
const WORD_WIDTH = WORD.length * 5 + (WORD.length - 1);

/** The helm: a ring with handles. Nine columns, five rows. */
const WHEEL = ["●   │   ●", " ╲ ┌┴┐ ╱ ", "──┤ ◉ ├──", " ╱ └┬┘ ╲ ", "●   │   ●"];
const WHEEL_WIDTH = 9;

const GAP = 2;
const MASCOT_GAP = 3;
const MIN_WITH_MASCOT = MASCOT_WIDTH + MASCOT_GAP + WHEEL_WIDTH + GAP + WORD_WIDTH;
const MIN_WITH_NAME = WHEEL_WIDTH + GAP + WORD_WIDTH;
const LABEL = 11;
const TAGLINE = "orchestrate your fleet of coding agents";

/** Whether to use colour on this output, following the NO_COLOR convention. */
export function wantsColor(tty: boolean, env: Record<string, string | undefined> = process.env): boolean {
  return tty && !env.NO_COLOR && env.TERM !== "dumb";
}

/** Whether the terminal says it can show 24-bit colour. */
export function hasTruecolor(env: Record<string, string | undefined> = process.env): boolean {
  return /truecolor|24bit/i.test(env.COLORTERM ?? "") || /-direct$|truecolor/i.test(env.TERM ?? "");
}

/** `git@github.com:o/r.git` and `https://user:token@github.com/o/r.git` as `https://github.com/o/r`, never with credentials. */
export function tidyRemote(url: string): string {
  const raw = url.trim();
  const ssh = /^(?:[\w.-]+@)?([\w.-]+):(?!\/\/)([\w./-]+?)(?:\.git)?\/?$/.exec(raw);
  if (ssh) return `https://${ssh[1]}/${ssh[2]}`;
  try {
    const u = new URL(raw);
    return `${u.protocol}//${u.host}${u.pathname.replace(/\.git$/, "").replace(/\/$/, "")}`;
  } catch {
    return stripControls(raw).slice(0, 80);
  }
}

export function banner(opts: BannerOptions): string {
  const columns = opts.columns && opts.columns > 0 ? opts.columns : 80;
  const paint = (code: string, text: string) => (opts.color ? `${code}${text}${RESET}` : text);
  const withName = columns >= MIN_WITH_NAME;
  const withMascot = opts.color && opts.truecolor === true && columns >= MIN_WITH_MASCOT;

  const right: string[] = [];
  if (withName) {
    for (let i = 0; i < 5; i++) {
      const word = WORD.map((l) => GLYPHS[l]![i]!).join(" ");
      right.push(`${paint(STEEL, WHEEL[i]!)}${" ".repeat(GAP)}${paint(WHITE, word)}`);
    }
    right.push(paint(CYAN, TAGLINE.slice(0, Math.max(10, columns - (withMascot ? MASCOT_WIDTH + MASCOT_GAP : 0)))));
  } else {
    right.push(paint(BOLD + WHITE, "navarch"), paint(CYAN, TAGLINE.slice(0, Math.max(10, columns))));
  }
  right.push("");

  const room = Math.max(12, columns - (withMascot ? MASCOT_WIDTH + MASCOT_GAP : 0) - LABEL - 3);
  const rows: [string, string | undefined][] = [
    ["Project", opts.info.project],
    ["Repository", opts.info.repository],
    ["Workspace", opts.info.workspace],
    ["Branch", opts.info.branch],
    ["Agents", opts.info.agents],
  ];
  for (const [label, value] of rows) {
    if (!value) continue;
    const text = stripControls(value);
    const shown = text.length > room ? `${text.slice(0, room - 1)}…` : text;
    right.push(`${paint(CYAN, "▪")} ${paint(DIM, label.padEnd(LABEL))} ${paint(label === "Agents" || label === "Branch" ? GREEN : WHITE, shown)}`);
  }
  right.push("");
  const rule = Math.min(46, columns - (withMascot ? MASCOT_WIDTH + MASCOT_GAP : 0));
  right.push(paint(STEEL, "─".repeat(Math.max(8, rule))));
  right.push(`${paint(GREEN, "●")} ${paint(GREEN, "System ready")}`);
  const hint = "Type a message to get started  •  /help for help";
  const hintRoom = columns - (withMascot ? MASCOT_WIDTH + MASCOT_GAP : 0);
  right.push(paint(DIM, hint.length > hintRoom ? "/help for help".slice(0, Math.max(0, hintRoom)) : hint));

  if (!withMascot) return `${right.join("\n")}\n`;
  const mascot = renderMascot();
  const height = Math.max(mascot.length, right.length);
  const lines: string[] = [];
  for (let i = 0; i < height; i++) {
    const left = mascot[i] ?? " ".repeat(MASCOT_WIDTH);
    lines.push(`${left}${" ".repeat(MASCOT_GAP)}${right[i] ?? ""}`);
  }
  return `${lines.join("\n")}\n`;
}

/** The prompt of the chat. */
export function prompt(color: boolean): string {
  return color ? `${BOLD}${CYAN}nav>${RESET} ` : "nav> ";
}
