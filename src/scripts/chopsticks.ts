// Rules and exact solution for Chopsticks (hands 0-4, sums wrap mod 5).
// A position is [mover's hands, opponent's hands]. Hand order does not matter.

export type Hands = [number, number];
export type Move =
  | { kind: 'attack'; from: 0 | 1; to: 0 | 1 }
  | { kind: 'split'; into: Hands };
export type Outcome = { result: 'W' | 'L' | 'D'; plies: number };

const sorted = ([a, b]: Hands): Hands => (a <= b ? [a, b] : [b, a]);
export const isDead = (h: Hands) => h[0] === 0 && h[1] === 0;
export const key = (me: Hands, op: Hands) => `${sorted(me)}|${sorted(op)}`;

export function legalMoves(me: Hands, op: Hands): Move[] {
  const moves: Move[] = [];
  for (const from of [0, 1] as const) {
    if (me[from] === 0) continue;
    for (const to of [0, 1] as const) {
      if (op[to] !== 0) moves.push({ kind: 'attack', from, to });
    }
  }
  const total = me[0] + me[1];
  const current = sorted(me).join();
  for (const t of new Set([total, total - 5])) {
    for (let a = Math.max(0, t - 4); a <= t / 2; a++) {
      const into: Hands = [a, t - a];
      if (t > 0 && into.join() !== current) moves.push({ kind: 'split', into });
    }
  }
  return moves;
}

// Returns [mover's hands, opponent's hands] after the move.
export function apply(me: Hands, op: Hands, move: Move): [Hands, Hands] {
  if (move.kind === 'split') return [[...move.into], [...op]];
  const next: Hands = [...op];
  next[move.to] = (next[move.to] + me[move.from]) % 5;
  return [[...me], next];
}

// Retrograde analysis over all 196 live positions. W positions store the
// fewest plies to a forced win, L positions the most plies before the loss.
function solve(): Map<string, Outcome> {
  const live: Hands[] = [];
  for (let a = 0; a <= 4; a++) for (let b = a; b <= 4; b++) if (a || b) live.push([a, b]);
  const positions = live.flatMap((me) => live.map((op) => [me, op] as [Hands, Hands]));
  const table = new Map<string, Outcome>();

  for (let changed = true; changed; ) {
    changed = false;
    const snapshot = new Map(table);
    for (const [me, op] of positions) {
      const k = key(me, op);
      if (table.has(k)) continue;
      const children = legalMoves(me, op).map((m) => {
        const [mine, theirs] = apply(me, op, m);
        return isDead(theirs) ? ({ result: 'L', plies: 0 } as Outcome) : snapshot.get(key(theirs, mine));
      });
      const losses = children.filter((c) => c?.result === 'L');
      if (losses.length) {
        table.set(k, { result: 'W', plies: 1 + Math.min(...losses.map((c) => c!.plies)) });
        changed = true;
      } else if (children.every((c) => c?.result === 'W')) {
        table.set(k, { result: 'L', plies: 1 + Math.max(...children.map((c) => c!.plies)) });
        changed = true;
      }
    }
  }
  for (const [me, op] of positions) {
    if (!table.has(key(me, op))) table.set(key(me, op), { result: 'D', plies: 0 });
  }
  return table;
}

const table = solve();

const pick = <T>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)];

export function bestMove(me: Hands, op: Hands, randomness = 0): Move {
  const moves = legalMoves(me, op);
  if (Math.random() < randomness) return pick(moves);

  // Score each move from the opponent's side: their loss is our gain.
  const scored = moves.map((move) => {
    const [mine, theirs] = apply(me, op, move);
    const reply = isDead(theirs) ? { result: 'L', plies: 0 } : table.get(key(theirs, mine))!;
    const score =
      reply.result === 'L' ? 1000 - reply.plies : reply.result === 'D' ? 0 : -1000 + reply.plies;
    return { move, score };
  });
  const top = Math.max(...scored.map((s) => s.score));
  return pick(scored.filter((s) => s.score === top)).move;
}
