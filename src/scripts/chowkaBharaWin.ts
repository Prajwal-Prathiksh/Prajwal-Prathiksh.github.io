import trainedModel5 from '../data/chowka-bhara-win-model.json';
import trainedModel7 from '../data/chowka-bhara-win-model-7x7.json';
import { apply, boardOf, distinctMoves, finished, recordSpend, throwOdds, type BoardSize, type State, type Turn } from './chowkaBhara';
import { FEATURE_NAMES, decisionScore, relativeFeatures, turnFeatures } from './chowkaBharaModel';
import { copyTurn, resolveTurn } from './chowkaBharaMatch';

export const WIN_FEATURE_NAMES = [
  ...FEATURE_NAMES, 'best-option', 'to-move', 'held-hit-impact', 'next-roll-hit-impact',
] as const;

export interface WinModel {
  version: number;
  board?: number; // 5 when absent
  borrowedFrom?: number; // weights copied from another board, not yet trained on this one
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
  testByPlace?: Array<{ place: number; samples: number; logLoss: number; accuracy: number }>;
}

// `npm run winmodel:train -- --board=5|7` replaces these checked-in artifacts.
export const CHOWKA_WIN_MODELS: Record<BoardSize, WinModel> = { 5: trainedModel5, 7: trainedModel7 };
export const WIN_MODEL_FILES: Record<BoardSize, string> = {
  5: 'src/data/chowka-bhara-win-model.json',
  7: 'src/data/chowka-bhara-win-model-7x7.json',
};
export const winModelFor = (state: State): WinModel => CHOWKA_WIN_MODELS[boardOf(state).size];

function bestOption(state: State, player: number, turn: Turn, turnStart: State): number {
  const base = decisionScore(state, player, turn, turnStart);
  let best = base;
  for (const value of new Set(turn.bank)) {
    for (const move of distinctMoves(state, player, value)) {
      const result = apply(state, move);
      const after = copyTurn(turn);
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
  for (const move of distinctMoves(state, current, value)) {
    const { state: after, hits } = apply(state, move);
    if (!hits.length) continue;
    impact[current] = 1;
    for (const player of new Set(hits.map((hit) => hit.player))) {
      const lost = state.players[player].pawns.reduce((sum, pos) => sum + Math.max(0, pos), 0)
        - after.players[player].pawns.reduce((sum, pos) => sum + Math.max(0, pos), 0);
      impact[player] = Math.min(impact[player], -Math.max(0.25, Math.min(1, lost / boardOf(state).home)));
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
    ? throwOdds(boardOf(state)).reduce((sum, [value, chance]) =>
      sum + chance * hitImpact(state, player, current, [value]), 0)
    : 0;
  return [...board, ...liveTurn, player === current ? 1 : 0, heldImpact, nextRollImpact];
}

export function probabilitiesFromFeatures(
  features: number[][],
  model: WinModel,
  active: boolean[] = features.map(() => true),
): number[] {
  const scale = Math.max(0.05, model.temperature);
  const logits = features.map((values, player) => active[player]
    ? values.reduce((score, value, index) => score + value * (model.weights[index] ?? 0), 0) / scale
    : -Infinity);
  const peak = Math.max(...logits);
  if (peak === -Infinity) return features.map(() => 0);
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
  model: WinModel = winModelFor(state),
): number[] {
  const resolution = resolveTurn(state, current, turn, turnStart);
  const placed = [...placings];
  if (resolution.over && !resolution.rolledBack && finished(resolution.state, current)
    && !placed.includes(current)) placed.push(current);
  const active = state.players.map((_, player) => !placed.includes(player));
  if (active.filter(Boolean).length === 1) return active.map(Number);
  return probabilitiesFromFeatures(
    state.players.map((_, player) => winFeatures(resolution.state, player, current, turn, turnStart)),
    model,
    active,
  );
}

export function outlookStrength(probabilities: number[]): number {
  const contenders = probabilities.filter((probability) => probability > 0).length;
  if (contenders < 2) return 1;
  const entropy = -probabilities.reduce((sum, probability) =>
    sum + (probability > 0 ? probability * Math.log(probability) : 0), 0);
  return Math.max(0, Math.min(1, 1 - entropy / Math.log(contenders)));
}

export const validateWinModel = (model: WinModel) =>
  model.version === 3
  && model.testByPlace?.length === 3
  && model.weights.length === WIN_FEATURE_NAMES.length
  && model.weights.every(Number.isFinite)
  && Number.isFinite(model.temperature)
  && model.temperature > 0;
