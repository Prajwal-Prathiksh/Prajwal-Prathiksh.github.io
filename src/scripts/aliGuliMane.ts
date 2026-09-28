// Rules for Ali Guli Mane, a mancala game from Karnataka.
//
// Holes 0-6 are yours (left to right along the bottom), 7-13 the computer's
// (right to left along the top), so +1 runs anticlockwise round the board.
// Hole i faces hole 13 - i.

export type Player = 0 | 1;
export type Direction = 1 | -1; // 1 = anticlockwise, -1 = clockwise

export interface Config {
  perHole: number;
  direction: Direction;
  fourRule: boolean; // a hole that reaches four while sowing goes to the sower
}

export interface State {
  pits: number[];
  closed: boolean[]; // holes left empty in a handicap round
  captured: [number, number]; // includes shells set aside at the start of a round
}

export type Event =
  | { type: 'pick'; hole: number; count: number }
  | { type: 'drop'; hole: number }
  | { type: 'four'; hole: number; player: Player }
  | { type: 'capture'; holes: number[]; count: number; player: Player }
  | { type: 'miss'; hole: number };

export const HOLES = 14;
const MAX_DROPS = 10_000; // relay sowing can in theory cycle forever

export const owner = (hole: number): Player => (hole < 7 ? 0 : 1);
export const opposite = (hole: number) => 13 - hole;
export const holesOf = (p: Player) => (p === 0 ? [0, 1, 2, 3, 4, 5, 6] : [7, 8, 9, 10, 11, 12, 13]);

const clone = (s: State): State => ({
  pits: [...s.pits],
  closed: [...s.closed],
  captured: [...s.captured],
});

export function newRound(perHole: number, totals?: [number, number]): State {
  const pits = Array(HOLES).fill(0);
  const closed = Array(HOLES).fill(false);
  const captured: [number, number] = [0, 0];
  for (const p of [0, 1] as const) {
    const total = totals ? totals[p] : perHole * 7;
    const filled = Math.min(7, Math.floor(total / perHole));
    holesOf(p).forEach((h, i) => {
      if (i < filled) pits[h] = perHole;
      else closed[h] = true;
    });
    captured[p] = total - filled * perHole;
  }
  return { pits, closed, captured };
}

// A player who can't fill a single hole has lost the match.
export const canPlayRound = (perHole: number, total: number) => total >= perHole;

export const legalMoves = (s: State, p: Player) => holesOf(p).filter((h) => !s.closed[h] && s.pits[h] > 0);

const step = (s: State, hole: number, dir: Direction) => {
  let h = hole;
  do h = (h + dir + HOLES) % HOLES;
  while (s.closed[h]);
  return h;
};

export function play(start: State, player: Player, hole: number, cfg: Config, events?: Event[]): State {
  const s = clone(start);
  let source = hole;
  let hand = s.pits[source];
  s.pits[source] = 0;
  events?.push({ type: 'pick', hole: source, count: hand });
  let at = source;
  let drops = 0;

  for (;;) {
    while (hand > 0) {
      at = step(s, at, cfg.direction);
      if (at === source) continue; // skip the hole the shells came from
      s.pits[at]++;
      hand--;
      events?.push({ type: 'drop', hole: at });
      if (cfg.fourRule && s.pits[at] === 4) {
        s.captured[player] += 4;
        s.pits[at] = 0;
        events?.push({ type: 'four', hole: at, player });
      }
      if (++drops > MAX_DROPS) return s;
    }

    const next = step(s, at, cfg.direction);
    if (s.pits[next] > 0) {
      source = next;
      at = next;
      hand = s.pits[next];
      s.pits[next] = 0;
      events?.push({ type: 'pick', hole: next, count: hand });
      continue;
    }

    const target = step(s, next, cfg.direction);
    if (s.pits[target] === 0) {
      events?.push({ type: 'miss', hole: target });
      return s;
    }
    const holes = [target, opposite(target)];
    const count = holes.reduce((n, h) => n + s.pits[h], 0);
    holes.forEach((h) => (s.pits[h] = 0));
    s.captured[player] += count;
    events?.push({ type: 'capture', holes, count, player });
    return s;
  }
}

// The round ends once either row is empty; each player keeps what's left on their side.
export const roundOver = (s: State) => legalMoves(s, 0).length === 0 || legalMoves(s, 1).length === 0;

export function finishRound(s: State): [number, number] {
  const side = (p: Player) => holesOf(p).reduce((n, h) => n + s.pits[h], 0);
  return [s.captured[0] + side(0), s.captured[1] + side(1)];
}

// ---- Computer player ----

const score = (s: State, p: Player) => {
  if (roundOver(s)) {
    const [a, b] = finishRound(s);
    return (p === 0 ? a - b : b - a) * 100;
  }
  return p === 0 ? s.captured[0] - s.captured[1] : s.captured[1] - s.captured[0];
};

function search(s: State, p: Player, depth: number, alpha: number, beta: number, cfg: Config, deadline: number): number {
  if (depth === 0 || roundOver(s) || performance.now() > deadline) return score(s, p);
  let best = -Infinity;
  for (const h of legalMoves(s, p)) {
    const v = -search(play(s, p, h, cfg), (1 - p) as Player, depth - 1, -beta, -alpha, cfg, deadline);
    if (v > best) best = v;
    if (best > alpha) alpha = best;
    if (alpha >= beta) break;
  }
  return best;
}

export function computerMove(s: State, p: Player, cfg: Config, level: 'easy' | 'hard'): number {
  const moves = legalMoves(s, p);
  const pick = <T>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)];
  if (level === 'easy') {
    if (Math.random() < 0.4) return pick(moves);
    const gains = moves.map((h) => score(play(s, p, h, cfg), p));
    const top = Math.max(...gains);
    return pick(moves.filter((_, i) => gains[i] === top));
  }

  // Iterative deepening within a time budget, keeping the last full answer.
  const deadline = performance.now() + 350;
  let choice = pick(moves);
  for (let depth = 1; depth <= 10; depth++) {
    let best = -Infinity;
    let bestMoves: number[] = [];
    for (const h of moves) {
      const v = -search(play(s, p, h, cfg), (1 - p) as Player, depth - 1, -Infinity, Infinity, cfg, deadline);
      if (v > best) [best, bestMoves] = [v, [h]];
      else if (v === best) bestMoves.push(h);
    }
    if (performance.now() > deadline) break;
    choice = pick(bestMoves);
  }
  return choice;
}
