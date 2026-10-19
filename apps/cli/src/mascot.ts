/**
 * The mascot of the banner: a small pixel-art figure, drawn here as a palette-indexed grid and printed with
 * half-block characters (two pixels per text row) in 24-bit colour. A terminal without true colour gets no
 * figure at all, never a muddy one.
 */

/** Palette: `.` is transparent. */
export const PALETTE: Record<string, [number, number, number]> = {
  W: [244, 244, 240], // hat
  G: [201, 205, 214], // hat shade
  P: [240, 168, 160], // ear
  K: [20, 22, 28], // hat patches
  H: [31, 143, 58], // hair
  D: [20, 100, 42], // hair shade
  L: [72, 188, 98], // hair light
  S: [246, 214, 192], // skin
  C: [236, 170, 160], // cheek
  E: [47, 190, 80], // eye
  A: [14, 60, 30], // eye line
  I: [255, 255, 255], // eye shine
  M: [214, 74, 90], // mouth
  N: [27, 36, 64], // sweater
  O: [44, 56, 92], // sweater light
  R: [124, 200, 240], // bow
  Y: [232, 184, 48], // buttons
  T: [104, 134, 132], // skirt
  X: [240, 240, 240], // socks
  Z: [150, 156, 168], // sock shade
  V: [60, 190, 90], // sparkle
  Q: [236, 124, 138], // tongue
};

/** A symmetric picture is drawn as its left half; the right half is the mirror image. */
const mirror = (half: string): string => half + [...half].reverse().join("");

export const WIDTH = 24;

/**
 * Her face and hat (the project's mascot), two pixels to a text row. Only the left half of each row is
 * written down, so the face is symmetrical by construction.
 */
export const SPRITE: string[] = [
  "....WW......",
  "...WPPW.....",
  "...WPPWWWWWW",
  "..WWWWWWWWWW",
  "..WWKKWWWWWW",
  "..WGKKWWWWWW",
  "..WGWWWWWWWW",
  ".HHHHHHHHHHH",
  ".HHLHHHHHHHH",
  "HHHHHHHHHHHH",
  "HHDHSHHHHSSS",
  "HHHHSSHHSSSS",
  "HHDHSSAAASSS",
  "HHHHSAEIEESS",
  "HHDHSEEEEESS",
  "HHHHSSEEEESS",
  "HHDHSCCSSSSS",
  "HHHHSSSSSMMM",
  "HHDHSSSSSSMQ",
  "HHHHHSSSSSSS",
  "HHDHHHSSSSSS",
  ".HHHHHHSSSSS",
  "..HHHHHHHRRR",
  "...HHHHHHRRR",
].map(mirror);

/** The figure as lines of text: `▀` carries the upper pixel as foreground and the lower as background. */
export function renderMascot(): string[] {
  const out: string[] = [];
  const rgb = (c: [number, number, number], bg: boolean) => `\x1b[${bg ? 48 : 38};2;${c[0]};${c[1]};${c[2]}m`;
  const at = (y: number, x: number) => PALETTE[SPRITE[y]?.[x] ?? "."];
  for (let y = 0; y < SPRITE.length; y += 2) {
    let line = "";
    for (let x = 0; x < WIDTH; x++) {
      const top = at(y, x);
      const bottom = at(y + 1, x);
      if (!top && !bottom) line += "\x1b[0m ";
      else if (top && bottom) line += `${rgb(top, false)}${rgb(bottom, true)}▀`;
      else if (top) line += `\x1b[0m${rgb(top, false)}▀`;
      else line += `\x1b[0m${rgb(bottom!, false)}▄`;
    }
    out.push(`${line}\x1b[0m`);
  }
  return out;
}
