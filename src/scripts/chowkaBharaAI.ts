import {
  HOME,
  LAST_OUTER,
  PAIR_SQUARE,
  WAITING,
  apply,
  canSkip,
  finished,
  isPotentialPair,
  isSafe,
  keyOf,
  legalMoves,
  recordSpend,
  recordThrow,
  square,
  stranded,
  type Action,
  type Move,
  type State,
  type Turn,
} from './chowkaBhara';

export type Style = 'balanced' | 'aggressive' | 'cautious' | 'builder' | 'racer';
export type Level = 'easy' | 'hard';

const ODDS: [number, number][] = [[1, 4 / 16], [2, 6 / 16], [3, 4 / 16], [4, 1 / 16], [8, 1 / 16]];
const WEIGHTS: Record<Style, { progress: number; centre: number; safe: number; pair: number; hit: number; opponent: number; reply: number }> = {
  balanced: { progress: 2.5, centre: 62, safe: 5, pair: 12, hit: 18, opponent: 0.5, reply: 0.38 },
  aggressive: { progress: 2.3, centre: 58, safe: 2, pair: 7, hit: 28, opponent: 0.7, reply: 0.35 },
  cautious: { progress: 2.3, centre: 62, safe: 13, pair: 10, hit: 15, opponent: 0.45, reply: 0.55 },
  builder: { progress: 2.3, centre: 60, safe: 5, pair: 27, hit: 17, opponent: 0.5, reply: 0.4 },
  racer: { progress: 3.2, centre: 78, safe: 2, pair: 4, hit: 12, opponent: 0.25, reply: 0.2 },
};

const boardKey = (s: State) => s.players.map((p) => `${p.pawns.join(',')}/${p.partner.join(',')}/${+p.hasHit}`).join('|');
const copyTurn = (t: Turn): Turn => ({ bank: [...t.bank], owed: t.owed, streak: t.streak, run: [...t.run] });

function playerScore(s: State, player: number, style: Style): number {
  const p = s.players[player];
  const w = WEIGHTS[style];
  let score = p.hasHit ? w.hit : 0;
  let gateCount = 0;
  p.pawns.forEach((pos, pawn) => {
    if (pos === WAITING) { score -= 12; return; }
    if (pos === HOME) { score += HOME * w.progress + w.centre; return; }
    score += pos * w.progress;
    if (isSafe(square(p.seat, pos))) score += w.safe;
    if (pos >= 13 && pos <= LAST_OUTER && !p.hasHit) gateCount++;
    if (pos > LAST_OUTER) {
      const left = HOME - pos;
      if ([1, 2, 3, 4, 8].includes(left)) score += 6;
      else if (left < 8) score -= 3;
    }
    if (p.partner[pawn] > pawn) {
      score += pos === PAIR_SQUARE ? w.pair * 0.35 : w.pair;
      if (pos > PAIR_SQUARE) {
        const wall = s.players.some((other, i) => i !== player && other.pawns.some((from) => {
          if (from < 0 || from >= HOME) return false;
          return [1, 2, 3, 4, 8].some((v) =>
            from + v < HOME && keyOf(square(other.seat, from + v)) === keyOf(square(p.seat, pos)));
        }));
        if (wall) score += w.pair * 0.7;
      }
    }
  });
  if (gateCount > 1) score -= (gateCount - 1) * 10;
  return score;
}

function boardScore(s: State, player: number, style: Style): number {
  const own = playerScore(s, player, style);
  const others = s.players.map((_, i) => i).filter((i) => i !== player);
  if (!others.length) return own;
  const scores = others.map((i) => playerScore(s, i, 'balanced'));
  const average = scores.reduce((a, b) => a + b, 0) / scores.length;
  const leader = Math.max(...scores);
  return own - WEIGHTS[style].opponent * (average * 0.65 + leader * 0.35);
}

// Check all five cowrie results for the next opponent. For each result, assume
// that opponent chooses their best immediate reply, then weight by its odds.
function replyScore(s: State, player: number, style: Style, nextPlayer: number): number {
  const base = boardScore(s, player, style);
  if (nextPlayer === player || finished(s, player) || finished(s, nextPlayer)) return base;
  let expected = 0;
  for (const [value, chance] of ODDS) {
    let bestForOpponent = -Infinity;
    let ourReply = base;
    for (const move of legalMoves(s, nextPlayer, value)) {
      const after = apply(s, move).state;
      const theirs = boardScore(after, nextPlayer, 'balanced');
      if (theirs > bestForOpponent) {
        bestForOpponent = theirs;
        ourReply = boardScore(after, player, style);
      }
    }
    expected += chance * ourReply;
  }
  const weight = WEIGHTS[style].reply;
  return base * (1 - weight) + expected * weight;
}

function possibleActions(s: State, player: number, t: Turn): Action[] {
  const moves: Action[] = [...new Set(t.bank)].flatMap((value) => legalMoves(s, player, value).map((move) => ({ kind: 'move' as const, move })));
  if (t.owed > 0) moves.push({ kind: 'throw' });
  if (canSkip(t)) moves.push({ kind: 'skip' });
  return moves;
}

function nextPosition(s: State, t: Turn, action: Exclude<Action, { kind: 'throw' }>): { state: State; turn: Turn } {
  const after = copyTurn(t);
  if (action.kind === 'skip') {
    after.owed--;
    return { state: s, turn: after };
  }
  const result = apply(s, action.move);
  recordSpend(after, action.move.value, result.hits.length > 0);
  return { state: result.state, turn: after };
}

function actionReason(s: State, action: Action): string {
  if (action.kind === 'throw') return 'Throw now to see another option before spending a held value.';
  if (action.kind === 'skip') return 'Skip the risky throw and use the values already held.';
  const m = action.move;
  const { state: after, hits } = apply(s, m);
  if (hits.length) return `Move ${m.value} to hit a pawn and earn another throw.`;
  if (m.to === HOME) return `Use ${m.value} to bring ${m.pawns.length === 2 ? 'the pair' : 'a pawn'} to the centre.`;
  if (m.from === WAITING) return `Use ${m.value} to bring a pawn onto the board.`;
  if (!isPotentialPair(s, m.player, m.pawns[0]) && isPotentialPair(after, m.player, m.pawns[0])) return `Use ${m.value} to line up a possible pair.`;
  if (m.pawns.length === 2) return `Move the pair ${m.steps} squares with ${m.value}.`;
  if (isSafe(square(s.players[m.player].seat, m.to))) return `Use ${m.value} to land on a safe square.`;
  return `Use ${m.value} to move pawn ${m.pawns[0] + 1} forward.`;
}

function hardAction(s: State, player: number, t: Turn, style: Style, start: State, nextPlayer: number): Action | null {
  const root = possibleActions(s, player, t);
  if (!root.length) return null;
  let memo = new Map<string, number>();
  const leaves = new Map<string, number>();
  const terminal = (board: State) => {
    const key = boardKey(board);
    let value = leaves.get(key);
    if (value === undefined) {
      value = replyScore(board, player, style, nextPlayer) + (finished(board, player) ? 2000 : 0);
      leaves.set(key, value);
    }
    return value;
  };
  const startScore = terminal(start);
  const search = (board: State, turn: Turn, depth: number, budget: { left: number }): number => {
    if (stranded(board, player, turn)) return startScore - 1;
    if (turn.owed === 0 && turn.bank.length === 0) return terminal(board);
    if (depth === 0 || budget.left-- <= 0) {
      return boardScore(board, player, style) + Math.min(12, turn.bank.length * 2 + turn.owed * 2);
    }
    const key = `${boardKey(board)}|${turn.bank.slice().sort((a, b) => a - b)}|${turn.owed}|${turn.streak}|${depth}`;
    const known = memo.get(key);
    if (known !== undefined) return known;
    let best = -Infinity;
    for (const action of possibleActions(board, player, turn)) {
      let score: number;
      if (action.kind === 'throw') {
        score = 0;
        for (const [value, chance] of ODDS) {
          const after = copyTurn(turn);
          recordThrow(after, value);
          score += chance * search(board, after, depth - 1, budget);
        }
      } else {
        const after = nextPosition(board, turn, action);
        score = search(after.state, after.turn, depth - 1, budget);
      }
      if (score > best) best = score;
    }
    if (best === -Infinity) best = terminal(board);
    if (budget.left > 0) memo.set(key, best);
    return best;
  };
  let chosen = root[0];
  let best = -Infinity;
  for (const action of root) {
    // Complete ordinary turns; cap rare chains of hits and bonus throws.
    memo = new Map<string, number>();
    const budget = { left: 600 };
    let score: number;
    if (action.kind === 'throw') {
      score = 0;
      for (const [value, chance] of ODDS) {
        const after = copyTurn(t);
        recordThrow(after, value);
        score += chance * search(s, after, 11, budget);
      }
    } else {
      const after = nextPosition(s, t, action);
      score = search(after.state, after.turn, 11, budget);
    }
    if (score > best) { best = score; chosen = action; }
  }
  return chosen;
}

function easyAction(s: State, player: number, t: Turn, style: Style): Action | null {
  const moves = possibleActions(s, player, t).filter((a): a is { kind: 'move'; move: Move } => a.kind === 'move');
  if (!moves.length) return t.owed > 0 ? (canSkip(t) ? { kind: 'skip' } : { kind: 'throw' }) : null;
  if (canSkip(t) && Math.random() < 0.28) return { kind: 'skip' };
  if (t.owed > 0 && Math.random() < (canSkip(t) ? 0.12 : 0.3)) return { kind: 'throw' };
  const ranked = moves.map((action) => ({ action, score: boardScore(apply(s, action.move).state, player, style) }))
    .sort((a, b) => b.score - a.score);
  // Usually take a good move. Sometimes overlook a hit or leave a pawn exposed,
  // but choose among nearby options rather than making a wholly random move.
  const close = ranked.filter((x) => x.score >= ranked[0].score - 30).slice(0, 4);
  const roll = Math.random();
  return close[roll < 0.58 ? 0 : roll < 0.85 ? Math.min(1, close.length - 1) : Math.min(2, close.length - 1)].action;
}

export function chooseAction(
  s: State, player: number, t: Turn, level: Level, style: Style, turnStart: State, nextPlayer: number,
): { action: Action | null; reason: string } {
  const action = level === 'hard'
    ? hardAction(s, player, t, style, turnStart, nextPlayer)
    : easyAction(s, player, t, style);
  return { action, reason: action ? actionReason(s, action) : 'No move is available.' };
}
