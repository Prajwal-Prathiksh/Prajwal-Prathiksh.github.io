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
  recordThrow,
  square,
  stranded,
  type Action,
  type Hit,
  type Move,
  type State,
  type Turn,
} from './chowkaBhara';
import { CHOWKA_MODEL, decisionScore, modelScore, type EvaluationModel } from './chowkaBharaModel';
import { applyKnownAction, copyTurn, possibleActions, THROW_ODDS } from './chowkaBharaMatch';
import { inferredStyleWeights } from './chowkaBharaOpponent';
import { allyOf, pactFor, relayValue, threat, type SocialState } from './chowkaBharaSocial';

export type Style = 'balanced' | 'aggressive' | 'cautious' | 'builder' | 'racer';
export type Level = 'easy' | 'hard';

const ODDS: [number, number][] = THROW_ODDS.map(([value, count]) => [value, count / 16]);
const WEIGHTS: Record<Style, { progress: number; centre: number; safe: number; pair: number; hit: number; opponent: number; reply: number }> = {
  balanced: { progress: 2.5, centre: 62, safe: 5, pair: 12, hit: 18, opponent: 0.5, reply: 0.38 },
  aggressive: { progress: 2.3, centre: 58, safe: 2, pair: 7, hit: 28, opponent: 0.7, reply: 0.35 },
  cautious: { progress: 2.3, centre: 62, safe: 13, pair: 10, hit: 15, opponent: 0.45, reply: 0.55 },
  builder: { progress: 2.3, centre: 60, safe: 5, pair: 27, hit: 17, opponent: 0.5, reply: 0.4 },
  racer: { progress: 3.2, centre: 78, safe: 2, pair: 4, hit: 12, opponent: 0.25, reply: 0.2 },
};

const boardKey = (s: State) => s.players.map((p) => `${p.pawns.join(',')}/${p.partner.join(',')}/${+p.hasHit}`).join('|');
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

function heuristicBoardScore(s: State, player: number, style: Style, social: SocialState, broken = false): number {
  const own = playerScore(s, player, style);
  const others = s.players.map((_, i) => i).filter((i) => i !== player);
  if (!others.length) return own;
  const leader = others.reduce((best, i) => threat(s, i) > threat(s, best) ? i : best);
  const pact = broken ? undefined : pactFor(social, player);
  let penalty = 0;
  for (const i of others) {
    let weight = WEIGHTS[style].opponent * (0.65 / others.length + (i === leader ? 0.35 : 0));
    if (pact && i === allyOf(pact, player)) weight *= 0.12;
    if (pact && i === pact.target) weight *= 1.7;
    weight += social.grudge[player]?.[i] * 0.06;
    penalty += weight * playerScore(s, i, 'balanced');
  }
  return own - penalty;
}

function boardScore(
  s: State,
  player: number,
  style: Style,
  social: SocialState,
  broken = false,
  model: EvaluationModel | null = CHOWKA_MODEL,
): number {
  if (!model) return heuristicBoardScore(s, player, style, social, broken);
  // Self-play learns the balanced positional judgement. Styles remain visible
  // through their smaller, hand-authored preference delta.
  let score = modelScore(s, player, model) + (playerScore(s, player, style) - playerScore(s, player, 'balanced')) * 0.55;
  const pact = broken ? undefined : pactFor(social, player);
  if (pact) {
    score += modelScore(s, allyOf(pact, player), model) * 0.08;
    score -= modelScore(s, pact.target, model) * 0.12;
  }
  for (let i = 0; i < s.players.length; i++) {
    if (i !== player) score -= (social.grudge[player]?.[i] ?? 0) * 6;
  }
  return score;
}

function inferredOpponentScore(
  s: State,
  observer: number,
  opponent: number,
  social: SocialState,
  broken: boolean,
  model: EvaluationModel | null,
): number {
  return inferredStyleWeights(social, observer, opponent).reduce((score, belief) =>
    score + belief.probability * boardScore(s, opponent, belief.style, social, broken, model), 0);
}

// Check all five cowrie results for the next opponent. For each result, assume
// that opponent chooses their best immediate reply, then weight by its odds.
function replyScore(s: State, player: number, style: Style, nextPlayer: number, social: SocialState, broken: boolean, model: EvaluationModel | null): number {
  const base = boardScore(s, player, style, social, broken, model);
  if (nextPlayer === player || finished(s, player) || finished(s, nextPlayer)) return base;
  const pact = broken ? undefined : pactFor(social, player);
  const allied = pact && allyOf(pact, player) === nextPlayer;
  let expected = 0;
  for (const [value, chance] of ODDS) {
    let bestForOpponent = -Infinity;
    let ourReply = base;
    for (const move of legalMoves(s, nextPlayer, value)) {
      const result = apply(s, move);
      const after = result.state;
      let theirs = inferredOpponentScore(after, player, nextPlayer, social, broken, model);
      let ours = boardScore(after, player, style, social, broken, model);
      if (allied && result.hits.some((h) => h.player === player)) {
        const relay = threat(s, pact.target) >= 55 ? relayValue(after, nextPlayer, pact.target) : 0;
        if (relay >= 12) {
          theirs += relay * 0.7;
          ours += relay * 0.7;
        } else {
          theirs -= 55 * social.trust[player][nextPlayer];
        }
      }
      if (theirs > bestForOpponent) {
        bestForOpponent = theirs;
        ourReply = ours;
      }
    }
    expected += chance * ourReply;
  }
  const weight = allied ? Math.max(0.55, WEIGHTS[style].reply) : WEIGHTS[style].reply;
  return base * (1 - weight) + expected * weight;
}

function socialGain(s: State, after: State, actor: number, hits: Hit[], social: SocialState, broken: boolean) {
  const pact = broken ? undefined : pactFor(social, actor);
  let gain = 0;
  let broke = broken;
  for (const victim of new Set(hits.map((h) => h.player))) {
    if (pact && victim === allyOf(pact, actor)) {
      const relay = threat(s, pact.target) >= 55 ? relayValue(after, actor, pact.target) : 0;
      if (relay >= 12) gain += relay * 0.3;
      else {
        gain -= 55 * social.trust[victim][actor];
        broke = true;
      }
    } else if (pact && victim === pact.target) gain += 8 + threat(s, victim) * 0.15;
    else gain += social.grudge[actor]?.[victim] * 3;
  }
  return { gain, broke };
}

function actionReason(s: State, action: Action, social: SocialState, nextPlayer: number): string {
  if (action.kind === 'throw') return 'Throw now to see another option before spending a held value.';
  if (action.kind === 'skip') return 'Skip the risky throw and use the values already held.';
  const m = action.move;
  const { state: after, hits } = apply(s, m);
  const pact = pactFor(social, m.player);
  if (pact && hits.some((h) => h.player === allyOf(pact, m.player))) {
    return threat(s, pact.target) >= 55 && relayValue(after, m.player, pact.target) >= 12
      ? `Take your ally's offered hit; the bonus throw may reach the leader.`
      : `Hit your ally for a bonus throw. This breaks the truce.`;
  }
  if (hits.length) return `Move ${m.value} to hit a pawn and earn another throw.`;
  if (pact && allyOf(pact, m.player) === nextPlayer && [1, 2, 3, 4, 8].some((value) =>
    legalMoves(after, nextPlayer, value).some((reply) => {
      const result = apply(after, reply);
      return result.hits.some((h) => h.player === m.player)
        && relayValue(result.state, nextPlayer, pact.target) >= 12;
    }))) return `Leave a pawn open for your ally: their hit could earn a throw that reaches the leader.`;
  if (m.to === HOME) return `Use ${m.value} to bring ${m.pawns.length === 2 ? 'the pair' : 'a pawn'} to the centre.`;
  if (m.from === WAITING) return `Use ${m.value} to bring ${m.pawns.length === 4 ? 'all four pawns' : 'a pawn'} onto the board.`;
  if (!isPotentialPair(s, m.player, m.pawns[0]) && isPotentialPair(after, m.player, m.pawns[0])) return `Use ${m.value} to line up a possible pair.`;
  if (m.pawns.length === 2) return `Move the pair ${m.steps} squares with ${m.value}.`;
  if (isSafe(square(s.players[m.player].seat, m.to))) return `Use ${m.value} to land on a safe square.`;
  return `Use ${m.value} to move pawn ${m.pawns[0] + 1} forward.`;
}

function hardAction(s: State, player: number, t: Turn, style: Style, start: State, nextPlayer: number, social: SocialState, model: EvaluationModel | null, nodeBudget: number): Action | null {
  const root = possibleActions(s, player, t);
  if (!root.length) return null;
  const memo = new Map<string, number>();
  const leaves = new Map<string, number>();
  const terminal = (board: State, broken: boolean) => {
    const key = `${boardKey(board)}|${+broken}`;
    let value = leaves.get(key);
    if (value === undefined) {
      value = replyScore(board, player, style, nextPlayer, social, broken, model) + (finished(board, player) ? 2000 : 0);
      leaves.set(key, value);
    }
    return value;
  };
  const startScore = terminal(start, false);
  const scoreDuringTurn = (board: State, turn: Turn, broken: boolean) => {
    const positional = boardScore(board, player, style, social, broken, model);
    return model ? positional + decisionScore(board, player, turn, start, model) - modelScore(board, player, model)
      : positional + Math.min(12, turn.bank.length * 2 + turn.owed * 2);
  };
  const rootPrior = (action: Action) => {
    if (action.kind === 'throw') {
      let expected = 0;
      for (const [value, chance] of ODDS) {
        const after = copyTurn(t);
        recordThrow(after, value);
        expected += chance * scoreDuringTurn(s, after, false);
      }
      return expected;
    }
    const after = applyKnownAction(s, t, action);
    return scoreDuringTurn(after.state, after.turn, false);
  };
  const exhausted = Symbol('search budget exhausted');
  const search = (board: State, turn: Turn, depth: number, budget: { left: number }, broken: boolean): number => {
    if (stranded(board, player, turn)) return startScore - 1;
    if (turn.owed === 0 && turn.bank.length === 0) return terminal(board, broken);
    if (depth === 0) return scoreDuringTurn(board, turn, broken);
    const key = `${boardKey(board)}|${turn.bank.slice().sort((a, b) => a - b)}|${turn.owed}|${turn.streak}|${depth}|${+broken}`;
    const known = memo.get(key);
    if (known !== undefined) return known;
    if (budget.left-- <= 0) throw exhausted;
    let best = -Infinity;
    for (const action of possibleActions(board, player, turn)) {
      let score: number;
      if (action.kind === 'throw') {
        score = 0;
        for (const [value, chance] of ODDS) {
          const after = copyTurn(turn);
          recordThrow(after, value);
          score += chance * search(board, after, depth - 1, budget, broken);
        }
      } else {
        const after = applyKnownAction(board, turn, action);
        const effect = socialGain(board, after.state, player, after.hits, social, broken);
        score = effect.gain + search(after.state, after.turn, depth - 1, budget, effect.broke);
      }
      if (score > best) best = score;
    }
    if (best === -Infinity) best = terminal(board, broken);
    memo.set(key, best);
    return best;
  };
  const orderedRoot = root.map((action, index) => ({
    action,
    index,
    score: rootPrior(action),
  })).sort((a, b) => b.score - a.score || a.index - b.index).map(({ action }) => action);
  let chosen = orderedRoot[0];
  // Keep the last *complete* pass. A budget cutoff never makes a late root
  // action or cowrie outcome look worse merely because it was visited later.
  for (let depth = 1; depth <= 11; depth++) {
    memo.clear();
    const budget = { left: Math.max(1, nodeBudget) };
    let best = -Infinity;
    let candidate = chosen;
    try {
      for (const action of orderedRoot) {
        let score: number;
        if (action.kind === 'throw') {
          score = 0;
          for (const [value, chance] of ODDS) {
            const after = copyTurn(t);
            recordThrow(after, value);
            score += chance * search(s, after, depth, budget, false);
          }
        } else {
          const after = applyKnownAction(s, t, action);
          const effect = socialGain(s, after.state, player, after.hits, social, false);
          score = effect.gain + search(after.state, after.turn, depth, budget, effect.broke);
        }
        if (score > best) { best = score; candidate = action; }
      }
      chosen = candidate;
    } catch (error) {
      if (error !== exhausted) throw error;
      break;
    }
  }
  return chosen;
}

function easyAction(s: State, player: number, t: Turn, style: Style, social: SocialState, model: EvaluationModel | null): Action | null {
  const moves = possibleActions(s, player, t).filter((a): a is { kind: 'move'; move: Move } => a.kind === 'move');
  if (!moves.length) return t.owed > 0 ? (canSkip(t) ? { kind: 'skip' } : { kind: 'throw' }) : null;
  if (canSkip(t) && Math.random() < 0.28) return { kind: 'skip' };
  if (t.owed > 0 && Math.random() < (canSkip(t) ? 0.12 : 0.3)) return { kind: 'throw' };
  const ranked = moves.map((action) => {
    const result = apply(s, action.move);
    const effect = socialGain(s, result.state, player, result.hits, social, false);
    return { action, score: boardScore(result.state, player, style, social, effect.broke, model) + effect.gain };
  })
    .sort((a, b) => b.score - a.score);
  // Usually take a good move. Sometimes overlook a hit or leave a pawn exposed,
  // but choose among nearby options rather than making a wholly random move.
  const close = ranked.filter((x) => x.score >= ranked[0].score - 30).slice(0, 4);
  const roll = Math.random();
  return close[roll < 0.58 ? 0 : roll < 0.85 ? Math.min(1, close.length - 1) : Math.min(2, close.length - 1)].action;
}

export function chooseAction(
  s: State, player: number, t: Turn, level: Level, style: Style, turnStart: State, nextPlayer: number, social: SocialState,
  options: { model?: EvaluationModel | null; nodeBudget?: number } = {},
): { action: Action | null; reason: string } {
  const model = options.model === undefined ? CHOWKA_MODEL : options.model;
  const action = level === 'hard'
    ? hardAction(s, player, t, style, turnStart, nextPlayer, social, model, options.nodeBudget ?? 96)
    : easyAction(s, player, t, style, social, model);
  return { action, reason: action ? actionReason(s, action, social, nextPlayer) : 'No move is available.' };
}
