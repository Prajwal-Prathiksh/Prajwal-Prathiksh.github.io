// The computer opponent for Four in a Row.
//
// Hard plays perfectly. Its opening moves come from a small book of solved
// positions (`npm run fourinarow:book`); after that the solver proves a
// winning move in the browser, falling back to a deep heuristic search only
// if a proof would take too long. Medium searches a few moves ahead and Easy
// one or two, with some slack, so both can be beaten.

import book from '../data/four-in-a-row-book.json';
import { ORDER, OUT_OF_TIME, Position, Solver, WIDTH, searchScore } from './fourInARow';

export type Level = 'easy' | 'medium' | 'hard';

export interface Choice {
  col: number;
  // Hard only: 1 if the move is proven to win, 0 to draw, -1 to lose; null
  // when it was chosen by search.
  proof: number | null;
}

const BOOK = book as Record<string, number>;
// Off the book, the first move number at which a proof usually finishes in time.
const EARLIEST_PROOF = 6;
const mirror = (seq: readonly number[]) => seq.map((c) => WIDTH - 1 - c);

export function bookMove(seq: readonly number[]): number | null {
  const own = BOOK[seq.join('')];
  if (own !== undefined) return own;
  const flipped = BOOK[mirror(seq).join('')];
  return flipped === undefined ? null : WIDTH - 1 - flipped;
}

const legal = (p: Position) => ORDER.filter((c) => p.canPlay(c));

function immediate(p: Position): number | null {
  return legal(p).find((c) => p.isWinningMove(c)) ?? null;
}

// Moves that do not let the opponent win straight away; every legal move
// when none are safe.
function safeMoves(p: Position): number[] {
  const all = legal(p);
  const safe = all.filter((c) => {
    const next = p.clone();
    next.play(c);
    return !next.canWinNext();
  });
  return safe.length ? safe : all;
}

function searched(p: Position, cols: number[], depth: number): { col: number; score: number }[] {
  return cols.map((col) => {
    const next = p.clone();
    next.play(col);
    return { col, score: -searchScore(next, depth - 1) };
  });
}

const pick = <T>(items: T[], random: () => number) => items[Math.floor(random() * items.length)];

function easy(p: Position, random: () => number): number {
  const win = immediate(p);
  if (win !== null && random() < 0.9) return win;
  const cols = random() < 0.6 ? safeMoves(p) : legal(p);
  const scored = searched(p, cols, 2);
  const best = Math.max(...scored.map((s) => s.score));
  // Anything within a fair margin of the best, so it often misses ideas.
  return pick(scored.filter((s) => s.score >= best - 25).map((s) => s.col), random);
}

function medium(p: Position, random: () => number): number {
  const win = immediate(p);
  if (win !== null) return win;
  const scored = searched(p, safeMoves(p), 6);
  const best = Math.max(...scored.map((s) => s.score));
  return pick(scored.filter((s) => s.score >= best - 4).map((s) => s.col), random);
}

function hard(seq: readonly number[], p: Position, solver: Solver, thinkMs: number): Choice {
  const win = immediate(p);
  if (win !== null) return { col: win, proof: 1 };
  const fromBook = bookMove(seq);
  if (fromBook !== null) return { col: fromBook, proof: 1 };
  const cols = safeMoves(p);
  if (cols.length === 1) return { col: cols[0], proof: null };
  // Off the book in the first few moves a proof takes minutes, so search.
  if (p.moves < EARLIEST_PROOF) {
    return { col: searched(p, cols, 8).sort((x, y) => y.score - x.score)[0].col, proof: null };
  }

  const deadline = performance.now() + thinkMs;
  const draws: number[] = [];
  const unknown: number[] = [];
  for (const col of cols) {
    const next = p.clone();
    next.play(col);
    try {
      const result = -solver.outcome(next, deadline);
      if (result > 0) return { col, proof: 1 };
      if (result === 0) draws.push(col);
    } catch (error) {
      if (error !== OUT_OF_TIME) throw error;
      unknown.push(col, ...cols.slice(cols.indexOf(col) + 1));
      break;
    }
  }
  if (draws.length && !unknown.length) return { col: draws[0], proof: 0 };
  // No proof in time: search the open candidates, keeping a proven draw if
  // the search finds nothing better.
  const open = unknown.length ? unknown : cols;
  const best = searched(p, open, 8).sort((a, b) => b.score - a.score)[0];
  if (draws.length && best.score < 50) return { col: draws[0], proof: 0 };
  // Every move loses against perfect play: resist as long as possible.
  if (!draws.length && !unknown.length) {
    try {
      const scores = solver.scores(p, performance.now() + thinkMs);
      let top = best.col;
      for (const col of cols) if ((scores[col] ?? -99) > (scores[top] ?? -99)) top = col;
      return { col: top, proof: -1 };
    } catch (error) {
      if (error !== OUT_OF_TIME) throw error;
    }
  }
  return { col: best.col, proof: null };
}

export function chooseMove(
  seq: readonly number[],
  level: Level,
  solver: Solver,
  options: { thinkMs?: number; random?: () => number } = {},
): Choice {
  const p = Position.from(seq);
  const random = options.random ?? Math.random;
  if (level === 'easy') return { col: easy(p, random), proof: null };
  if (level === 'medium') return { col: medium(p, random), proof: null };
  return hard(seq, p, solver, options.thinkMs ?? 2500);
}
