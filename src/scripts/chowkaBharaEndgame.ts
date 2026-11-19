// Testing aid: play a whole game headlessly, then hand the browser the
// decision just before a chosen finish. The board history and outlook up to
// that point are real, so the end-of-game chart can be checked without
// playing a full match by hand.

import { finished, recordThrow, type Action, type BoardSize, type EntryMode, type Hit, type State, type Turn } from './chowkaBhara';
import { chooseAction } from './chowkaBharaAI';
import { applyKnownAction, copyTurn, playMatch, randomThrow, seededRandom } from './chowkaBharaMatch';
import type { SocialState } from './chowkaBharaSocial';

export interface EndgameStep {
  state: State; // board before the action
  player: number;
  turn: Turn; // turn before the action
  turnStart: State;
  social: SocialState;
  placings: number[]; // players already placed before this action
  action: Action; // throws carry their value
  after: State;
  afterTurn: Turn;
  hits: Hit[];
  lost: boolean; // a third 4 or 8 voided the turn
}

export interface Endgame {
  steps: EndgameStep[];
  cut: number; // index of the decision the browser resumes from
  places: number[];
}

function playOnce(players: number, entry: EntryMode, size: BoardSize, seed: number) {
  const random = seededRandom(seed);
  const steps: EndgameStep[] = [];
  const placed: number[] = [];
  const policy = (context: Parameters<Parameters<typeof playMatch>[0]['policies'][number]>[0]): Action | null => {
    for (let p = 0; p < players; p++) {
      if (p !== context.player && !placed.includes(p) && finished(context.state, p)) placed.push(p);
    }
    const choice = chooseAction(context.state, context.player, context.turn, 'easy', 'balanced',
      context.turnStart, context.nextPlayer, context.social).action;
    if (!choice) return null;
    const action: Action = choice.kind === 'throw' ? { kind: 'throw', value: randomThrow(random) } : choice;
    let after = context.state;
    let afterTurn = copyTurn(context.turn);
    let hits: Hit[] = [];
    let lost = false;
    if (action.kind === 'throw') lost = recordThrow(afterTurn, action.value!) === 'lost';
    else {
      const result = applyKnownAction(context.state, context.turn, action);
      after = result.state;
      afterTurn = result.turn;
      hits = result.hits;
    }
    steps.push({
      state: context.state, player: context.player, turn: copyTurn(context.turn), turnStart: context.turnStart,
      social: structuredClone(context.social), placings: [...placed], action, after, afterTurn, hits, lost,
    });
    return action;
  };
  const result = playMatch({ policies: Array(players).fill(policy), entry, size, seed });
  return { steps, result };
}

const finishingStep = (steps: EndgameStep[], player: number) => steps.findLastIndex((step) =>
  step.player === player && step.action.kind === 'move' && finished(step.after, player));

// Seat 0 finishes in `place` (1-based; the player count or more means last).
// The cut is seat 0's finishing move, or for last place the move that fills
// the second-to-last place.
export function rehearseEndgame(
  players: number, entry: EntryMode, size: BoardSize, place: number, seed = Date.now(), tries = 120,
): Endgame | null {
  const wanted = Math.min(Math.max(1, place), players);
  for (let i = 0; i < tries; i++) {
    const { steps, result } = playOnce(players, entry, size, seed + i * 7919);
    if (result.draw || result.places.indexOf(0) + 1 !== wanted) continue;
    const decider = wanted < players ? 0 : result.places[players - 2];
    const cut = finishingStep(steps, decider);
    if (cut > 0) return { steps, cut, places: result.places };
  }
  return null;
}
