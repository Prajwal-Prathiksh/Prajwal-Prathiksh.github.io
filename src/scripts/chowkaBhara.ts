// Rules for Chowka Bhara on a 5x5 board.
//
// Seats: 0 bottom, 1 right, 2 top, 3 left. Each pawn follows its own path:
// 16 outer squares anticlockwise from its home square, then 8 inner squares
// clockwise, then the centre. Until its player has hit an opponent, a pawn
// can go no further than the square before its home square. A pawn's position
// is its index along that path: -1 means waiting off the board (only before
// a pawn is first brought in), 0 is the home square, where a hit pawn returns,
// and 24 means it has reached the centre.
//
// A pawn may share a square with its own side only on a safe square or, two at
// most, in the inner ring unless a committed pair joins friendly singles.
// Two pawns meeting on their first inner square may
// move off together as a pair; until then they are still vulnerable singles and
// may split. Once they leave together they stay a pair for good. Two meeting on
// any other inner square just sit together, and
// an opponent landing there knocks out only one of them. A pair moves half the
// throw (so 2, 4 and 8 move it 1, 2 and 4), can only hit another pair (it
// shares a square with lone pawns), and can't be jumped. An opponent's single
// may land exactly on the pair's square (hitting nothing). A friendly single
// can land on or pass through its own pair freely.

export type Seat = 0 | 1 | 2 | 3;
export type Square = readonly [number, number]; // [row, col], row 0 at the top

export const HOME = 24;
export const LAST_OUTER = 15;
export const PAIR_SQUARE = 16; // the first inner square, the only place pairs form
export const WAITING = -1;
export type EntryMode = 'home' | 'all' | 'each';
const SOLO = -1;

export interface PlayerState {
  seat: Seat;
  pawns: number[];
  partner: number[]; // potential pair on square 16 or committed pair beyond it; -1 otherwise
  hasHit: boolean; // unlocks the inner ring for all of this player's pawns
}

export interface State {
  players: PlayerState[];
  entry: EntryMode;
}

export interface Move {
  player: number;
  pawns: number[]; // one pawn, a pair, or all waiting pawns entering together
  value: number; // the throw spent
  steps: number; // squares moved: the throw, or half of it for a pair
  from: number;
  to: number;
}

export interface Hit {
  player: number;
  pawn: number;
}

// Bottom seat's path; the other seats are the same path turned.
const OUTER: Square[] = [
  [4, 2], [4, 3], [4, 4], [3, 4], [2, 4], [1, 4], [0, 4], [0, 3],
  [0, 2], [0, 1], [0, 0], [1, 0], [2, 0], [3, 0], [4, 0], [4, 1],
];
const INNER: Square[] = [[3, 1], [2, 1], [1, 1], [1, 2], [1, 3], [2, 3], [3, 3], [3, 2]];
const BASE_PATH: Square[] = [...OUTER, ...INNER, [2, 2]];

// A quarter turn anticlockwise on screen takes the bottom seat to the right seat.
const turn = ([r, c]: Square): Square => [4 - c, r];

const PATHS: Square[][] = [0, 1, 2, 3].map((seat) =>
  BASE_PATH.map((sq) => {
    let s = sq;
    for (let i = 0; i < seat; i++) s = turn(s);
    return s;
  }),
);

export const square = (seat: Seat, index: number): Square => PATHS[seat][index];
export const keyOf = ([r, c]: Square) => r * 5 + c;

const SAFE = new Set([keyOf([4, 2]), keyOf([2, 4]), keyOf([0, 2]), keyOf([2, 0]), keyOf([2, 2])]);
export const isSafe = (sq: Square) => SAFE.has(keyOf(sq));

// A 4 or 8 is spent to enter either one pawn or all four, depending on setup.
export function newGame(seats: Seat[], entry: EntryMode = 'each'): State {
  const start = entry === 'home' ? 0 : WAITING;
  return {
    entry,
    players: seats.map((seat) => ({
      seat,
      pawns: [start, start, start, start],
      partner: [SOLO, SOLO, SOLO, SOLO],
      hasHit: false,
    })),
  };
}

const clone = (s: State): State => ({
  entry: s.entry,
  players: s.players.map((p) => ({ ...p, pawns: [...p.pawns], partner: [...p.partner] })),
});

export const isPotentialPair = (s: State, player: number, pawn: number) =>
  s.players[player].partner[pawn] !== SOLO && s.players[player].pawns[pawn] === PAIR_SQUARE;
export const isPaired = (s: State, player: number, pawn: number) =>
  s.players[player].partner[pawn] !== SOLO && s.players[player].pawns[pawn] > PAIR_SQUARE && s.players[player].pawns[pawn] < HOME;

interface Occupant extends Hit {
  paired: boolean;
}

// Who stands on each board square.
function occupancy(s: State) {
  const map = new Map<number, Occupant[]>();
  s.players.forEach((p, player) =>
    p.pawns.forEach((pos, pawn) => {
      if (pos < 0 || pos === HOME) return;
      const k = keyOf(square(p.seat, pos));
      if (!map.has(k)) map.set(k, []);
      map.get(k)!.push({ player, pawn, paired: isPaired(s, player, pawn) });
    }),
  );
  return map;
}

const opponents = (occ: Map<number, Occupant[]>, sq: Square, player: number) =>
  isSafe(sq) ? [] : (occ.get(keyOf(sq)) ?? []).filter((o) => o.player !== player);

function tryMove(s: State, occ: Map<number, Occupant[]>, player: number, pawns: number[], value: number): Move | null {
  const p = s.players[player];
  const from = p.pawns[pawns[0]];
  if (from === HOME) return null;
  if (from === WAITING) {
    return pawns.length === 1 && (value === 4 || value === 8)
      ? { player, pawns: s.entry === 'all' ? [0, 1, 2, 3] : pawns, value, steps: 0, from, to: 0 }
      : null;
  }
  const pair = pawns.length === 2;
  if (pair && value % 2) return null; // a pair needs an even throw
  // A pair splits only on the square where it formed.
  if (!pair && p.partner[pawns[0]] !== SOLO && from !== PAIR_SQUARE) return null;
  const steps = pair ? value / 2 : value;
  const to = from + steps;
  if (to > HOME) return null; // the centre needs an exact throw
  if (!p.hasHit && to > LAST_OUTER) return null; // the inner ring opens after a first hit

  // Own pawns may share safe squares or an inner square two at a time.
  // Singles may join a friendly pair; a pair may join friendly singles.
  if (to !== HOME) {
    const sq = square(p.seat, to);
    const mine = (occ.get(keyOf(sq)) ?? []).filter((o) => o.player === player && !pawns.includes(o.pawn));
    const friendlyShare = to >= PAIR_SQUARE && (pair
      ? mine.every((o) => !o.paired)
      : mine.length === 1 || mine.some((o) => o.paired));
    if (mine.length && !isSafe(sq) && !friendlyShare) return null;
  }

  if (!pair) {
    // An opposing single must land on a committed pair before passing it.
    // A friendly single can land on or pass its own pair freely.
    for (let i = from + 1; i < to; i++) {
      if (opponents(occ, square(p.seat, i), player).some((o) => o.paired)) return null;
    }
  }
  // A pair may land anywhere in the inner ring: it hits only a pair there and
  // simply shares the square with any lone pawns.
  return { player, pawns, value, steps, from, to };
}

export function legalMoves(s: State, player: number, value: number): Move[] {
  const occ = occupancy(s);
  const p = s.players[player];
  const moves: Move[] = [];
  let waitingTried = false;
  p.pawns.forEach((pos, pawn) => {
    if (pos === WAITING) {
      if (waitingTried) return; // waiting pawns are interchangeable
      waitingTried = true;
    }
    const m = tryMove(s, occ, player, [pawn], value);
    if (m) moves.push(m);
  });
  p.partner.forEach((b, a) => {
    if (b > a) {
      const m = tryMove(s, occ, player, [a, b], value);
      if (m) moves.push(m);
    }
  });
  return moves;
}

export function apply(start: State, move: Move): { state: State; hits: Hit[] } {
  const s = clone(start);
  const p = s.players[move.player];

  // Moving one pawn of a pair on its own splits the pair for good.
  if (move.pawns.length === 1) {
    const mate = p.partner[move.pawns[0]];
    if (mate !== SOLO) p.partner[mate] = p.partner[move.pawns[0]] = SOLO;
  }
  move.pawns.forEach((i) => (p.pawns[i] = move.to));
  if (move.to === HOME) move.pawns.forEach((i) => (p.partner[i] = SOLO));

  // Two lone pawns meeting on the first inner square can pair on a later move.
  if (move.to === PAIR_SQUARE && move.pawns.length === 1) {
    const mate = p.pawns.findIndex((pos, i) => i !== move.pawns[0] && pos === PAIR_SQUARE && p.partner[i] === SOLO);
    if (mate >= 0) {
      p.partner[mate] = move.pawns[0];
      p.partner[move.pawns[0]] = mate;
    }
  }

  let hits: Hit[] = [];
  if (move.to > 0 && move.to < HOME) {
    const sq = square(p.seat, move.to);
    if (!isSafe(sq)) {
      const there = opponents(occupancy(start), sq, move.player);
      // A pair takes out a pair. A single takes out one lone pawn, never a pair.
      hits =
        move.pawns.length === 2
          ? there.filter((o) => o.paired)
          : there.filter((o) => !o.paired).slice(0, 1);
      hits = hits.map(({ player, pawn }) => ({ player, pawn }));
      hits.forEach((h) => {
        const q = s.players[h.player];
        const mate = q.partner[h.pawn];
        if (mate !== SOLO) q.partner[mate] = SOLO;
        q.pawns[h.pawn] = 0; // back to its home square, already in play
        q.partner[h.pawn] = SOLO;
      });
      if (hits.length) p.hasHit = true;
    }
  }
  return { state: s, hits };
}

export const finished = (s: State, player: number) => s.players[player].pawns.every((x) => x === HOME);

// Rarely, every player still racing is stuck for good (say, pawns lined up at
// the inner-ring gate with no hit yet, out of everyone's reach). No throw can
// change that, so the game ends as a draw.
export const frozen = (s: State) =>
  s.players.every((_, i) => finished(s, i) || [1, 2, 3, 4, 8].every((v) => legalMoves(s, i, v).length === 0));

// Four cowries: the count landing mouth-up is the throw, and none up counts as 8.
export function throwShells(): { up: boolean[]; value: number } {
  const up = Array.from({ length: 4 }, () => Math.random() < 0.5);
  const n = up.filter(Boolean).length;
  return { up, value: n === 0 ? 8 : n };
}
export const isBonus = (value: number) => value === 4 || value === 8;
export const THROW_VALUES = [1, 2, 3, 4, 8];

// Shells that show a given throw, for when the value is chosen rather than thrown.
export function shellsFor(value: number): boolean[] {
  const ups = value === 8 ? 0 : value;
  const up = [0, 1, 2, 3].map((i) => i < ups);
  for (let i = up.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [up[i], up[j]] = [up[j], up[i]];
  }
  return up;
}

// ---- Throws within a turn ----
//
// A turn starts owing one throw. Every 4 or 8 and every hit owes another, and
// the player takes owed throws whenever they like, before or after moving.
// The risk count is how many 4s and 8s from the current run are still held:
// it rises with each 4 or 8 thrown, falls when one is spent, and resets on a
// 1, 2 or 3. Reaching three loses everything left in the turn, so at two the
// player may skip a throw instead.

export interface Turn {
  bank: number[];
  owed: number;
  streak: number;
  run: number[]; // the 4s and 8s behind the risk count, for messages
}

export const RISKY = 2;
export const newTurn = (): Turn => ({ bank: [], owed: 1, streak: 0, run: [] });
export const endedTurn = (): Turn => ({ bank: [], owed: 0, streak: 0, run: [] });
export const canSkip = (t: Turn) => t.owed > 0 && t.streak >= RISKY;

export function recordThrow(t: Turn, value: number): 'bonus' | 'plain' | 'lost' {
  t.owed--;
  if (!isBonus(value)) {
    t.streak = 0;
    t.run = [];
    t.bank.push(value);
    return 'plain';
  }
  if (++t.streak > RISKY) {
    t.bank = [];
    t.owed = 0;
    t.streak = 0;
    return 'lost';
  }
  t.run.push(value);
  t.bank.push(value);
  t.owed++;
  return 'bonus';
}

export function recordSpend(t: Turn, value: number, hit: boolean): void {
  t.bank.splice(t.bank.indexOf(value), 1);
  if (isBonus(value) && t.streak > 0) {
    t.streak--;
    t.run.splice(t.run.indexOf(value) >= 0 ? t.run.indexOf(value) : 0, 1);
  }
  if (hit) t.owed++;
}

export const usable = (s: State, player: number, t: Turn) => t.bank.filter((v) => legalMoves(s, player, v).length);
export const stranded = (s: State, player: number, t: Turn) => t.bank.length > 0 && usable(s, player, t).length === 0;
export const turnOver = (s: State, player: number, t: Turn) => t.owed === 0 && usable(s, player, t).length === 0;

// A throw may carry a chosen value (for testing); otherwise the shells decide.
export type Action = { kind: 'throw'; value?: number } | { kind: 'skip' } | { kind: 'move'; move: Move };
