import { chooseAction, type Level, type Style } from './chowkaBharaAI';
import type { State, Turn } from './chowkaBhara';
import type { SocialState } from './chowkaBharaSocial';

export interface AIRequest {
  id: number;
  state: State;
  player: number;
  turn: Turn;
  level: Level;
  style: Style;
  turnStart: State;
  nextPlayer: number;
  social: SocialState;
}

export interface AIResponse extends ReturnType<typeof chooseAction> {
  id: number;
}

self.onmessage = (event: MessageEvent<AIRequest>) => {
  const { id, state, player, turn, level, style, turnStart, nextPlayer, social } = event.data;
  self.postMessage({ id, ...chooseAction(state, player, turn, level, style, turnStart, nextPlayer, social) } satisfies AIResponse);
};
