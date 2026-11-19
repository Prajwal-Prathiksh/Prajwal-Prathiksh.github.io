import { availableParallelism } from 'node:os';
import { resolve } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { isMainThread, parentPort, workerData, Worker } from 'node:worker_threads';
import { chooseAction } from '../src/scripts/chowkaBharaAI';
import { chooseOriginalHardAction } from '../src/scripts/chowkaBharaOriginalAI';
import { applyKnownAction, copyTurn, playMatch, possibleActions, resolveTurn, seededRandom, type MatchPolicy } from '../src/scripts/chowkaBharaMatch';
import {
  CHOWKA_MODELS,
  FEATURE_NAMES,
  MODEL_FILES,
  decisionScore,
  randomModel,
  modelScore,
  withoutTurnState,
  validateModel,
  type EvaluationModel,
} from '../src/scripts/chowkaBharaModel';
import type { Action, BoardSize, EntryMode, State, Turn } from '../src/scripts/chowkaBhara';
import { BOARD_SIZES, boardFor, boardOf, legalMoves, newGame, newTurn, recordThrow, throwOdds } from '../src/scripts/chowkaBhara';
import { observeAction } from '../src/scripts/chowkaBharaOpponent';
import { newSocial, styleBelief } from '../src/scripts/chowkaBharaSocial';
import { WIN_FEATURE_NAMES, winFeatures, winProbabilities } from '../src/scripts/chowkaBharaWin';

interface Trial {
  id: number;
  model: EvaluationModel;
  games: number;
  players: number;
  entry: EntryMode | 'mixed';
  size: BoardSize;
  seed: number;
  budget: number;
  opponent: EvaluationModel;
  positionOpponent?: boolean;
  originalOpponent?: boolean;
}

interface TrialResult {
  id: number;
  score: number;
  wins: number;
  games: number;
  turns: number;
  scoreSquares: number;
  places: number[];
}

const policy = (model: EvaluationModel | null, budget: number): MatchPolicy => (context) =>
  chooseAction(
    context.state,
    context.player,
    context.turn,
    'hard',
    'balanced',
    context.turnStart,
    context.nextPlayer,
    context.social,
    { model, nodeBudget: budget },
  ).action;

const originalHardPolicy: MatchPolicy = (context) =>
  chooseOriginalHardAction(
    context.state,
    context.player,
    context.turn,
    'hard',
    'balanced',
    context.turnStart,
    context.nextPlayer,
    context.social,
  ).action;

const positionalPolicy = (model: EvaluationModel): MatchPolicy => (context) => {
  const actions = possibleActions(context.state, context.player, context.turn);
  const moves = actions.filter((action): action is Extract<Action, { kind: 'move' }> => action.kind === 'move');
  if (!moves.length) return actions.find((action) => action.kind === 'throw') ?? null;
  // Build a modest bank before committing it. The position model chooses the actual move.
  if (context.turn.owed > 0 && context.turn.bank.length < 2) return { kind: 'throw' };
  let best = moves[0];
  let bestScore = -Infinity;
  for (const action of moves) {
    const after = applyKnownAction(context.state, context.turn, action);
    const score = modelScore(after.state, context.player, model) + after.hits.length * 5;
    if (score > bestScore) { best = action; bestScore = score; }
  }
  return best;
};

const selfPlayPolicy = (model: EvaluationModel): MatchPolicy => (context) => {
  const actions = possibleActions(context.state, context.player, context.turn);
  let best = actions[0] ?? null;
  let bestScore = -Infinity;
  for (const action of actions) {
    let score = -Infinity;
    if (action.kind === 'throw') {
      score = 0;
      for (const [value, chance] of throwOdds(boardOf(context.state))) {
        const after = copyTurn(context.turn);
        recordThrow(boardOf(context.state), after, value);
        score += chance * decisionScore(context.state, context.player, after, context.turnStart, model);
      }
    } else {
      const after = applyKnownAction(context.state, context.turn, action);
      score = decisionScore(after.state, context.player, after.turn, context.turnStart, model) + after.hits.length * 5;
    }
    if (score > bestScore) { best = action; bestScore = score; }
  }
  return best;
};

function runTrial(trial: Trial): TrialResult {
  let score = 0;
  let wins = 0;
  let turns = 0;
  let scoreSquares = 0;
  const places = Array(trial.players).fill(0);
  for (let game = 0; game < trial.games; game++) {
    const candidateSeat = game % trial.players;
    const entry: EntryMode = 'home';
    const policies = Array.from({ length: trial.players }, (_, seat) => {
      const candidate = seat === candidateSeat;
      if (!candidate && trial.originalOpponent) return originalHardPolicy;
      if (trial.budget > 0) return policy(candidate ? trial.model : trial.opponent, trial.budget);
      if (!candidate && trial.positionOpponent) return positionalPolicy(trial.opponent);
      return selfPlayPolicy(candidate ? trial.model : trial.opponent);
    });
    const result = playMatch({
      policies,
      styles: Array(trial.players).fill('balanced'),
      entry,
      size: trial.size,
      seed: trial.seed + Math.floor(game / trial.players) * 0x9e3779b1,
      observeBehaviour: trial.budget > 0 || trial.originalOpponent,
    });
    const place = result.places.indexOf(candidateSeat);
    const placementScore = (trial.players - 1 - place) / (trial.players - 1);
    const objective = Number(place === 0) * 0.8 + placementScore * 0.2;
    score += objective;
    scoreSquares += objective * objective;
    places[place]++;
    if (place === 0) wins++;
    turns += result.turns;
  }
  return { id: trial.id, score: score / trial.games, wins, games: trial.games, turns, scoreSquares, places };
}

if (!isMainThread) {
  parentPort!.postMessage(runTrial(workerData as Trial));
} else {
  const args = new Map(process.argv.slice(2).map((arg) => {
    const [key, value = 'true'] = arg.replace(/^--/, '').split('=');
    return [key, value];
  }));
  const command = process.argv[2]?.startsWith('--') ? 'train' : (process.argv[2] ?? 'train');
  const numberArg = (name: string, fallback: number) => Number(args.get(name) ?? fallback);
  const seed = numberArg('seed', 20260930);
  const workers = Math.max(1, Math.min(numberArg('workers', availableParallelism() - 1), availableParallelism()));
  const games = numberArg('games', command === 'tournament' ? 96 : 16);
  const budget = numberArg('budget', 0);
  const players = 4;
  const entry = 'home' as const;
  // --board=5 (default) or --board=7 picks the board to play, train and save.
  const size = numberArg('board', 5) as BoardSize;
  if (!BOARD_SIZES.includes(size)) throw new Error(`--board must be one of ${BOARD_SIZES.join(', ')}.`);
  const CHOWKA_MODEL = CHOWKA_MODELS[size];

  const runParallel = async (trials: Trial[]): Promise<TrialResult[]> => {
    const results: TrialResult[] = [];
    let cursor = 0;
    const next = async (): Promise<void> => {
      const trial = trials[cursor++];
      if (!trial) return;
      const result = await new Promise<TrialResult>((done, reject) => {
        const worker = new Worker(new URL(import.meta.url), { workerData: trial });
        worker.once('message', done);
        worker.once('error', reject);
        worker.once('exit', (code) => { if (code) reject(new Error(`Self-play worker exited with ${code}.`)); });
      });
      results.push(result);
      await next();
    };
    await Promise.all(Array.from({ length: Math.min(workers, trials.length) }, next));
    return results.sort((a, b) => a.id - b.id);
  };

  if (command === 'benchmark') {
    const repeats = numberArg('repeats', 8);
    const state = newGame([0, 1, 2, 3], entry, size);
    const turn = newTurn();
    const social = newSocial(players);
    const started = performance.now();
    for (let i = 0; i < repeats; i++) {
      chooseAction(state, 0, turn, 'hard', 'balanced', state, 1, social, { nodeBudget: budget || 240 });
    }
    const elapsed = performance.now() - started;
    console.log(`${repeats} Hard decisions on ${size}x${size} at budget ${budget || 240}: ${elapsed.toFixed(1)} ms total, ${(elapsed / repeats).toFixed(1)} ms each.`);
  } else if (command === 'smoke') {
    // The 5x5 path must stay exactly as it was before boards became sizeable.
    const classic = [
      [4, 2], [4, 3], [4, 4], [3, 4], [2, 4], [1, 4], [0, 4], [0, 3], [0, 2], [0, 1], [0, 0], [1, 0], [2, 0], [3, 0], [4, 0], [4, 1],
      [3, 1], [2, 1], [1, 1], [1, 2], [1, 3], [2, 3], [3, 3], [3, 2], [2, 2],
    ];
    if (JSON.stringify(boardFor(5).path(0)) !== JSON.stringify(classic)) throw new Error('The 5x5 path changed.');
    for (const board of BOARD_SIZES.map(boardFor)) {
      const n = board.size;
      for (let seat = 0 as 0 | 1 | 2 | 3; seat < 4; seat++) {
        const path = board.path(seat);
        if (path.length !== n * n || new Set(path.map(board.key)).size !== n * n) {
          throw new Error(`${n}x${n} path for seat ${seat} does not visit every square once.`);
        }
        // Every step is to a neighbouring square (a diagonal step enters the 7x7 middle ring).
        path.slice(1).forEach(([r, c], i) => {
          const [pr, pc] = path[i];
          if (Math.max(Math.abs(r - pr), Math.abs(c - pc)) !== 1) throw new Error(`${n}x${n} path jumps at step ${i + 1}.`);
        });
      }
      if (board.pawns !== n - 1 || board.home !== n * n - 1 || board.lastOuter !== 4 * (n - 1) - 1
        || board.pairSquare !== board.lastOuter + 1 || board.safe.length !== (n === 5 ? 5 : 9)) {
        throw new Error(`${n}x${n} board constants are wrong.`);
      }
      const gate = newGame([0, 2], 'home', n);
      gate.players[0].pawns[0] = board.lastOuter - 1;
      if (legalMoves(gate, 0, 2).some((move) => move.to > board.lastOuter)) throw new Error(`${n}x${n} inner ring opened before a hit.`);
      gate.players[0].hasHit = true;
      if (!legalMoves(gate, 0, 2).some((move) => move.to === board.pairSquare)) throw new Error(`${n}x${n} inner ring stayed shut after a hit.`);
    }
    // 7x7: diagonal entry onto the middle ring's crossed corner, both inner rings
    // clockwise, and a straight last step into the centre.
    const big = boardFor(7).path(0);
    const expect7 = [[6, 2], [5, 1], [4, 1], [5, 2], [4, 2], [3, 2], [4, 3], [3, 3]];
    const got7 = [big[23], big[24], big[25], big[39], big[40], big[41], big[47], big[48]];
    if (JSON.stringify(got7) !== JSON.stringify(expect7)) throw new Error(`7x7 route changed: ${JSON.stringify(got7)}.`);
    if (!boardFor(7).isSafe(big[24])) throw new Error('The 7x7 middle-ring entry should be a crossed square.');
    // Throws: four cowries on 5x5, six on 7x7, and the odds add up.
    for (const [n, values] of [[5, [1, 2, 3, 4, 8]], [7, [1, 2, 3, 4, 5, 6, 12]]] as const) {
      const board = boardFor(n);
      const odds = throwOdds(board);
      if (JSON.stringify(odds.map(([v]) => v)) !== JSON.stringify(values)
        || Math.abs(odds.reduce((sum, [, p]) => sum + p, 0) - 1) > 1e-12) throw new Error(`${n}x${n} throws are wrong.`);
      const entry = newGame([0, 2], 'each', n);
      if (legalMoves(entry, 0, board.cowries).length === 0 || legalMoves(entry, 0, 3).length !== 0) {
        throw new Error(`${n}x${n} pawns should enter only on chowka or bhara.`);
      }
      // Three bonus throws in a row are all kept: the old bust rule is gone.
      const streak = newTurn();
      for (const bonus of [board.bonus[0], board.bonus[1], board.bonus[0]]) recordThrow(board, streak, bonus);
      if (streak.bank.length !== 3 || streak.owed !== 1) throw new Error(`${n}x${n} three bonus throws should all be kept.`);
    }
    for (const n of BOARD_SIZES.filter((board) => board !== 5)) {
      const trial7 = { id: 0, model: CHOWKA_MODELS[n], opponent: CHOWKA_MODELS[n], games: 2, players: 2, entry: 'home' as const, size: n, seed, budget: 0 };
      const once = runTrial(trial7);
      if (once.games !== 2 || once.turns <= 0) throw new Error(`${n}x${n} headless matches did not finish.`);
      if (JSON.stringify(once) !== JSON.stringify(runTrial(trial7))) throw new Error(`Seeded ${n}x${n} self-play was not reproducible.`);
      for (const mode of ['all', 'each'] as const) {
        const varied = runTrial({ ...trial7, games: 1, players: 3, entry: mode, seed: seed + mode.length });
        if (varied.games !== 1 || varied.turns <= 0) throw new Error(`${n}x${n} ${mode} entry simulation failed.`);
      }
      const opening = newGame([0, 1, 2, 3], 'home', n);
      const chances = winProbabilities(opening, 0, newTurn(), opening);
      if (chances.some((chance) => !Number.isFinite(chance)) || Math.abs(chances.reduce((sum, chance) => sum + chance, 0) - 1) > 1e-9) {
        throw new Error(`${n}x${n} win outlook is invalid.`);
      }
    }
    const trial = { id: 0, model: CHOWKA_MODELS[5], opponent: CHOWKA_MODELS[5], games: 4, players: 2, entry: 'home' as const, size: 5 as const, seed, budget: 0 };
    const result = runTrial(trial);
    const repeated = runTrial(trial);
    if (result.games !== 4 || result.turns <= 0) throw new Error('Headless matches did not finish.');
    if (JSON.stringify(result) !== JSON.stringify(repeated)) throw new Error('Seeded self-play was not reproducible.');
    for (const mode of ['home', 'all', 'each'] as const) {
      const varied = runTrial({ ...trial, games: 3, players: 3, entry: mode, seed: seed + mode.length });
      if (varied.games !== 3 || varied.turns <= 0) throw new Error(`${mode} entry simulation failed.`);
    }
    // With 4 + 2 held, spending 2 captures, keeps 4, and earns another throw.
    // Spending 4 merely advances. This guards the turn-state behaviour that
    // the learned evaluator is intended to preserve.
    const tacticalState: State = {
      entry: 'home',
      size: 5,
      players: [
        { seat: 0, pawns: [0, 24, 24, 24], partner: [-1, -1, -1, -1], hasHit: false },
        { seat: 2, pawns: [10, 24, 24, 24], partner: [-1, -1, -1, -1], hasHit: true },
      ],
    };
    const tacticalTurn: Turn = { bank: [4, 2], owed: 0 };
    const tacticalChoice = chooseAction(
      tacticalState, 0, tacticalTurn, 'hard', 'balanced', tacticalState, 1, newSocial(2), { nodeBudget: 24 },
    ).action;
    if (tacticalChoice?.kind !== 'move' || tacticalChoice.move.value !== 2) {
      throw new Error('Turn-state evaluator did not preserve the capturing 2 before the held 4.');
    }
    const profile = newSocial(2);
    for (let i = 0; i < 8; i++) observeAction(profile, tacticalState, 0, tacticalTurn, tacticalChoice);
    if (styleBelief(profile, 1, 0)[1] <= 0.15) {
      throw new Error('Opponent profile did not learn from repeated aggressive choices.');
    }
    const outlookState: State = {
      entry: 'home',
      size: 5,
      players: [
        { seat: 0, pawns: [1, 0, 0, 0], partner: [-1, -1, -1, -1], hasHit: false },
        { seat: 2, pawns: [1, 0, 0, 0], partner: [-1, -1, -1, -1], hasHit: false },
        { seat: 1, pawns: [0, 0, 0, 0], partner: [-1, -1, -1, -1], hasHit: false },
        { seat: 3, pawns: [0, 0, 0, 0], partner: [-1, -1, -1, -1], hasHit: false },
      ],
    };
    const beforeRoll: Turn = { bank: [], owed: 1 };
    const afterEight = copyTurn(beforeRoll);
    recordThrow(boardFor(5), afterEight, 8);
    const beforeChances = winProbabilities(outlookState, 0, beforeRoll, outlookState);
    const afterChances = winProbabilities(outlookState, 0, afterEight, outlookState);
    if (Math.abs(afterChances.reduce((sum, chance) => sum + chance, 0) - 1) > 1e-9) {
      throw new Error('Win probabilities do not sum to one.');
    }
    if (afterChances[0] <= beforeChances[0]) {
      throw new Error('Win model did not react to a rolled 8 with an immediate capture available.');
    }
    for (const seats of [[0, 2], [0, 1, 2]] as const) {
      const smaller = newGame([...seats], 'home');
      const chances = winProbabilities(smaller, 0, newTurn(), smaller);
      if (chances.length !== seats.length || chances.some((chance) => !Number.isFinite(chance))
        || Math.abs(chances.reduce((sum, chance) => sum + chance, 0) - 1) > 1e-9) {
        throw new Error(`${seats.length}-player win outlook is invalid.`);
      }
    }
    const placingState = newGame([0, 1, 2, 3], 'home');
    placingState.players[1].pawns = [24, 24, 24, 24];
    placingState.players[2].pawns = [24, 24, 24, 24];
    for (const placed of [[1], [1, 2]]) {
      const chances = winProbabilities(placingState, 0, newTurn(), placingState, placed);
      if (placed.some((player) => chances[player] !== 0)
        || Math.abs(chances.reduce((sum, chance) => sum + chance, 0) - 1) > 1e-9) {
        throw new Error('The next-place outlook included a finished player.');
      }
    }
    const exposedState: State = {
      entry: 'home',
      size: 5,
      players: [
        tacticalState.players[0], tacticalState.players[1],
        { seat: 1, pawns: [0, 0, 0, 0], partner: [-1, -1, -1, -1], hasHit: false },
        { seat: 3, pawns: [0, 0, 0, 0], partner: [-1, -1, -1, -1], hasHit: false },
      ],
    };
    const heldTwo: Turn = { bank: [2], owed: 0 };
    const impact = WIN_FEATURE_NAMES.indexOf('held-hit-impact');
    const victim = winFeatures(exposedState, 1, 0, heldTwo, exposedState)[impact];
    const bystander = winFeatures(exposedState, 2, 0, heldTwo, exposedState)[impact];
    if (!(victim < 0 && bystander === 0)) {
      throw new Error('A held capture did not distinguish its victim from other opponents.');
    }
    const beforeCapture = winProbabilities(exposedState, 0, newTurn(), exposedState);
    const afterCaptureRoll = winProbabilities(exposedState, 0, heldTwo, exposedState);
    if (afterCaptureRoll[1] / afterCaptureRoll[2] >= beforeCapture[1] / beforeCapture[2]) {
      throw new Error('The rolled capture did not lower its victim relative to a bystander.');
    }
    const turnStart = newGame([0, 2], 'each');
    turnStart.players[0].pawns[0] = 14;
    const advanced = newGame([0, 2], 'each');
    advanced.players[0].pawns[0] = 15;
    const blocked: Turn = { bank: [1], owed: 0 };
    const resolution = resolveTurn(advanced, 0, blocked, turnStart);
    if (!resolution.over || !resolution.rolledBack || resolution.state !== turnStart) {
      throw new Error('An unusable final roll did not undo the whole turn.');
    }
    const provisionalStart = newGame([0, 1, 2, 3], 'home');
    provisionalStart.players[0].pawns = [23, 24, 24, 24];
    provisionalStart.players[0].hasHit = true;
    const provisionalFinish = newGame([0, 1, 2, 3], 'home');
    provisionalFinish.players[0].pawns = [24, 24, 24, 24];
    provisionalFinish.players[0].hasHit = true;
    if (winProbabilities(provisionalFinish, 0, blocked, provisionalStart)[0] === 1) {
      throw new Error('A provisional finish was reported as a certain win before rollback.');
    }
    console.log(`Self-play smoke test passed: ${BOARD_SIZES.map((n) => `${n}x${n}`).join(' and ')} boards, rules, turn sequencing, opponent learning, and roll-aware win probabilities.`);
  } else if (command === 'baseline') {
    if (players !== 4) throw new Error('The original baseline comparison is defined for four players.');
    const modes = [entry];
    for (const mode of modes) {
      const shards = Math.min(workers, games);
      const results = await runParallel(Array.from({ length: shards }, (_, id) => ({
        id,
        model: CHOWKA_MODEL,
        opponent: CHOWKA_MODEL,
        games: Math.floor(games / shards) + (id < games % shards ? 1 : 0),
        players: 4,
        entry: mode,
        size,
        seed: seed + id * 100003 + modes.indexOf(mode) * 10000019,
        budget: budget || 96,
        originalOpponent: true,
      })));
      const totalGames = results.reduce((sum, result) => sum + result.games, 0);
      const scoreSum = results.reduce((sum, result) => sum + result.score * result.games, 0);
      const scoreSquares = results.reduce((sum, result) => sum + result.scoreSquares, 0);
      const score = scoreSum / totalGames;
      const variance = Math.max(0, scoreSquares / totalGames - score * score);
      const scoreMargin = 1.96 * Math.sqrt(variance / totalGames);
      const wins = results.reduce((sum, result) => sum + result.wins, 0);
      const winRate = wins / totalGames;
      const winMargin = 1.96 * Math.sqrt(winRate * (1 - winRate) / totalGames);
      const places = Array.from({ length: 4 }, (_, place) =>
        results.reduce((sum, result) => sum + result.places[place], 0));
      const turns = results.reduce((sum, result) => sum + result.turns, 0);
      console.log(`${mode}, ${size}x${size}: final AI vs three original Hard opponents`);
      console.log(`  placement ${(score * 100).toFixed(1)}% ± ${(scoreMargin * 100).toFixed(1)}%; wins ${wins}/${totalGames} (${(winRate * 100).toFixed(1)}% ± ${(winMargin * 100).toFixed(1)}%)`);
      console.log(`  places ${places.join('/')} (1st/2nd/3rd/4th); ${turns} turns; ${shards} workers`);
    }
  } else if (command === 'tournament') {
    const shards = Math.min(workers, games);
    const initial = withoutTurnState(CHOWKA_MODEL);
    const results = await runParallel(Array.from({ length: shards }, (_, id) => ({
      id,
      model: CHOWKA_MODEL,
      opponent: initial,
      games: Math.floor(games / shards) + (id < games % shards ? 1 : 0),
      players,
      entry,
      size,
      seed: seed + id * 100003,
      budget,
      positionOpponent: true,
    })));
    const totalGames = results.reduce((sum, result) => sum + result.games, 0);
    const score = results.reduce((sum, result) => sum + result.score * result.games, 0) / totalGames;
    const wins = results.reduce((sum, result) => sum + result.wins, 0);
    const turns = results.reduce((sum, result) => sum + result.turns, 0);
    console.log(`Learned evaluator vs initial evaluator: ${(score * 100).toFixed(1)}% placement score, ${wins}/${totalGames} wins.`);
    console.log(`Seed ${seed}; ${size}x${size}; ${players} players; ${entry} entry; ${turns} turns; ${shards} workers.`);
  } else {
    const generations = numberArg('generations', 6);
    const population = Math.max(4, numberArg('population', Math.min(16, workers * 2)));
    let sigma = numberArg('sigma', 18);
    let model: EvaluationModel = { ...CHOWKA_MODEL, weights: [...CHOWKA_MODEL.weights], seed };
    let trainedGames = model.trainedGames;
    const random = seededRandom(seed);

    console.log(`Training ${FEATURE_NAMES.length} weights for the ${size}x${size} board with ${workers} workers (${population} candidates × ${generations} generations).`);
    for (let generation = 0; generation < generations; generation++) {
      const candidates = [model, ...Array.from({ length: population - 1 }, () => randomModel(model, random, sigma))];
      const trials = candidates.map((candidate, id) => ({
        id, model: candidate, opponent: model, games, players, entry, size, seed: seed + generation * 100003, budget,
      }));
      const results = await runParallel(trials);
      trainedGames += population * games;
      const ranked = results.map((result) => ({ result, model: candidates[result.id] }))
        .sort((a, b) => b.result.score - a.result.score);
      const champion = ranked[0];
      const holdout = runTrial({
        id: 0, model: champion.model, opponent: model,
        games: Math.max(96, games * 2), players: 4, entry: 'home', size,
        seed: seed ^ (generation + 1) * 0x5f3759df, budget: 0,
      });
      const accepted = champion.model !== model && holdout.wins / holdout.games > 0.34;
      if (accepted) model = {
        version: 2,
        board: size,
        weights: [...champion.model.weights],
        trainedGames,
        seed,
      };
      sigma *= 0.78;
      const best = champion.result;
      console.log(`Generation ${generation + 1}: best ${best.wins}/${best.games} training wins; holdout ${holdout.wins}/${holdout.games}; ${accepted ? 'accepted' : 'kept incumbent'}; sigma ${sigma.toFixed(2)}.`);
    }

    if (!validateModel(model)) throw new Error('Training produced an invalid model.');
    // A borrowed model stays marked as borrowed until a candidate trained on this board replaces it.
    const destination = resolve(MODEL_FILES[size]);
    await writeFile(destination, `${JSON.stringify(model, null, 2)}\n`);
    console.log(`Saved evaluator with ${model.trainedGames} recorded training games to ${destination}; ${trainedGames - CHOWKA_MODEL.trainedGames} candidate games evaluated this run.`);
    FEATURE_NAMES.forEach((name, index) => console.log(`  ${name.padEnd(18)} ${model.weights[index].toFixed(3)}`));
  }
}
