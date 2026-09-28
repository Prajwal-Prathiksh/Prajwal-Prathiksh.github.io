// Rules for peg solitaire on the English (33-hole) and European (37-hole) boards.
// A move jumps a peg straight over a neighbour into an empty hole two away,
// removing the peg it jumped. The aim is one peg left, ideally in the centre.

export type Kind = 'english' | 'european';
export type Cell = number; // row * 7 + col on a 7x7 grid

export interface Jump {
  from: Cell;
  over: Cell;
  to: Cell;
}

export const CENTRE: Cell = 3 * 7 + 3;

// The European board's centre gap has no solution; this one (second hole of the
// top arm) does. The English board starts from the centre as usual.
export const DEFAULT_GAP: Record<Kind, Cell> = { english: CENTRE, european: 1 * 7 + 3 };

export function holes(kind: Kind): Cell[] {
  const cells: Cell[] = [];
  for (let r = 0; r < 7; r++) {
    for (let c = 0; c < 7; c++) {
      const arm = (r >= 2 && r <= 4) || (c >= 2 && c <= 4);
      const corner = kind === 'european' && (r === 1 || r === 5) && (c === 1 || c === 5);
      if (arm || corner) cells.push(r * 7 + c);
    }
  }
  return cells;
}

export function jumpsFrom(kind: Kind, pegs: Set<Cell>, from: Cell): Jump[] {
  if (!pegs.has(from)) return [];
  const onBoard = new Set(holes(kind));
  const r = Math.floor(from / 7);
  const c = from % 7;
  const out: Jump[] = [];
  for (const [dr, dc] of [
    [-1, 0],
    [1, 0],
    [0, -1],
    [0, 1],
  ]) {
    const [r1, c1, r2, c2] = [r + dr, c + dc, r + 2 * dr, c + 2 * dc];
    if (r2 < 0 || r2 > 6 || c2 < 0 || c2 > 6) continue;
    const over = r1 * 7 + c1;
    const to = r2 * 7 + c2;
    if (onBoard.has(over) && onBoard.has(to) && pegs.has(over) && !pegs.has(to)) out.push({ from, over, to });
  }
  return out;
}

export const allJumps = (kind: Kind, pegs: Set<Cell>) => [...pegs].flatMap((p) => jumpsFrom(kind, pegs, p));
