// Four in a Row: four in a row on a 7x6 rack. A perfect-play solver after
// Pascal Pons' Connect-4 solver (bitboards, negamax with alpha-beta, a
// transposition table, null-window iterative deepening and threat-ordered
// moves), adapted to JavaScript.
//
// A board is 49 bits: seven columns of seven bits, the top bit of each
// column a sentinel. Bit (col * 7 + row) is row `row` of column `col`, row 0
// at the bottom. JavaScript bitwise operators work on 32 bits, so every
// bitboard is kept as two halves: `lo` holds columns 0-3 (28 bits) and `hi`
// columns 4-6 (21 bits). Shifts carry bits across the halves.

export const WIDTH = 7;
export const HEIGHT = 6;
const H1 = HEIGHT + 1;
export const CELLS = WIDTH * HEIGHT;
const LO_BITS = 28;
const LO_MASK = 0x0fffffff;
const HI_MASK = 0x1fffff;
const SPLIT = 2 ** LO_BITS;

// One bit at the bottom of every column, and every playable cell.
let bottomLo = 0;
let bottomHi = 0;
for (let c = 0; c < WIDTH; c++) {
  if (c < 4) bottomLo |= 1 << (c * H1);
  else bottomHi |= 1 << ((c - 4) * H1);
}
const boardLo = Math.imul(bottomLo, (1 << HEIGHT) - 1) & LO_MASK;
const boardHi = Math.imul(bottomHi, (1 << HEIGHT) - 1) & HI_MASK;

// Shift results land here to avoid allocating pairs in the hot loops.
let RL = 0;
let RH = 0;
function shl(hi: number, lo: number, n: number) {
  RH = ((hi << n) | (lo >>> (LO_BITS - n))) & HI_MASK;
  RL = (lo << n) & LO_MASK;
}
function shr(hi: number, lo: number, n: number) {
  RL = ((lo >>> n) | (hi << (LO_BITS - n))) & LO_MASK;
  RH = hi >>> n;
}

function popcount(x: number): number {
  x -= (x >>> 1) & 0x55555555;
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  return (Math.imul((x + (x >>> 4)) & 0x0f0f0f0f, 0x01010101) >>> 24);
}

// Four aligned bits anywhere in a player's stones.
function hasFour(hi: number, lo: number): boolean {
  for (const d of [1, H1 - 1, H1, H1 + 1]) {
    shr(hi, lo, d);
    const mh = hi & RH;
    const ml = lo & RL;
    shr(mh, ml, 2 * d);
    if ((mh & RH) | (ml & RL)) return true;
  }
  return false;
}

// Empty cells that would complete four for the player whose stones are
// (hi, lo). The result is in (RH, RL).
let WH = 0;
let WL = 0;
let AH = 0;
let AL = 0;
// Add the cells completing a line along direction d to (AH, AL).
function lineCells(ph: number, pl: number, d: number) {
  shl(ph, pl, d); let ah = RH; let al = RL;
  shl(ph, pl, 2 * d); ah &= RH; al &= RL;
  shl(ph, pl, 3 * d); AH |= ah & RH; AL |= al & RL;
  shr(ph, pl, d); AH |= ah & RH; AL |= al & RL;
  let bh = RH; let bl = RL;
  shr(ph, pl, 2 * d); bh &= RH; bl &= RL;
  shl(ph, pl, d); AH |= bh & RH; AL |= bl & RL;
  shr(ph, pl, 3 * d); AH |= bh & RH; AL |= bl & RL;
}
function winningCells(ph: number, pl: number, mh: number, ml: number) {
  // Vertical: three stones directly below.
  shl(ph, pl, 1); AH = RH; AL = RL;
  shl(ph, pl, 2); AH &= RH; AL &= RL;
  shl(ph, pl, 3); AH &= RH; AL &= RL;
  lineCells(ph, pl, H1);
  lineCells(ph, pl, H1 - 1);
  lineCells(ph, pl, H1 + 1);
  WH = AH & (boardHi ^ mh);
  WL = AL & (boardLo ^ ml);
}

export class Position {
  // Stones of the player to move, and every stone on the board.
  ch = 0;
  cl = 0;
  mh = 0;
  ml = 0;
  moves = 0;

  static from(sequence: readonly number[]): Position {
    const p = new Position();
    for (const col of sequence) {
      if (!p.canPlay(col)) throw new Error(`Column ${col} is full`);
      p.play(col);
    }
    return p;
  }

  clone(): Position {
    const p = new Position();
    p.ch = this.ch; p.cl = this.cl; p.mh = this.mh; p.ml = this.ml; p.moves = this.moves;
    return p;
  }

  canPlay(col: number): boolean {
    return col < 4
      ? (this.ml & (1 << (col * H1 + HEIGHT - 1))) === 0
      : (this.mh & (1 << ((col - 4) * H1 + HEIGHT - 1))) === 0;
  }

  play(col: number) {
    this.ch ^= this.mh;
    this.cl ^= this.ml;
    if (col < 4) this.ml |= this.ml + (1 << (col * H1));
    else this.mh |= this.mh + (1 << ((col - 4) * H1));
    this.moves++;
  }

  // Play a move given as the single bit (hi, lo) it occupies.
  playBit(bh: number, bl: number) {
    this.ch ^= this.mh;
    this.cl ^= this.ml;
    this.mh |= bh;
    this.ml |= bl;
    this.moves++;
  }

  // The bottom free cell of every column that is not full.
  possible() {
    RH = (this.mh + bottomHi) & boardHi;
    RL = (this.ml + bottomLo) & boardLo;
  }

  isWinningMove(col: number): boolean {
    winningCells(this.ch, this.cl, this.mh, this.ml);
    this.possible();
    const inLo = col < 4 ? 0x7f << (col * H1) : 0;
    const inHi = col < 4 ? 0 : 0x7f << ((col - 4) * H1);
    return ((WH & RH & inHi) | (WL & RL & inLo)) !== 0;
  }

  canWinNext(): boolean {
    winningCells(this.ch, this.cl, this.mh, this.ml);
    this.possible();
    return ((WH & RH) | (WL & RL)) !== 0;
  }

  // Moves that do not hand the opponent an immediate win. Result in (RH, RL).
  nonLosingMoves() {
    this.possible();
    const ph = RH;
    const pl = RL;
    winningCells(this.ch ^ this.mh, this.cl ^ this.ml, this.mh, this.ml);
    const oh = WH;
    const ol = WL;
    let mh = ph;
    let ml = pl;
    const fh = WH & ph;
    const fl = WL & pl;
    if (fh | fl) {
      // Two cells to block at once: the game is lost.
      if (popcount(fh) + popcount(fl) > 1) { RH = 0; RL = 0; return; }
      // One: the move must block it.
      mh = fh;
      ml = fl;
    }
    // Never play directly under a cell where the opponent would win.
    shr(oh, ol, 1);
    RH = mh & ~RH;
    RL = ml & ~RL;
  }

  // How many new winning cells a move leaves for the player making it.
  moveScore(bh: number, bl: number): number {
    winningCells(this.ch | bh, this.cl | bl, this.mh, this.ml);
    return popcount(WH) + popcount(WL);
  }

  key(): number {
    return (this.ch + this.mh) * SPLIT + (this.cl + this.ml);
  }
}

// Columns from the centre outwards: central moves are usually best, so
// searching them first prunes much more.
export const ORDER = [3, 2, 4, 1, 5, 0, 6];
const colLo = ORDER.map((c) => (c < 4 ? 0x7f << (c * H1) : 0));
const colHi = ORDER.map((c) => (c < 4 ? 0 : 0x7f << ((c - 4) * H1)));

// Transposition table: the key's low 32 bits plus its slot (key mod a prime
// above 2^17) identify a 49-bit key exactly, so no full key is stored.
const TT_SIZE = 4194301; // prime
const MIN_SCORE = -(CELLS / 2) + 3;
// Candidate moves at each depth: bits and ordering scores.
const MH = new Int32Array((CELLS + 1) * WIDTH);
const ML = new Int32Array((CELLS + 1) * WIDTH);
const SC = new Int32Array((CELLS + 1) * WIDTH);

export class Solver {
  private keys = new Uint32Array(TT_SIZE);
  private values = new Uint8Array(TT_SIZE);
  nodes = 0;
  private deadline = Infinity;

  reset() {
    this.keys.fill(0);
    this.values.fill(0);
  }

  private get(key: number): number {
    const i = key % TT_SIZE;
    return this.keys[i] === key >>> 0 ? this.values[i] : 0;
  }

  private put(key: number, value: number) {
    const i = key % TT_SIZE;
    this.keys[i] = key >>> 0;
    this.values[i] = value;
  }

  // Score within (alpha, beta). Assumes the player to move cannot win at once.
  private negamax(p: Position, alpha: number, beta: number): number {
    if ((++this.nodes & 4095) === 0 && performance.now() > this.deadline) throw OUT_OF_TIME;
    p.nonLosingMoves();
    const nh = RH;
    const nl = RL;
    if (!(nh | nl)) return -((CELLS - p.moves) >> 1);
    if (p.moves >= CELLS - 2) return 0;

    let min = -((CELLS - 2 - p.moves) >> 1);
    if (alpha < min) {
      alpha = min;
      if (alpha >= beta) return alpha;
    }
    let max = (CELLS - 1 - p.moves) >> 1;
    const key = p.key();
    const stored = this.get(key);
    if (stored) max = stored + MIN_SCORE - 1;
    if (beta > max) {
      beta = max;
      if (alpha >= beta) return beta;
    }

    // Order the candidate moves by the threats they create, centre first on
    // ties. Each depth has its own slice of the move buffers.
    const base = p.moves * WIDTH;
    let n = 0;
    for (let i = WIDTH - 1; i >= 0; i--) {
      const bh = nh & colHi[i];
      const bl = nl & colLo[i];
      if (!(bh | bl)) continue;
      const s = p.moveScore(bh, bl);
      let j = n++;
      for (; j > 0 && SC[base + j - 1] > s; j--) {
        MH[base + j] = MH[base + j - 1]; ML[base + j] = ML[base + j - 1]; SC[base + j] = SC[base + j - 1];
      }
      MH[base + j] = bh; ML[base + j] = bl; SC[base + j] = s;
    }

    const { ch, cl, mh, ml, moves } = p;
    for (let k = n - 1; k >= 0; k--) {
      p.playBit(MH[base + k], ML[base + k]);
      const score = -this.negamax(p, -beta, -alpha);
      p.ch = ch; p.cl = cl; p.mh = mh; p.ml = ml; p.moves = moves;
      if (score >= beta) return score;
      if (score > alpha) alpha = score;
    }
    this.put(key, alpha - MIN_SCORE + 1);
    return alpha;
  }

  // Exact score of a position for the player to move: positive wins (the
  // sooner the higher), zero draws, negative loses. Throws OUT_OF_TIME after
  // `deadline` (a performance.now() time).
  solve(position: Position, deadline = Infinity): number {
    this.deadline = deadline;
    // The search plays moves in place; a timeout would leave them on the board.
    const p = position.clone();
    if (p.canWinNext()) return (CELLS + 1 - p.moves) >> 1;
    let min = -((CELLS - p.moves) >> 1);
    let max = (CELLS + 1 - p.moves) >> 1;
    while (min < max) {
      let med = min + Math.trunc((max - min) / 2);
      if (med <= 0 && Math.trunc(min / 2) < med) med = Math.trunc(min / 2);
      else if (med >= 0 && Math.trunc(max / 2) > med) med = Math.trunc(max / 2);
      const r = this.negamax(p, med, med + 1);
      if (r <= med) max = r;
      else min = r;
    }
    return min;
  }

  // Win (1), draw (0) or loss (-1) for the player to move. Much cheaper
  // than the exact score.
  outcome(position: Position, deadline = Infinity): number {
    this.deadline = deadline;
    const p = position.clone();
    if (p.canWinNext()) return 1;
    return Math.sign(this.negamax(p, -1, 1));
  }

  // Exact score of every column for the player to move (null when full).
  scores(p: Position, deadline = Infinity): (number | null)[] {
    return Array.from({ length: WIDTH }, (_, col) => {
      if (!p.canPlay(col)) return null;
      if (p.isWinningMove(col)) return (CELLS + 1 - p.moves) >> 1;
      const next = p.clone();
      next.play(col);
      return -this.solve(next, deadline);
    });
  }
}

export const OUT_OF_TIME = Symbol('out of time');

// ---- A quick heuristic for the easier levels and as a fallback ----

// Score windows of four from `player`'s side: open threes and twos count,
// with a bonus for the centre column.
function heuristic(p: Position): number {
  const grid = toGrid(p);
  const me = 1;
  let score = 0;
  for (let r = 0; r < HEIGHT; r++) if (grid[3][r] === me) score += 3; else if (grid[3][r] === 2) score -= 3;
  const lines: [number, number][] = [[1, 0], [0, 1], [1, 1], [1, -1]];
  for (let c = 0; c < WIDTH; c++) {
    for (let r = 0; r < HEIGHT; r++) {
      for (const [dc, dr] of lines) {
        const ec = c + 3 * dc;
        const er = r + 3 * dr;
        if (ec >= WIDTH || er < 0 || er >= HEIGHT) continue;
        let mine = 0;
        let theirs = 0;
        for (let k = 0; k < 4; k++) {
          const v = grid[c + k * dc][r + k * dr];
          if (v === me) mine++;
          else if (v === 2) theirs++;
        }
        if (mine && theirs) continue;
        if (mine === 3) score += 12;
        else if (mine === 2) score += 3;
        if (theirs === 3) score -= 14;
        else if (theirs === 2) score -= 3;
      }
    }
  }
  return score;
}

// Depth-limited negamax on the heuristic. Returns a score from the side to move.
export function searchScore(p: Position, depth: number, alpha = -1e9, beta = 1e9): number {
  if (p.canWinNext()) return 1e6 + (CELLS - p.moves);
  if (p.moves >= CELLS) return 0;
  p.nonLosingMoves();
  const nh = RH;
  const nl = RL;
  if (!(nh | nl)) return -1e6 + p.moves;
  if (depth === 0) return heuristic(p);
  let best = -1e9;
  for (let i = 0; i < WIDTH; i++) {
    const bh = nh & colHi[i];
    const bl = nl & colLo[i];
    if (!(bh | bl)) continue;
    const next = p.clone();
    next.playBit(bh, bl);
    const s = -searchScore(next, depth - 1, -beta, -alpha);
    if (s > best) best = s;
    if (s > alpha) alpha = s;
    if (alpha >= beta) break;
  }
  return best;
}

// Who sits in each cell, from the point of view of the player to move:
// 1 theirs-to-move (me), 2 the opponent, 0 empty. grid[col][row], row 0 bottom.
export function toGrid(p: Position): number[][] {
  return Array.from({ length: WIDTH }, (_, c) => Array.from({ length: HEIGHT }, (_, r) => {
    const bit = c < 4 ? [0, 1 << (c * H1 + r)] : [1 << ((c - 4) * H1 + r), 0];
    const filled = (p.mh & bit[0]) | (p.ml & bit[1]);
    if (!filled) return 0;
    return (p.ch & bit[0]) | (p.cl & bit[1]) ? 1 : 2;
  }));
}

// Did the player who just moved make four in a row?
export function lastMoverWon(p: Position): boolean {
  return hasFour(p.ch ^ p.mh, p.cl ^ p.ml);
}
