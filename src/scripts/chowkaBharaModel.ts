import {
  WAITING,
  apply,
  boardOf,
  isPaired,
  isBonus,
  isPotentialPair,
  distinctMoves,
  legalMoves,
  throwOdds,
  type BoardSize,
  type State,
  type Turn,
} from './chowkaBhara';
import trainedModel5 from '../data/chowka-bhara-model.json';
import trainedModel7 from '../data/chowka-bhara-model-7x7.json';

export const BOARD_FEATURE_NAMES = [
  'progress', 'home', 'waiting', 'inner-ring-open', 'safe', 'gate-congestion',
  'potential-pairs', 'committed-pairs', 'finish-chance', 'mobility',
  'capture-chance', 'exposure',
] as const;
// Held throws are counted in five slots (see Board.throwSlot): low, middle and
// high plain throws, then chowka and bhara. On a 5x5 board these are 1, 2, 3,
// 4 and 8.
export const TURN_FEATURE_NAMES = [
  'held-low', 'held-mid', 'held-high', 'held-chowka', 'held-bhara', 'bank-size',
  'bank-variety', 'owed-throws', 'usable-held',
  'capturing-held', 'finishing-held', 'bonus-held',
  'turn-gain', 'followup-capture',
] as const;
export const FEATURE_NAMES = [...BOARD_FEATURE_NAMES, ...TURN_FEATURE_NAMES] as const;

export interface EvaluationModel {
  version: number;
  board?: number; // 5 when absent
  borrowedFrom?: number; // weights copied from another board, not yet trained on this one
  weights: number[];
  trainedGames: number;
  seed: number;
}

export const INITIAL_MODEL: EvaluationModel = {
  version: 2,
  weights: [78, 118, -28, 24, 12, -22, 11, 23, 32, 10, 34, -38, ...Array(TURN_FEATURE_NAMES.length).fill(0)],
  trainedGames: 0,
  seed: 20260930,
};

// `npm run selfplay:train -- --board=5|7` replaces these checked-in
// artifacts through reproducible self-play. Features are scaled by pawn count
// and path length, so the 7x7 board starts from the 5x5 weights until it has
// been trained on its own games.
export const CHOWKA_MODELS: Record<BoardSize, EvaluationModel> = { 5: trainedModel5, 7: trainedModel7 };
export const MODEL_FILES: Record<BoardSize, string> = {
  5: 'src/data/chowka-bhara-model.json',
  7: 'src/data/chowka-bhara-model-7x7.json',
};
export const modelFor = (state: State): EvaluationModel => CHOWKA_MODELS[boardOf(state).size];

const chanceOf = (state: State, value: number) =>
  throwOdds(boardOf(state)).find(([throwValue]) => throwValue === value)?.[1] ?? 0;
const featureCache = new WeakMap<State, Map<number, number[]>>();
const tacticalCache = new WeakMap<State, { capture: number[]; exposure: number[] }>();

function tacticalFeatures(state: State) {
  const cached = tacticalCache.get(state);
  if (cached) return cached;
  const capture = Array(state.players.length).fill(0);
  const chanceByAttacker = Array.from({ length: state.players.length }, () => Array(state.players.length).fill(0));
  for (let actor = 0; actor < state.players.length; actor++) {
    for (const [value, chance] of throwOdds(boardOf(state))) {
      const victims = new Set<number>();
      for (const move of distinctMoves(state, actor, value)) {
        apply(state, move).hits.forEach((hit) => victims.add(hit.player));
      }
      if (victims.size) capture[actor] += chance;
      victims.forEach((victim) => { chanceByAttacker[actor][victim] += chance; });
    }
  }
  const exposure = state.players.map((_, victim) =>
    chanceByAttacker.reduce((highest, chances) => Math.max(highest, chances[victim]), 0));
  const result = { capture, exposure };
  tacticalCache.set(state, result);
  return result;
}

export function playerFeatures(state: State, player: number): number[] {
  const cached = featureCache.get(state)?.get(player);
  if (cached) return cached;
  const b = boardOf(state);
  const p = state.players[player];
  let progress = 0;
  let home = 0;
  let waiting = 0;
  let safe = 0;
  let gate = 0;
  let potentialPairs = 0;
  let committedPairs = 0;
  let finishChance = 0;

  p.pawns.forEach((pos, pawn) => {
    if (pos === WAITING) { waiting++; return; }
    if (pos === b.home) { home++; progress += 1; return; }
    progress += pos / b.home;
    if (b.isSafe(b.square(p.seat, pos))) safe++;
    if (!p.hasHit && pos >= b.lastOuter - 2 && pos <= b.lastOuter) gate++;
    if (isPotentialPair(state, player, pawn) && p.partner[pawn] > pawn) potentialPairs++;
    if (isPaired(state, player, pawn) && p.partner[pawn] > pawn) committedPairs++;
    const left = b.home - pos;
    const needed = isPaired(state, player, pawn) ? left * 2 : left;
    finishChance += chanceOf(state, needed);
  });

  let mobility = 0;
  for (const [value, chance] of throwOdds(b)) {
    const moves = legalMoves(state, player, value);
    mobility += chance * Math.min(1, moves.length / b.pawns);
  }
  const tactical = tacticalFeatures(state);
  const n = b.pawns;

  const features = [
    progress / n,
    home / n,
    waiting / n,
    p.hasHit ? 1 : 0,
    safe / n,
    gate / n,
    potentialPairs / (n / 2),
    committedPairs / (n / 2),
    finishChance / n,
    mobility,
    tactical.capture[player],
    tactical.exposure[player],
  ];
  let players = featureCache.get(state);
  if (!players) {
    players = new Map();
    featureCache.set(state, players);
  }
  players.set(player, features);
  return features;
}

export function relativeFeatures(state: State, player: number): number[] {
  const own = playerFeatures(state, player);
  const opponents = state.players.map((_, i) => i).filter((i) => i !== player).map((i) => playerFeatures(state, i));
  const average = own.map((_, feature) => opponents.reduce((sum, values) => sum + values[feature], 0) / opponents.length);
  const leader = opponents.reduce((best, values) => values[0] + values[1] > best[0] + best[1] ? values : best);
  return own.map((value, feature) => value - average[feature] * 0.55 - leader[feature] * 0.45);
}

export function modelScore(state: State, player: number, model: EvaluationModel = modelFor(state)): number {
  const features = relativeFeatures(state, player);
  let score = 0;
  for (let i = 0; i < Math.min(features.length, model.weights.length); i++) score += features[i] * model.weights[i];
  return score;
}

export function turnFeatures(state: State, player: number, turn: Turn, turnStart: State): number[] {
  const board = boardOf(state);
  const counts = [0, 0, 0, 0, 0];
  for (const held of turn.bank) counts[board.throwSlot(held)] += 1 / 4;
  const unique = new Set(turn.bank);
  let usable = 0;
  let capturing = 0;
  let finishing = 0;
  for (const value of turn.bank) {
    const moves = legalMoves(state, player, value);
    if (moves.length) usable++;
    if (moves.some((move) => apply(state, move).hits.length)) capturing++;
    if (moves.some((move) => move.to === boardOf(state).home)) finishing++;
  }
  const bankSize = Math.min(1, turn.bank.length / 6);
  const gain = playerFeatures(state, player)[0] + playerFeatures(state, player)[1]
    - playerFeatures(turnStart, player)[0] - playerFeatures(turnStart, player)[1];
  return [
    ...counts,
    bankSize,
    unique.size / board.throws.length,
    Math.min(1, turn.owed / 3),
    usable / Math.max(1, turn.bank.length),
    capturing / Math.max(1, turn.bank.length),
    finishing / Math.max(1, turn.bank.length),
    turn.bank.filter((value) => isBonus(board, value)).length / Math.max(1, turn.bank.length),
    gain,
    turn.owed > 0 ? playerFeatures(state, player)[10] : 0,
  ];
}

export function decisionScore(
  state: State,
  player: number,
  turn: Turn,
  turnStart: State,
  model: EvaluationModel = modelFor(state),
): number {
  const features = [...relativeFeatures(state, player), ...turnFeatures(state, player, turn, turnStart)];
  let score = 0;
  for (let i = 0; i < Math.min(features.length, model.weights.length); i++) score += features[i] * model.weights[i];
  return score;
}

export const withoutTurnState = (model: EvaluationModel): EvaluationModel => ({
  ...model,
  weights: [...model.weights.slice(0, BOARD_FEATURE_NAMES.length), ...Array(TURN_FEATURE_NAMES.length).fill(0)],
});

export const randomModel = (base: EvaluationModel, random: () => number, scale: number): EvaluationModel => ({
  ...base,
  weights: base.weights.map((weight) => weight + (random() + random() + random() + random() - 2) * scale),
});

export const validateModel = (model: EvaluationModel) =>
  model.version === 2 && model.weights.length === FEATURE_NAMES.length && model.weights.every(Number.isFinite);
