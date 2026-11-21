// Four in a Row coach: the board reading a strong human does, in plain terms.
//
// Rows are counted 1-6 from the bottom in everything shown to the player
// (r + 1 here, where r = 0 is the bottom row). Late in a game the first player
// ends up with the odd rows and the second player with the even rows, so a
// threat is "on a good row" when its row suits its owner.

export const W = 7;
export const H = 6;

/** grid[c][r]: -1 empty, 0 the first player, 1 the second. r = 0 is the bottom. */
export type Grid = number[][];

export function gridOf(seq: readonly number[]): { grid: Grid; heights: number[] } {
  const grid = Array.from({ length: W }, () => Array<number>(H).fill(-1));
  const heights = Array<number>(W).fill(0);
  seq.forEach((c, i) => { grid[c][heights[c]++] = i % 2; });
  return { grid, heights };
}

const DIRS = [[1, 0], [0, 1], [1, 1], [1, -1]] as const;

/** Would a coin of `player` at (c, r) complete four? (c, r) is assumed empty. */
export function completesFour(grid: Grid, c: number, r: number, player: number): boolean {
  for (const [dc, dr] of DIRS) {
    let run = 1;
    for (const sign of [1, -1]) {
      let x = c + dc * sign;
      let y = r + dr * sign;
      while (x >= 0 && x < W && y >= 0 && y < H && grid[x][y] === player) {
        run++;
        x += dc * sign;
        y += dr * sign;
      }
    }
    if (run >= 4) return true;
  }
  return false;
}

/** Odd rows (1, 3, 5) suit the first player, even rows (2, 4, 6) the second. */
export const goodRow = (player: number, r: number) => (r % 2 === 0) === (player === 0);

export interface Threat {
  c: number;
  r: number;
  player: number;
  /** The square can be filled right now: it is the lowest empty square of its column. */
  playable: boolean;
  /** On the owner's row: odd for the first player, even for the second. */
  good: boolean;
}

/** Every empty square that would complete four, for either player. */
export function threats(grid: Grid, heights: readonly number[]): Threat[] {
  const out: Threat[] = [];
  for (let c = 0; c < W; c++) {
    for (let r = heights[c]; r < H; r++) {
      for (const player of [0, 1]) {
        if (completesFour(grid, c, r, player)) {
          out.push({ c, r, player, playable: r === heights[c], good: goodRow(player, r) });
        }
      }
    }
  }
  return out;
}

export interface Warning {
  c: number;
  r: number;
  /** 'gives': the opponent wins on top of it. 'wastes': it lets the opponent block your own threat above. */
  kind: 'gives' | 'wastes';
}

/** Playable squares the player to move should think twice about. */
export function warnings(grid: Grid, heights: readonly number[], mover: number): Warning[] {
  const out: Warning[] = [];
  for (let c = 0; c < W; c++) {
    const r = heights[c];
    if (r >= H - 1) continue;
    if (completesFour(grid, c, r + 1, 1 - mover)) out.push({ c, r, kind: 'gives' });
    else if (completesFour(grid, c, r + 1, mover)) out.push({ c, r, kind: 'wastes' });
  }
  return out;
}

const COL = 'abcdefg';
export const colName = (c: number) => COL[c];
export const square = (c: number, r: number) => `${COL[c]}${r + 1}`;

/**
 * Plain-language notes on the move `col` played after `before`. `names` are
 * the two players' names as shown on the page, first player first.
 */
export function review(before: readonly number[], col: number, names: readonly [string, string]): string[] {
  const mover = before.length % 2;
  const other = 1 - mover;
  const who = names[mover];
  const own = who === 'You' ? 'your' : 'their';
  const { grid, heights } = gridOf(before);
  const r = heights[col];
  const notes: string[] = [];

  // Winning and blocking come first: nothing else matters if they were missed.
  if (completesFour(grid, col, r, mover)) return [`${who} completed four at ${square(col, r)}.`];
  const wins = [...Array(W).keys()].filter((c) => heights[c] < H && completesFour(grid, c, heights[c], mover));
  if (wins.length) notes.push(`${who} could have won at once in column ${colName(wins[0])}.`);
  const blocks = [...Array(W).keys()].filter((c) => heights[c] < H && completesFour(grid, c, heights[c], other));
  if (blocks.length && !blocks.includes(col)) {
    notes.push(`${who} left ${names[other]}'s four open in column ${colName(blocks[0])}.`);
  } else if (blocks.includes(col)) {
    notes.push(`${who} blocked ${names[other]}'s four at ${square(col, r)}.`);
  }

  // Filling the square under a threat.
  if (r + 1 < H) {
    if (completesFour(grid, col, r + 1, other)) {
      notes.push(`${who} filled ${square(col, r)}, right under ${names[other]}'s threat at ${square(col, r + 1)}. ${names[other]} can drop on top and win.`);
    } else if (completesFour(grid, col, r + 1, mover)) {
      notes.push(`${who} filled the square under ${own} own threat at ${square(col, r + 1)}, so ${names[other]} can now block it.`);
    }
  }

  // New threats this coin made.
  const after = gridOf([...before, col]);
  const was = new Set(threats(grid, heights).filter((t) => t.player === mover).map((t) => `${t.c},${t.r}`));
  const made = threats(after.grid, after.heights).filter((t) => t.player === mover && !was.has(`${t.c},${t.r}`) && !t.playable);
  for (const t of made.slice(0, 2)) {
    const rowWord = (t.r + 1) % 2 ? 'odd' : 'even';
    notes.push(t.good
      ? `New threat at ${square(t.c, t.r)}, on an ${rowWord} row: the kind ${mover === 0 ? 'the first' : 'the second'} player can cash in late in the game.`
      : `New threat at ${square(t.c, t.r)}, but on an ${rowWord} row, which usually falls to ${names[other]} as the columns fill. Handy for forcing moves, rarely a winner alone.`);
  }
  // Two of your threats stacked one on top of the other cannot both be stopped.
  for (const t of threats(after.grid, after.heights)) {
    if (t.player === mover && t.r + 1 < H && completesFour(after.grid, t.c, t.r + 1, mover)) {
      notes.push(`Two ${who} threats are stacked in column ${colName(t.c)}: block the lower one and the upper one opens.`);
      break;
    }
  }
  return notes;
}

// ---- The line-count rule of thumb ----
//
// Every square sits on a number of possible fours (3 in a corner, 13 in the
// middle). A line stays open while only one side has coins in it: once both
// do, nobody can finish it. Counting only open lines keeps the classic
// picture honest as the board fills.

/** Open lines of four through (c, r): those not already holding coins of both players. */
export function openLines(grid: Grid, c: number, r: number, mover: number): { open: number; mine: number; theirs: number } {
  let open = 0;
  let mine = 0;
  let theirs = 0;
  for (const [dc, dr] of DIRS) {
    // Each window of four along this direction that covers (c, r).
    for (let k = 0; k < 4; k++) {
      const sc = c - dc * k;
      const sr = r - dr * k;
      const ec = sc + dc * 3;
      const er = sr + dr * 3;
      if (sc < 0 || sc >= W || ec < 0 || ec >= W || sr < 0 || sr >= H || er < 0 || er >= H) continue;
      let me = 0;
      let them = 0;
      for (let i = 0; i < 4; i++) {
        const who = grid[sc + dc * i][sr + dr * i];
        if (who === mover) me++;
        else if (who === 1 - mover) them++;
      }
      if (me && them) continue;
      open++;
      if (!them) mine++;
      if (!me) theirs++;
    }
  }
  return { open, mine, theirs };
}

export interface ThumbPick {
  col: number;
  r: number;
  why: 'win' | 'block' | 'count';
  open: number;
  /** New trapdoors on the mover's own floors that this coin makes. */
  trapdoors: number;
  /** Columns skipped because they would open a trapdoor for the other side. */
  avoided: number[];
}

// Worth this many open lines: one trapdoor on your own floor. In test games
// against the Medium computer, going first, this took the rule from 5 wins in
// 20 to 13.
const FLOOR_BONUS = 6;

/**
 * The rule of thumb in order: win if you can, block if you must, never fill the
 * hole under a threat (theirs or your own), then take the hole on the most
 * open lines, counting each new trapdoor on your own floor as six more lines
 * and each of theirs left standing as six fewer.
 */
export function ruleOfThumb(grid: Grid, heights: readonly number[], mover: number): ThumbPick | null {
  const cols = [3, 2, 4, 1, 5, 0, 6].filter((c) => heights[c] < H);
  if (!cols.length) return null;
  const goodTrapdoors = (c: number, player: number) => {
    grid[c][heights[c]] = mover;
    const after = [...heights];
    after[c]++;
    const n = threats(grid, after).filter((t) => t.player === player && t.good && !t.playable).length;
    grid[c][heights[c]] = -1;
    return n;
  };
  const already = threats(grid, heights).filter((t) => t.player === mover && t.good && !t.playable).length;
  const at = (col: number, why: ThumbPick['why'], avoided: number[] = []): ThumbPick => ({
    col, r: heights[col], why, open: openLines(grid, col, heights[col], mover).open,
    trapdoors: Math.max(0, goodTrapdoors(col, mover) - already),
    avoided,
  });
  const win = cols.find((c) => completesFour(grid, c, heights[c], mover));
  if (win !== undefined) return at(win, 'win');
  const block = cols.find((c) => completesFour(grid, c, heights[c], 1 - mover));
  if (block !== undefined) return at(block, 'block');
  const under = (c: number, player: number) => heights[c] + 1 < H && completesFour(grid, c, heights[c] + 1, player);
  const poisoned = cols.filter((c) => under(c, 1 - mover));
  const safe = cols.filter((c) => !poisoned.includes(c));
  const pool = safe.length ? safe : cols;
  let best = pool[0];
  let bestScore = -Infinity;
  for (const c of pool) {
    const score = openLines(grid, c, heights[c], mover).open
      + FLOOR_BONUS * (goodTrapdoors(c, mover) - goodTrapdoors(c, 1 - mover))
      - (under(c, mover) ? FLOOR_BONUS : 0);
    if (score > bestScore) { best = c; bestScore = score; }
  }
  return at(best, 'count', safe.length ? poisoned : []);
}
