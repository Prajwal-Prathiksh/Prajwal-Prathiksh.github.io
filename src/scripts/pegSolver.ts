// Peg solitaire solver for hints. Given the pegs on the board, it searches for
// jumps that leave one peg (preferring the centre) within a time budget.
//
// Two things keep it quick:
// - The "rule of three": colour the board along diagonals in three classes.
//   Every jump takes one peg from each class and puts one back in one class,
//   flipping all three counts, so their pairwise parities never change. That
//   rules out most squares as the final one before any search starts.
// - Symmetry: a position that fails also fails when rotated or mirrored, so
//   failures are stored under the smallest of the 8 equivalent positions.

import { CENTRE, holes, type Cell, type Kind } from './pegSolitaire';

// Which order to try jumps in. Neither wins everywhere, so the page runs one
// solver of each at once and takes the first answer.
export type Order = 'grid' | 'outward';

export interface SolveRequest {
  id: number;
  kind: Kind;
  order: Order;
  pegs: Cell[];
  budgetMs: number;
}

export type SolveResult =
  | { id: number; status: 'found'; path: [Cell, Cell][]; centre: boolean }
  | { id: number; status: 'none' | 'timeout' };

class OutOfTime extends Error {}

const SYMMETRIES: ((r: number, c: number) => [number, number])[] = [
  (r, c) => [r, c],
  (r, c) => [c, 6 - r],
  (r, c) => [6 - r, 6 - c],
  (r, c) => [6 - c, r],
  (r, c) => [r, 6 - c],
  (r, c) => [6 - r, c],
  (r, c) => [c, r],
  (r, c) => [6 - c, 6 - r],
];

// Which cells could hold the last peg, judged by the rule of three.
export function possibleFinals(kind: Kind, pegs: Cell[]): Cell[] {
  const cls = (cell: Cell, dir: 1 | -1) => (((Math.floor(cell / 7) + dir * (cell % 7)) % 3) + 3) % 3;
  const parities = (cells: Cell[], dir: 1 | -1) => {
    const n = [0, 0, 0];
    cells.forEach((c) => n[cls(c, dir)]++);
    return [(n[0] + n[1]) % 2, (n[0] + n[2]) % 2];
  };
  const now = [...parities(pegs, 1), ...parities(pegs, -1)];
  return holes(kind).filter((cell) => {
    const one = [...parities([cell], 1), ...parities([cell], -1)];
    return one.every((v, i) => v === now[i]);
  });
}

// One solver per board keeps what it has learnt between hints.
export class Solver {
  private cells: Cell[];
  private index: Map<Cell, number>;
  private jumps: { fl: number; fh: number; ol: number; oh: number; tl: number; th: number; from: Cell; to: Cell }[] = [];
  private symTables: Float64Array[][]; // [symmetry][byte] -> 256 mapped values
  private failed = [new Set<number>(), new Set<number>()]; // [any peg, centre only]
  readonly kind: Kind;

  constructor(kind: Kind, order: Order) {
    this.kind = kind;
    this.cells = holes(kind);
    this.index = new Map(this.cells.map((c, i) => [c, i]));
    for (const cell of this.cells) {
      const r = Math.floor(cell / 7);
      const c = cell % 7;
      for (const [dr, dc] of [
        [-1, 0],
        [1, 0],
        [0, -1],
        [0, 1],
      ]) {
        const [r2, c2] = [r + 2 * dr, c + 2 * dc];
        const over = (r + dr) * 7 + (c + dc);
        const to = r2 * 7 + c2;
        if (r2 >= 0 && r2 <= 6 && c2 >= 0 && c2 <= 6 && this.index.has(over) && this.index.has(to)) {
          const [fl, fh] = this.bit(this.index.get(cell)!);
          const [ol, oh] = this.bit(this.index.get(over)!);
          const [tl, th] = this.bit(this.index.get(to)!);
          this.jumps.push({ fl, fh, ol, oh, tl, th, from: cell, to });
        }
      }
    }
    if (order === 'outward') {
      // Jumps landing furthest from the centre first.
      const far = (cell: Cell) => Math.abs(Math.floor(cell / 7) - 3) + Math.abs((cell % 7) - 3);
      this.jumps.sort((a, b) => far(b.to) - far(a.to));
    }
    // Positions are numbers with one bit per hole (up to 37 bits, still exact
    // in a double). For each symmetry, map each byte of a position at once.
    const bytes = Math.ceil(this.cells.length / 8);
    this.symTables = SYMMETRIES.map((sym) =>
      Array.from({ length: bytes }, (_, b) => {
        const table = new Float64Array(256);
        for (let v = 0; v < 256; v++) {
          let out = 0;
          for (let k = 0; k < 8; k++) {
            const i = b * 8 + k;
            if (i >= this.cells.length || !(v & (1 << k))) continue;
            const cell = this.cells[i];
            const [r, c] = sym(Math.floor(cell / 7), cell % 7);
            out += 2 ** this.index.get(r * 7 + c)!;
          }
          table[v] = out;
        }
        return table;
      }),
    );
  }

  private bit(i: number): [number, number] {
    return i < 32 ? [(1 << i) >>> 0, 0] : [0, 1 << (i - 32)];
  }

  // The smallest of the 8 symmetric forms of a position, as one exact number.
  private canonical(lo: number, hi: number): number {
    let best = Infinity;
    const b0 = lo & 255;
    const b1 = (lo >>> 8) & 255;
    const b2 = (lo >>> 16) & 255;
    const b3 = lo >>> 24;
    const b4 = hi & 255;
    for (const t of this.symTables) {
      const out = t[0][b0] + t[1][b1] + t[2][b2] + t[3][b3] + (t[4] ? t[4][b4] : 0);
      if (out < best) best = out;
    }
    return best;
  }

  solve(req: SolveRequest): SolveResult {
    const finals = possibleFinals(this.kind, req.pegs);
    if (!finals.length) return { id: req.id, status: 'none' };

    let lo0 = 0;
    let hi0 = 0;
    for (const p of req.pegs) {
      const [l, h] = this.bit(this.index.get(p)!);
      lo0 = (lo0 | l) >>> 0;
      hi0 |= h;
    }
    const [cl, ch] = this.bit(this.index.get(CENTRE)!);
    const deadline = performance.now() + req.budgetMs;

    const attempt = (centreOnly: boolean, until: number): [Cell, Cell][] | null => {
      const failed = this.failed[centreOnly ? 1 : 0];
      const path: [Cell, Cell][] = [];
      let nodes = 0;
      const dfs = (lo: number, hi: number, count: number): boolean => {
        if (count === 1) return !centreOnly || (lo & cl) !== 0 || (hi & ch) !== 0;
        const key = this.canonical(lo, hi);
        if (failed.has(key)) return false;
        if ((++nodes & 1023) === 0 && performance.now() > until) throw new OutOfTime();
        for (const j of this.jumps) {
          const f = (lo & j.fl) !== 0 || (hi & j.fh) !== 0;
          const o = (lo & j.ol) !== 0 || (hi & j.oh) !== 0;
          const t = (lo & j.tl) !== 0 || (hi & j.th) !== 0;
          if (f && o && !t) {
            path.push([j.from, j.to]);
            const nl = ((lo & ~j.fl & ~j.ol) | j.tl) >>> 0;
            const nh = (hi & ~j.fh & ~j.oh) | j.th;
            if (dfs(nl, nh, count - 1)) return true;
            path.pop();
          }
        }
        failed.add(key);
        return false;
      };
      return dfs(lo0, hi0, req.pegs.length) ? path : null;
    };

    try {
      // Try for a centre finish when the rule of three allows it.
      if (finals.includes(CENTRE)) {
        try {
          const centred = attempt(true, performance.now() + req.budgetMs * 0.5);
          if (centred) return { id: req.id, status: 'found', path: centred, centre: true };
        } catch (e) {
          if (!(e instanceof OutOfTime)) throw e;
        }
      }
      // A full search that finds nothing proves one peg can't be reached.
      const any = attempt(false, deadline);
      if (any) return { id: req.id, status: 'found', path: any, centre: false };
      return { id: req.id, status: 'none' };
    } catch (e) {
      if (e instanceof OutOfTime) return { id: req.id, status: 'timeout' };
      throw e;
    }
  }
}
