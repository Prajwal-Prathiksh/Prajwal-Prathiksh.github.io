// The Four in a Row coach's solver, off the main thread.
//
// verdicts: how every column turns out for the player to move, sent one
// column at a time as each is proven, first win/draw/lose and then, time
// permitting, how many coins it takes.
// line: the rest of the game after a given column, both sides playing their
// best (the winner as fast as it can, the loser holding out longest).
//
// Early positions take too long to prove in a browser. The first move is
// known from the published solution, the book covers the winner's moves in
// the opening, and anything else that early is reported as unknown or, in a
// line, played by the heuristic search and marked as a guess.

import { CELLS, ORDER, OUT_OF_TIME, Position, Solver, lastMoverWon, searchScore } from './fourInARow';
import { bookMove } from './fourInARowAI';

export type CoachRequest =
  | { id: number; kind: 'verdicts'; seq: number[] }
  | { id: number; kind: 'line'; seq: number[]; col: number };

export interface Verdict {
  col: number;
  /** For the player to move: 1 wins, 0 draws, -1 loses, null not known. */
  outcome: 1 | 0 | -1 | null;
  /** Exact solver score when known (positive wins sooner the higher). */
  score: number | null;
  source: 'proof' | 'theory' | 'book' | 'unknown';
}

export type CoachResponse =
  | { id: number; kind: 'verdict'; verdict: Verdict }
  | { id: number; kind: 'verdicts-done' }
  | { id: number; kind: 'line'; line: number[]; guessed: boolean[]; end: 'win' | 'draw' | 'open' };

// Fewer coins than this and a proof usually takes too long in a browser.
const PROVABLE_FROM = 5;
// The published solution for the first coin: only the middle column wins.
const FIRST_MOVE: (1 | 0 | -1)[] = [-1, -1, 0, 1, 0, -1, -1];

let solver: Solver | null = null;

function withTime<T>(work: () => T): T | null {
  try {
    return work();
  } catch (error) {
    if (error !== OUT_OF_TIME) throw error;
    return null;
  }
}

function verdicts(id: number, seq: number[]) {
  solver ??= new Solver();
  const s = solver;
  const p = Position.from(seq);
  const cols = ORDER.filter((c) => p.canPlay(c));
  const post = (verdict: Verdict) => self.postMessage({ id, kind: 'verdict', verdict } satisfies CoachResponse);
  const open: number[] = [];
  for (const col of cols) {
    if (p.isWinningMove(col)) {
      post({ col, outcome: 1, score: (CELLS + 1 - p.moves) >> 1, source: 'proof' });
    } else if (seq.length === 0) {
      post({ col, outcome: FIRST_MOVE[col], score: null, source: 'theory' });
    } else if (seq.length >= 1 && seq.length + 1 < PROVABLE_FROM
      && (seq.length === 1 ? seq[0] === 3 : bookMove(seq.slice(0, -1)) === seq[seq.length - 1])) {
      // The middle opening, and every book move after it, leaves the other
      // side lost: whatever they play next loses.
      post({ col, outcome: -1, score: null, source: seq.length === 1 ? 'theory' : 'book' });
    } else if (seq.length + 1 < PROVABLE_FROM) {
      post(bookMove(seq) === col
        ? { col, outcome: 1, score: null, source: 'book' }
        : { col, outcome: null, score: null, source: 'unknown' });
    } else {
      open.push(col);
    }
  }
  // First pass: win, draw or lose, which is quick. Second pass: exact scores.
  const outcomes = new Map<number, number>();
  for (const col of open) {
    const next = p.clone();
    next.play(col);
    const result = withTime(() => -s.outcome(next, performance.now() + 2500));
    if (result === null) post({ col, outcome: null, score: null, source: 'unknown' });
    else {
      outcomes.set(col, result);
      post({ col, outcome: result as 1 | 0 | -1, score: null, source: 'proof' });
    }
  }
  for (const col of open) {
    if (!outcomes.has(col)) continue;
    const next = p.clone();
    next.play(col);
    const score = withTime(() => -s.solve(next, performance.now() + 2500));
    if (score !== null) post({ col, outcome: Math.sign(score) as 1 | 0 | -1, score, source: 'proof' });
  }
  self.postMessage({ id, kind: 'verdicts-done' } satisfies CoachResponse);
}

// Early on, before proofs are practical: the book's move if it has one, else
// the best move by heuristic search that does not hand over an instant win.
function guessMove(seq: number[], p: Position): number {
  const fromBook = bookMove(seq);
  if (fromBook !== null) return fromBook;
  const cols = ORDER.filter((c) => p.canPlay(c));
  const win = cols.find((c) => p.isWinningMove(c));
  if (win !== undefined) return win;
  let best = cols[0];
  let bestScore = -Infinity;
  for (const col of cols) {
    const next = p.clone();
    next.play(col);
    const score = next.canWinNext() ? -1e9 : -searchScore(next, 6);
    if (score > bestScore) { best = col; bestScore = score; }
  }
  return best;
}

function line(id: number, seq: number[], first: number) {
  solver ??= new Solver();
  const s = solver;
  const moves = [first];
  const guessed = [false];
  const played = [...seq, first];
  const p = Position.from(played);
  const stop = performance.now() + 8000;
  let end: 'win' | 'draw' | 'open' = 'open';
  while (true) {
    if (lastMoverWon(p)) { end = 'win'; break; }
    if (p.moves >= CELLS) { end = 'draw'; break; }
    if (performance.now() > stop) break;
    let col: number | null = null;
    let guess = false;
    if (p.moves < PROVABLE_FROM) {
      col = guessMove(played, p);
      guess = true;
    } else {
      const scores = withTime(() => s.scores(p, stop));
      if (!scores) break;
      for (const c of ORDER) if (scores[c] !== null && (col === null || scores[c]! > scores[col]!)) col = c;
    }
    if (col === null) break;
    p.play(col);
    played.push(col);
    moves.push(col);
    guessed.push(guess);
  }
  self.postMessage({ id, kind: 'line', line: moves, guessed, end } satisfies CoachResponse);
}

self.onmessage = (event: MessageEvent<CoachRequest>) => {
  const request = event.data;
  if (request.kind === 'verdicts') verdicts(request.id, request.seq);
  else line(request.id, request.seq, request.col);
};
