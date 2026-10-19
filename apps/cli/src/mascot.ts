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
};

type Seg = [x: number, text: string];

/** One grid row from segments placed at columns; the rest is transparent. */
function row(width: number, ...segs: Seg[]): string {
  const cells = Array<string>(width).fill(".");
  for (const [x, text] of segs) for (let i = 0; i < text.length; i++) cells[x + i] = text[i]!;
  return cells.join("");
}

export const WIDTH = 24;

export const SPRITE: string[] = [
  row(WIDTH, [5, "WW"], [15, "WW"]),
  row(WIDTH, [4, "WPPW"], [14, "WPPW"]),
  row(WIDTH, [4, "WPPWWWWWWWWPPW"]),
  row(WIDTH, [3, "WWWWWWWWWWWWWWWW"]),
  row(WIDTH, [3, "WWKKWWWWWWWWKKWW"]),
  row(WIDTH, [3, "WGKKWWWWWWWWKKGW"]),
  row(WIDTH, [2, "WWHHHHHHHHHHHHHHWW"]),
  row(WIDTH, [2, "HHDHHLHHHHHHLHHDHH"]),
  row(WIDTH, [1, "HDHHSHHHHSSHHHHSHHDH"], [22, "V"]),
  row(WIDTH, [1, "HHHSSSHHSSSSHHSSSHHH"]),
  row(WIDTH, [1, "HDHSSSSSSSSSSSSSSHDH"], [21, "VV"]),
  row(WIDTH, [1, "HHHSEEESSSSSSEEESHHH"]),
  row(WIDTH, [1, "HHDSEAIESSSSEAIESDHH"], [22, "V"]),
  row(WIDTH, [1, "HHHSEEESSSSSSEEESHHH"]),
  row(WIDTH, [1, "HDHSCSSSSMMSSSSCSHDH"]),
  row(WIDTH, [1, "HHHHSSSSSMMSSSSSHHHH"], [22, "S"]),
  row(WIDTH, [1, "HDHHHSSSSSSSSSSHHHDH"], [21, "NS"]),
  row(WIDTH, [2, "HHHHHHRRRRRRHHHHHH"], [20, "NN"]),
  row(WIDTH, [2, "OHHNNNRRYYRRNNNHHO"], [19, "NN"]),
  row(WIDTH, [2, "ONNNNNNRRRRNNNNNNO"]),
  row(WIDTH, [0, "NN"], [2, "ONNNNNNNYYNNNNNNNO"]),
  row(WIDTH, [0, "NN"], [2, "NNNNNNNNNNNNNNNNNN"]),
  row(WIDTH, [0, "SS"], [2, "NNNNNNNNYYNNNNNNNN"]),
  row(WIDTH, [0, "SS"], [2, "NNNNTTTTTTTTTTNNNN"]),
  row(WIDTH, [4, "TTTTTTTTTTTTTT"]),
  row(WIDTH, [5, "TTTTTTTTTTTT"]),
  row(WIDTH, [5, "XXXXX"], [12, "XXXXX"]),
  row(WIDTH, [5, "XXXXX"], [12, "XXXXX"]),
  row(WIDTH, [5, "XZZXX"], [12, "XXZZX"]),
  row(WIDTH, [4, "ZZZZZZ"], [12, "ZZZZZZ"]),
];

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
