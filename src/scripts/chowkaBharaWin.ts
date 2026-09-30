import trainedModel from '../data/chowka-bhara-win-model.json';
import { apply, finished, legalMoves, recordSpend, type State, type Turn } from './chowkaBhara';
import { FEATURE_NAMES, decisionScore, relativeFeatures, turnFeatures } from './chowkaBharaModel';

export const WIN_FEATURE_NAMES = [...FEATURE_NAMES, 'best-option', 'to-move'] as const;

export interface WinModel {
  version: number;
  weights: number[];
  temperature: number;
  trainedGames: number;
  validationGames: number;
  seed: number;
  validation: {
    logLoss: number;
    brier: number;
    accuracy: number;
    calibrationError: number;
  };
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
  return [...board, ...liveTurn, player === current ? 1 : 0];
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
  const knownWinner = placings[0] ?? state.players.findIndex((_, player) => finished(state, player));
  if (knownWinner >= 0) return state.players.map((_, player) => Number(player === knownWinner));
  return probabilitiesFromFeatures(
    state.players.map((_, player) => winFeatures(state, player, current, turn, turnStart)),
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
  model.version === 1
  && model.weights.length === WIN_FEATURE_NAMES.length
  && model.weights.every(Number.isFinite)
  && Number.isFinite(model.temperature)
  && model.temperature > 0;
