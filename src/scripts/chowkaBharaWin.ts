import trainedModel from '../data/chowka-bhara-win-model.json';
import { apply, finished, legalMoves, recordSpend, type State, type Turn } from './chowkaBhara';
import { FEATURE_NAMES, decisionScore, relativeFeatures, turnFeatures } from './chowkaBharaModel';
import { resolveTurn, THROW_ODDS } from './chowkaBharaMatch';

export const WIN_FEATURE_NAMES = [
  ...FEATURE_NAMES, 'best-option', 'to-move', 'held-hit-impact', 'next-roll-hit-impact',
] as const;

export interface WinModel {
  version: number;
  weights: number[];
  temperature: number;
  trainedGames: number;
  validationGames: number;
  testGames: number;
  seed: number;
  validation: {
    logLoss: number;
    brier: number;
    accuracy: number;
    calibrationError: number;
  };
  test: { logLoss: number; brier: number; accuracy: number; calibrationError: number };
}

export const CHOWKA_WIN_MODEL: WinModel = trainedModel;

function bestOption(state: State, player: number, turn: Turn, turnStart: State): number {
  const base = decisionScore(state, player, turn, turnStart);
  let best = base;
  for (const value of new Set(turn.bank)) {
    for (const move of legalMoves(state, player, value)) {
      const result = apply(state, move);
      const after: Turn = { bank: [...turn.bank], owed: turn.owed, streak: turn.streak, run: [...turn.run] };
      recordSpend(after, value, result.hits.length > 0);
      best = Math.max(best, decisionScore(result.state, player, after, turnStart));
    }
  }
  return Math.max(-1, Math.min(1, (best - base) / 160));
}

const impactCache = new WeakMap<State, Map<number, Map<number, number[]>>>();

// Cache legal captures for each throw. winFeatures reads the same board for
// every seat, and the state itself is immutable after a move.
function captureImpacts(state: State, current: number, value: number): number[] {
  let byCurrent = impactCache.get(state);
  if (!byCurrent) { byCurrent = new Map(); impactCache.set(state, byCurrent); }
  let byValue = byCurrent.get(current);
  if (!byValue) { byValue = new Map(); byCurrent.set(current, byValue); }
  const cached = byValue.get(value);
  if (cached) return cached;
  const impact = state.players.map(() => 0);
  for (const move of legalMoves(state, current, value)) {
    const { state: after, hits } = apply(state, move);
    if (!hits.length) continue;
    impact[current] = 1;
    for (const player of new Set(hits.map((hit) => hit.player))) {
      const lost = state.players[player].pawns.reduce((sum, pos) => sum + Math.max(0, pos), 0)
        - after.players[player].pawns.reduce((sum, pos) => sum + Math.max(0, pos), 0);
      impact[player] = Math.min(impact[player], -Math.max(0.25, Math.min(1, lost / 24)));
    }
  }
  byValue.set(value, impact);
  return impact;
}

// Give the actor credit for an available capture and charge its actual victim.
// This lets a roll change B's odds relative to C before the move is made.
function hitImpact(state: State, player: number, current: number, values: number[]): number {
  const impacts = [...new Set(values)].map((value) => captureImpacts(state, current, value)[player]);
  return player === current ? Math.max(0, ...impacts) : Math.min(0, ...impacts);
}

export function winFeatures(
  state: State,
  player: number,
  current: number,
  turn: Turn,
  turnStart: State,
): number[] {
  const board = relativeFeatures(state, player);
  const liveTurn = player === current
    ? [...turnFeatures(state, player, turn, turnStart), bestOption(state, player, turn, turnStart)]
    : Array(FEATURE_NAMES.length - board.length + 1).fill(0);
  const heldImpact = hitImpact(state, player, current, turn.bank);
  const nextRollImpact = turn.owed > 0
    ? THROW_ODDS.reduce((sum, [value, count]) =>
      sum + count / 16 * hitImpact(state, player, current, [value]), 0)
    : 0;
  return [...board, ...liveTurn, player === current ? 1 : 0, heldImpact, nextRollImpact];
}

export function probabilitiesFromFeatures(features: number[][], model: WinModel = CHOWKA_WIN_MODEL): number[] {
  const scale = Math.max(0.05, model.temperature);
  const logits = features.map((values) => values.reduce(
    (score, value, index) => score + value * (model.weights[index] ?? 0), 0,
  ) / scale);
  const peak = Math.max(...logits);
  const exp = logits.map((logit) => Math.exp(logit - peak));
  const total = exp.reduce((sum, value) => sum + value, 0);
  return exp.map((value) => value / total);
}

export function winProbabilities(
  state: State,
  current: number,
  turn: Turn,
  turnStart: State,
  placings: number[] = [],
  model: WinModel = CHOWKA_WIN_MODEL,
): number[] {
  const resolution = resolveTurn(state, current, turn, turnStart);
  const knownWinner = placings[0] ?? (resolution.over && !resolution.rolledBack
    ? resolution.state.players.findIndex((_, player) => finished(resolution.state, player)) : -1);
  if (knownWinner >= 0) return state.players.map((_, player) => Number(player === knownWinner));
  return probabilitiesFromFeatures(
    state.players.map((_, player) => winFeatures(resolution.state, player, current, turn, turnStart)),
    model,
  );
}

export function outlookStrength(probabilities: number[]): number {
  if (probabilities.length < 2) return 1;
  const entropy = -probabilities.reduce((sum, probability) =>
    sum + (probability > 0 ? probability * Math.log(probability) : 0), 0);
  return Math.max(0, Math.min(1, 1 - entropy / Math.log(probabilities.length)));
}

export const validateWinModel = (model: WinModel) =>
  model.version === 2
  && model.weights.length === WIN_FEATURE_NAMES.length
  && model.weights.every(Number.isFinite)
  && Number.isFinite(model.temperature)
  && model.temperature > 0;
