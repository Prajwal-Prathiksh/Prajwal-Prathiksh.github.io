// Runs the Four in a Row computer off the main thread. One solver lives for the
// whole session, so what it learns in one move speeds up the next.

import { chooseMove, type Choice, type Level } from './fourInARowAI';
import { Solver } from './fourInARow';

export interface MoveRequest {
  id: number;
  seq: number[];
  level: Level;
}

export interface MoveResponse extends Choice {
  id: number;
}

let solver: Solver | null = null;

self.onmessage = (event: MessageEvent<MoveRequest>) => {
  const { id, seq, level } = event.data;
  solver ??= new Solver();
  self.postMessage({ id, ...chooseMove(seq, level, solver) } satisfies MoveResponse);
};
