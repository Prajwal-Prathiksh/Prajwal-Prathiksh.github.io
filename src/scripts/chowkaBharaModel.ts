import {
  HOME,
  LAST_OUTER,
  WAITING,
  apply,
  isPaired,
  isPotentialPair,
  isSafe,
  legalMoves,
  square,
  type State,
  type Turn,
} from './chowkaBhara';
import { THROW_ODDS } from './chowkaBharaMatch';
import trainedModel from '../data/chowka-bhara-model.json';

export const BOARD_FEATURE_NAMES = [
  'progress', 'home', 'waiting', 'inner-ring-open', 'safe', 'gate-congestion',
  'potential-pairs', 'committed-pairs', 'finish-chance', 'mobility',
  'capture-chance', 'exposure',
] as const;
export const TURN_FEATURE_NAMES = [
  'held-1', 'held-2', 'held-3', 'held-4', 'held-8', 'bank-size',
  'bank-variety', 'owed-throws', 'bonus-streak', 'usable-held',
  'capturing-held', 'finishing-held', 'bonus-held', 'skip-available',
  'bust-risk', 'turn-gain', 'followup-capture',
] as const;
export const FEATURE_NAMES = [...BOARD_FEATURE_NAMES, ...TURN_FEATURE_NAMES] as const;

export interface EvaluationModel {
  version: number;
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

// `npm run selfplay:train` replaces this checked-in artifact through
// reproducible self-play.
export const CHOWKA_MODEL: EvaluationModel = trainedModel;

const chanceOf = (value: number) => (THROW_ODDS.find(([throwValue]) => throwValue === value)?.[1] ?? 0) / 16;
const featureCache = new WeakMap<State, Map<number, number[]>>();
const tacticalCache = new WeakMap<State, { capture: number[]; exposure: number[] }>();

function tacticalFeatures(state: State) {
  const cached = tacticalCache.get(state);
  if (cached) return cached;
  const capture = Array(state.players.length).fill(0);
  const chanceByAttacker = Array.from({ length: state.players.length }, () => Array(state.players.length).fill(0));
  for (let actor = 0; actor < state.players.length; actor++) {
    for (const [value, count] of THROW_ODDS) {
      const victims = new Set<number>();
      for (const move of legalMoves(state, actor, value)) {
        apply(state, move).hits.forEach((hit) => victims.add(hit.player));
      }
      if (victims.size) capture[actor] += count / 16;
      victims.forEach((victim) => { chanceByAttacker[actor][victim] += count / 16; });
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
    if (pos === HOME) { home++; progress += 1; return; }
    progress += pos / HOME;
    if (isSafe(square(p.seat, pos))) safe++;
    if (!p.hasHit && pos >= 13 && pos <= LAST_OUTER) gate++;
    if (isPotentialPair(state, player, pawn) && p.partner[pawn] > pawn) potentialPairs++;
    if (isPaired(state, player, pawn) && p.partner[pawn] > pawn) committedPairs++;
    const left = HOME - pos;
    const needed = isPaired(state, player, pawn) ? left * 2 : left;
    finishChance += chanceOf(needed);
  });

  let mobility = 0;
  for (const [value, count] of THROW_ODDS) {
    const moves = legalMoves(state, player, value);
    mobility += count / 16 * Math.min(1, moves.length / 4);
  }
  const tactical = tacticalFeatures(state);

  const features = [
    progress / 4,
    home / 4,
    waiting / 4,
    p.hasHit ? 1 : 0,
    safe / 4,
    gate / 4,
    potentialPairs / 2,
    committedPairs / 2,
    finishChance / 4,
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

export function modelScore(state: State, player: number, model: EvaluationModel = CHOWKA_MODEL): number {
  const features = relativeFeatures(state, player);
  let score = 0;
  for (let i = 0; i < Math.min(features.length, model.weights.length); i++) score += features[i] * model.weights[i];
  return score;
}

export function turnFeatures(state: State, player: number, turn: Turn, turnStart: State): number[] {
  const values = [1, 2, 3, 4, 8];
  const counts = values.map((value) => turn.bank.filter((held) => held === value).length / 4);
  const unique = new Set(turn.bank);
  let usable = 0;
  let capturing = 0;
  let finishing = 0;
  for (const value of turn.bank) {
    const moves = legalMoves(state, player, value);
    if (moves.length) usable++;
    if (moves.some((move) => apply(state, move).hits.length)) capturing++;
    if (moves.some((move) => move.to === HOME)) finishing++;
  }
  const bankSize = Math.min(1, turn.bank.length / 6);
  const gain = playerFeatures(state, player)[0] + playerFeatures(state, player)[1]
    - playerFeatures(turnStart, player)[0] - playerFeatures(turnStart, player)[1];
  return [
    ...counts,
    bankSize,
    unique.size / 5,
    Math.min(1, turn.owed / 3),
    turn.streak / 2,
    usable / Math.max(1, turn.bank.length),
    capturing / Math.max(1, turn.bank.length),
    finishing / Math.max(1, turn.bank.length),
    turn.bank.filter((value) => value === 4 || value === 8).length / Math.max(1, turn.bank.length),
    turn.owed > 0 && turn.streak >= 2 ? 1 : 0,
    turn.owed > 0 && turn.streak >= 2 ? 0.125 * (1 + bankSize) : 0,
    gain,
    turn.owed > 0 ? playerFeatures(state, player)[10] : 0,
  ];
}

export function decisionScore(
  state: State,
  player: number,
  turn: Turn,
  turnStart: State,
  model: EvaluationModel = CHOWKA_MODEL,
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
