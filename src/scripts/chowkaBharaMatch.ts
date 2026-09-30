// Shared turn transitions and a deterministic headless match runner. The UI,
// AI search, tests, and self-play tooling all use these same rule operations.

import {
  apply,
  canSkip,
  finished,
  frozen,
  legalMoves,
  newGame,
  newTurn,
  recordSpend,
  recordThrow,
  stranded,
  turnOver,
  type Action,
  type EntryMode,
  type Hit,
  type Seat,
  type State,
  type Turn,
} from './chowkaBhara';
import {
  acceptsOffer,
  advanceSocial,
  canOffer,
  makePact,
  newSocial,
  pactFor,
  recordHit,
  relayAllowed,
  threat,
  type SocialState,
} from './chowkaBharaSocial';
import { observeAction, predictedAcceptance } from './chowkaBharaOpponent';

export const THROW_ODDS = [[1, 4], [2, 6], [3, 4], [4, 1], [8, 1]] as const;

export const copyTurn = (turn: Turn): Turn => ({
  bank: [...turn.bank], owed: turn.owed, streak: turn.streak, run: [...turn.run],
});

export function possibleActions(state: State, player: number, turn: Turn): Action[] {
  const moves: Action[] = [...new Set(turn.bank)].flatMap((value) =>
    legalMoves(state, player, value).map((move) => ({ kind: 'move' as const, move })),
  );
  if (turn.owed > 0) moves.push({ kind: 'throw' });
  if (canSkip(turn)) moves.push({ kind: 'skip' });
  return moves;
}

export function applyKnownAction(
  state: State,
  turn: Turn,
  action: Exclude<Action, { kind: 'throw' }>,
): { state: State; turn: Turn; hits: Hit[] } {
  const nextTurn = copyTurn(turn);
  if (action.kind === 'skip') {
    nextTurn.owed--;
    return { state, turn: nextTurn, hits: [] };
  }
  const result = apply(state, action.move);
  recordSpend(nextTurn, action.move.value, result.hits.length > 0);
  return { state: result.state, turn: nextTurn, hits: result.hits };
}

// Mulberry32 is small, reproducible, and sufficient for paired AI tournaments.
export function seededRandom(seed: number): () => number {
  let value = seed >>> 0;
  return () => {
    value = (value + 0x6d2b79f5) | 0;
    let n = Math.imul(value ^ (value >>> 15), 1 | value);
    n ^= n + Math.imul(n ^ (n >>> 7), 61 | n);
    return ((n ^ (n >>> 14)) >>> 0) / 4294967296;
  };
}

export function randomThrow(random: () => number): number {
  const roll = Math.floor(random() * 16);
  if (roll < 4) return 1;
  if (roll < 10) return 2;
  if (roll < 14) return 3;
  return roll === 14 ? 4 : 8;
}

export interface MatchContext {
  state: State;
  player: number;
  turn: Turn;
  turnStart: State;
  nextPlayer: number;
  social: SocialState;
  random: () => number;
}

export type MatchPolicy = (context: MatchContext) => Action | null;

export interface MatchResult {
  places: number[];
  state: State;
  turns: number;
  actions: number;
  draw: boolean;
}

export interface MatchOptions {
  policies: MatchPolicy[];
  styles?: string[];
  seats?: Seat[];
  entry?: EntryMode;
  seed?: number;
  maxTurns?: number;
  onTurn?: (state: State, player: number, social: SocialState) => void;
  onDecision?: (context: MatchContext) => void;
  observeBehaviour?: boolean;
}

const defaultSeats: Record<number, Seat[]> = { 2: [0, 2], 3: [0, 1, 2], 4: [0, 1, 2, 3] };

// Plays the same core turn rules as the browser without animation. Social
// offers use the browser AI's current deterministic thresholds.
export function playMatch(options: MatchOptions): MatchResult {
  const players = options.policies.length;
  if (players < 2 || players > 4) throw new Error('A match needs two to four policies.');
  const styles = options.styles ?? Array(players).fill('balanced');
  const random = seededRandom(options.seed ?? 1);
  let state = newGame(options.seats ?? defaultSeats[players], options.entry ?? 'home');
  const social = newSocial(players);
  const places: number[] = [];
  let current = 0;
  let turns = 0;
  let actions = 0;
  const maxTurns = options.maxTurns ?? 1200;

  while (turns < maxTurns && places.length < players - 1 && !frozen(state)) {
    const active = Array.from({ length: players }, (_, i) => i).filter((i) => !places.includes(i));
    advanceSocial(social, state, active);
    const turnStart = state;
    let turn = newTurn();
    turns++;
    options.onTurn?.(state, current, social);

    if (players >= 3 && !pactFor(social, current)) {
      const offer = active
        .filter((i) => i !== current)
        .map((i) => ({ to: i, target: canOffer(social, state, current, i, active) }))
        .filter((x): x is { to: number; target: number } => x.target !== null)
        .filter((x) => threat(state, x.target) >= 55)
        .sort((a, b) =>
          predictedAcceptance(social, state, current, b.to, b.target)
          - predictedAcceptance(social, state, current, a.to, a.target)
          || social.trust[current][b.to] - social.trust[current][a.to])[0];
      if (offer && acceptsOffer(social, state, current, offer.to, offer.target, styles[offer.to])) {
        makePact(social, current, offer.to, offer.target);
      }
    }

    while (!turnOver(state, current, turn)) {
      if (stranded(state, current, turn)) {
        state = turnStart;
        break;
      }
      const nextPlayer = active[(active.indexOf(current) + 1) % active.length];
      const context: MatchContext = { state, player: current, turn, turnStart, nextPlayer, social, random };
      options.onDecision?.(context);
      const action = options.policies[current](context);
      if (!action) break;
      if (options.observeBehaviour !== false) observeAction(social, state, current, turn, action);
      actions++;
      if (action.kind === 'throw') {
        recordThrow(turn, action.value ?? randomThrow(random));
      } else {
        const result = applyKnownAction(state, turn, action);
        state = result.state;
        turn = result.turn;
        for (const victim of new Set(result.hits.map((hit) => hit.player))) {
          recordHit(social, current, victim, relayAllowed(state, social, current, victim));
        }
      }
      if (actions > maxTurns * 40) break;
    }

    if (finished(state, current)) places.push(current);
    if (places.length >= players - 1) break;
    do current = (current + 1) % players;
    while (places.includes(current));
  }

  const rest = Array.from({ length: players }, (_, i) => i)
    .filter((i) => !places.includes(i))
    .sort((a, b) => threat(state, b) - threat(state, a));
  return { places: [...places, ...rest], state, turns, actions, draw: places.length < players - 1 };
}
