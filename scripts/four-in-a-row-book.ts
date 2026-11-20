// Builds src/data/four-in-a-row-book.json: a proven winning reply for every
// position the Hard computer can face as first player, up to --plies moves
// in. Run with `npm run fourinarow:book -- --plies=8 --workers=12`.
//
// The computer opens in the centre, which wins with perfect play. Its later
// book moves are proven by the solver: each one leaves the opponent lost
// whatever they play. Mirror-image positions are stored once; the browser
// looks up the mirror when a sequence is missing.

import { availableParallelism } from 'node:os';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { isMainThread, parentPort, workerData, Worker } from 'node:worker_threads';
import { ORDER, Position, Solver, WIDTH } from '../src/scripts/fourInARow';

const arg = (name: string, fallback: number) =>
  Number(process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1] ?? fallback);

const mirror = (seq: string) => [...seq].map((c) => WIDTH - 1 - Number(c)).join('');
// One of a sequence and its mirror image stands for both.
const canonical = (seq: string) => seq <= mirror(seq);

// A move for the player to move that keeps the game won, or null if the
// player can win at once (the browser finds those itself).
function winningMove(solver: Solver, seq: string): number | null {
  const p = Position.from([...seq].map(Number));
  if (p.canWinNext()) return null;
  for (const col of ORDER) {
    if (!p.canPlay(col)) continue;
    const next = p.clone();
    next.play(col);
    if (solver.outcome(next) === -1) return col;
  }
  throw new Error(`No winning move after ${seq || 'the empty board'}`);
}

// Every reply the opponent can make, skipping mirror duplicates.
function replies(seq: string): string[] {
  const p = Position.from([...seq].map(Number));
  return ORDER.filter((c) => p.canPlay(c)).map((c) => seq + c).filter(canonical);
}

// The book below one position, computer to move.
function subtree(solver: Solver, seq: string, plies: number, book: Record<string, number>) {
  const move = winningMove(solver, seq);
  if (move === null) return;
  book[seq] = move;
  if (seq.length + 2 > plies) return;
  for (const next of replies(seq + move)) subtree(solver, next, plies, book);
}

type Task = { seq: string; plies: number; deep: boolean };

if (!isMainThread) {
  const solver = new Solver();
  parentPort!.on('message', ({ seq, plies, deep }: Task) => {
    const book: Record<string, number> = {};
    if (deep) subtree(solver, seq, plies, book);
    else {
      const move = winningMove(solver, seq);
      if (move !== null) book[seq] = move;
    }
    parentPort!.postMessage(book);
  });
} else {
  const plies = arg('plies', 8);
  const workers = Math.max(1, arg('workers', Math.min(12, availableParallelism() - 2)));
  const started = performance.now();
  const book: Record<string, number> = { '': 3 };
  const pool = Array.from({ length: workers }, () => new Worker(new URL(import.meta.url), { workerData: {} }));
  void workerData;

  const run = async (tasks: Task[]) => {
    const queue = [...tasks];
    let done = 0;
    await Promise.all(pool.map(async (worker) => {
      for (let task = queue.shift(); task; task = queue.shift()) {
        const part = await new Promise<Record<string, number>>((ok, fail) => {
          worker.once('message', ok);
          worker.once('error', fail);
          worker.postMessage(task);
        });
        Object.assign(book, part);
        done++;
        console.log(`  ${done}/${tasks.length} ${task.seq} (${((performance.now() - started) / 1000).toFixed(0)}s)`);
      }
    }));
  };

  // Two plies in: the computer's second move after each first reply.
  const second = replies('3');
  console.log(`Second moves: ${second.length} positions`);
  await run(second.map((seq) => ({ seq, plies, deep: false })));
  // Then the rest, one subtree per position four plies in.
  const fourth = second.filter((seq) => seq in book).flatMap((seq) => replies(seq + book[seq]));
  console.log(`Deeper book: ${fourth.length} subtrees to ${plies} plies`);
  await run(fourth.map((seq) => ({ seq, plies, deep: true })));
  await Promise.all(pool.map((w) => w.terminate()));

  const sorted = Object.fromEntries(Object.keys(book).sort((a, b) => a.length - b.length || (a < b ? -1 : 1)).map((k) => [k, book[k]]));
  const file = resolve('src/data/four-in-a-row-book.json');
  await writeFile(file, JSON.stringify(sorted) + '\n');
  console.log(`Wrote ${Object.keys(sorted).length} positions to ${file} in ${((performance.now() - started) / 1000).toFixed(0)}s.`);
}
