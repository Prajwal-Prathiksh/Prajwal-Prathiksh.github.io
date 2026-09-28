// Runs the peg solitaire solver off the main thread, one solver per board so
// what it learns carries over between hints.

import { Solver, type SolveRequest } from './pegSolver';

const solvers = new Map<string, Solver>();

self.onmessage = (e: MessageEvent<SolveRequest>) => {
  const { kind, order } = e.data;
  const key = `${kind}-${order}`;
  if (!solvers.has(key)) solvers.set(key, new Solver(kind, order));
  self.postMessage(solvers.get(key)!.solve(e.data));
};
